/**
 * Phase 6 — Unit tests for the recovery_loop orchestration layer.
 *
 * Pins:
 *   - runWithRecovery returns RecoveryResult<T> discriminator;
 *     callers MUST switch on `kind`
 *   - First-attempt success: NO recovery.* events emitted (silent
 *     stream is the dominant case)
 *   - ProviderTransient: 1 retry succeeds; 3 transients exhaust
 *     (budget = 2 retries) -> recovery.exhausted then
 *     recovery.escalated
 *   - ProviderUnavailable: escalates IMMEDIATELY (budget = 0); no
 *     retry; no attempt_started
 *   - LintFailed / TestFailed / CompletionGateBlocked: escalate
 *     immediately; no retry
 *   - BuildFailed: 1 retry with retry_with_guardrail_prompt action
 *     and the BUILD_GUARDRAIL_PROMPT in attemptCtx; 2 in a row
 *     escalate
 *   - StaleBranch: runs git fetch -> git rebase origin/main; on
 *     conflict aborts AND escalates without retrying op; on fetch
 *     failure escalates without rebasing
 *   - cap-blocked retry: emits cost.cap_crossed BEFORE
 *     recovery.escalated; escalation reason mentions cap
 *   - per-packet budget: shared across calls in a packet; mixed
 *     scenarios are tracked independently
 *   - unclassified failure: escalates immediately with honest
 *     "we don't know" reason
 *   - disableRecovery: runs op once, no events, surfaces escalation
 *     discriminator on failure
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AttemptContext,
  GitRunResult,
  OperationResult,
  failureFromSubprocess,
  newPacketRecoveryBudget,
  runWithRecovery,
  type GitRunner,
  type RunWithRecoveryContext,
  type RunWithRecoveryOptions,
} from '../pipeline/recovery_loop.js';
import { BUILD_GUARDRAIL_PROMPT } from '../pipeline/recovery.js';
import { eventsPathFor } from '../events.js';
import type { Event } from '../pipeline/events.js';

let tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  tempDirs = [];
});

function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'recovery-loop-'));
  tempDirs.push(d);
  return d;
}

function defaultCtx(overrides: Partial<RunWithRecoveryContext> = {}): RunWithRecoveryContext {
  return {
    runId: overrides.runId ?? 'run-001',
    artifactRoot: overrides.artifactRoot ?? mkTmp(),
    dryRun: overrides.dryRun ?? false,
    specId: overrides.specId ?? 'spec-x',
    packetId: overrides.packetId ?? 'pkt-x',
    operationLabel: overrides.operationLabel ?? 'test.op',
    budget: overrides.budget ?? newPacketRecoveryBudget(),
  };
}

const noWait: RunWithRecoveryOptions = { waitFn: () => undefined };

function ok<T>(value: T): OperationResult<T> {
  return { outcome: 'ok', value };
}

function fail(
  exit: number,
  stderr: string,
  stdout = '',
  kind: 'agent_invocation' | 'verification' | 'git' | 'lifecycle' = 'agent_invocation',
  failedChecks?: ReadonlyArray<'build' | 'lint' | 'tests' | 'ci'>,
): OperationResult<never> {
  return {
    outcome: 'fail',
    failure: failureFromSubprocess({
      exitCode: exit,
      stdout,
      stderr,
      kind,
      ...(failedChecks !== undefined ? { failedChecks } : {}),
    }),
  };
}

function queuedOp<T>(
  results: ReadonlyArray<OperationResult<T>>,
  calls: AttemptContext[] = [],
) {
  let i = 0;
  return (attempt: AttemptContext): OperationResult<T> => {
    calls.push(attempt);
    const r = results[i] ?? results[results.length - 1]!;
    i += 1;
    return r;
  };
}

function readEventStream(artifactRoot: string, runId: string): Event[] {
  const { file } = eventsPathFor(artifactRoot, runId);
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, 'utf-8').split('\n').filter((s) => s.length > 0);
  return raw.map((s) => JSON.parse(s) as Event);
}

// ---------------------------------------------------------------------------
// First-attempt success — no recovery events
// ---------------------------------------------------------------------------

describe('runWithRecovery — first-attempt success', () => {
  it('returns kind: ok with value; emits NO recovery events', () => {
    const ctx = defaultCtx();
    const r = runWithRecovery(() => ok(42), ctx, noWait);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value).toBe(42);

    const events = readEventStream(ctx.artifactRoot, ctx.runId);
    const recoveryEvents = events.filter((e) => e.event_type.startsWith('recovery.'));
    expect(recoveryEvents.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ProviderTransient
// ---------------------------------------------------------------------------

describe('runWithRecovery — ProviderTransient', () => {
  it('1 retry succeeds; emits attempt_started(2) -> succeeded(2)', () => {
    const ctx = defaultCtx();
    const r = runWithRecovery(
      queuedOp<string>([
        fail(1, 'HTTP 503 Service Unavailable'),
        ok('done'),
      ]),
      ctx,
      noWait,
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value).toBe('done');

    const events = readEventStream(ctx.artifactRoot, ctx.runId).map((e) => e.event_type);
    expect(events).toEqual(['recovery.attempt_started', 'recovery.succeeded']);
  });

  it('3 transients exhaust the budget (2 retries) -> exhausted -> escalated', () => {
    const ctx = defaultCtx();
    const r = runWithRecovery(
      queuedOp<string>([
        fail(1, 'HTTP 503'),
        fail(1, 'HTTP 503'),
        fail(1, 'HTTP 503'),
      ]),
      ctx,
      noWait,
    );
    expect(r.kind).toBe('escalated');
    if (r.kind === 'escalated') {
      expect(r.scenario).toBe('ProviderTransient');
      expect(r.reason).toMatch(/Retry budget exhausted/);
      expect(r.attempts).toBe(3);
    }

    const events = readEventStream(ctx.artifactRoot, ctx.runId).map((e) => e.event_type);
    expect(events).toContain('recovery.exhausted');
    expect(events.indexOf('recovery.exhausted')).toBeLessThan(events.indexOf('recovery.escalated'));
  });
});

// ---------------------------------------------------------------------------
// ProviderUnavailable — Phase 6 contract: escalate IMMEDIATELY
// ---------------------------------------------------------------------------

describe('runWithRecovery — ProviderUnavailable (Phase 7 cascade)', () => {
  it('with no cascade context: escalates immediately with "no cascade configured" reason', () => {
    // Phase 7 — when the FailureContext supplied by the closure
    // carries no `cascade` field, the recipe escalates with an
    // explicit no-cascade reason. The orchestration loop emits
    // recovery.escalated; no attempt_started.
    const ctx = defaultCtx();
    const calls: AttemptContext[] = [];
    const r = runWithRecovery(
      queuedOp<string>([
        fail(1, "Provider 'codex' is disabled"),
      ], calls),
      ctx,
      noWait,
    );
    expect(r.kind).toBe('escalated');
    if (r.kind === 'escalated') {
      expect(r.scenario).toBe('ProviderUnavailable');
      expect(r.reason).toMatch(/no cascade/i);
      expect(r.attempts).toBe(1);
    }
    expect(calls.length).toBe(1);
    const events = readEventStream(ctx.artifactRoot, ctx.runId).map((e) => e.event_type);
    expect(events).toContain('recovery.escalated');
    expect(events).not.toContain('recovery.attempt_started');
  });

  it('with a cascade: dispatches cascade_provider until the cascade succeeds', () => {
    // Cascade has 3 hops. Primary fails ProviderUnavailable; second
    // hop fails ProviderUnavailable; third hop succeeds. Each retry
    // emits attempt_started; the final retry emits succeeded.
    const ctx = defaultCtx();
    const cascade = [
      { provider: 'codex' as const, model: 'A' },
      { provider: 'claude' as const, model: 'B' },
      { provider: 'copilot' as const, model: 'C' },
    ];
    const calls: AttemptContext[] = [];
    const op = (attempt: AttemptContext): OperationResult<string> => {
      calls.push(attempt);
      if (attempt.attemptNumber <= 2) {
        return {
          outcome: 'fail',
          failure: failureFromSubprocess({
            exitCode: 1,
            stdout: '',
            stderr: "Provider 'X' is disabled",
            kind: 'agent_invocation',
          }) as unknown as ReturnType<typeof failureFromSubprocess>,
        };
      }
      return ok('cascade-success');
    };
    // Closure-style wrapper to inject `cascade` into every failure
    // context. (Production closures do this via failureFromSubprocess
    // helpers in the phase modules.)
    const opWithCascade = (attempt: AttemptContext): OperationResult<string> => {
      const r = op(attempt);
      if (r.outcome === 'fail') {
        return { outcome: 'fail', failure: { ...r.failure, cascade } };
      }
      return r;
    };
    const r = runWithRecovery(opWithCascade, ctx, noWait);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value).toBe('cascade-success');
    expect(calls.length).toBe(3);
    expect(calls[0]?.action).toBeUndefined();
    expect(calls[1]?.action).toBe('cascade_provider');
    expect(calls[1]?.cascade).toEqual({ provider: 'claude', model: 'B' });
    expect(calls[2]?.action).toBe('cascade_provider');
    expect(calls[2]?.cascade).toEqual({ provider: 'copilot', model: 'C' });

    const types = readEventStream(ctx.artifactRoot, ctx.runId).map((e) => e.event_type);
    expect(types).toContain('recovery.attempt_started');
    expect(types).toContain('recovery.succeeded');
  });

  it('with a cascade exhausted: escalates naming the full attempted list', () => {
    const ctx = defaultCtx();
    const cascade = [
      { provider: 'codex' as const, model: 'A' },
      { provider: 'claude' as const, model: 'B' },
    ];
    const opWithCascade = (_attempt: AttemptContext): OperationResult<string> => ({
      outcome: 'fail',
      failure: {
        ...failureFromSubprocess({
          exitCode: 1,
          stdout: '',
          stderr: "Provider 'X' is disabled",
          kind: 'agent_invocation',
        }),
        cascade,
      },
    });
    const r = runWithRecovery(opWithCascade, ctx, noWait);
    expect(r.kind).toBe('escalated');
    if (r.kind === 'escalated') {
      expect(r.scenario).toBe('ProviderUnavailable');
      expect(r.reason).toMatch(/cascade exhausted/i);
      expect(r.reason).toContain('codex:A');
      expect(r.reason).toContain('claude:B');
    }
  });
});

// ---------------------------------------------------------------------------
// Always-escalate: LintFailed / TestFailed / CompletionGateBlocked
// ---------------------------------------------------------------------------

describe('runWithRecovery — always-escalate scenarios', () => {
  it('LintFailed escalates immediately, no retry', () => {
    const ctx = defaultCtx();
    const calls: AttemptContext[] = [];
    const r = runWithRecovery(
      queuedOp<string>([
        fail(1, '', '', 'verification', ['lint']),
      ], calls),
      ctx,
      noWait,
    );
    expect(r.kind).toBe('escalated');
    if (r.kind === 'escalated') {
      expect(r.scenario).toBe('LintFailed');
      expect(r.attempts).toBe(1);
    }
    expect(calls.length).toBe(1);
    const events = readEventStream(ctx.artifactRoot, ctx.runId).map((e) => e.event_type);
    expect(events).not.toContain('recovery.attempt_started');
    expect(events).toContain('recovery.escalated');
  });

  it('TestFailed escalates immediately, no retry', () => {
    const ctx = defaultCtx();
    const calls: AttemptContext[] = [];
    const r = runWithRecovery(
      queuedOp<string>([
        fail(1, '', '', 'verification', ['tests']),
      ], calls),
      ctx,
      noWait,
    );
    expect(r.kind).toBe('escalated');
    if (r.kind === 'escalated') expect(r.scenario).toBe('TestFailed');
    expect(calls.length).toBe(1);
  });

  it('CompletionGateBlocked escalates immediately, no retry', () => {
    const ctx = defaultCtx();
    const calls: AttemptContext[] = [];
    const r = runWithRecovery(
      queuedOp<string>([
        fail(1, 'pre-commit hook failed (FI-7 enforcement)', '', 'lifecycle'),
      ], calls),
      ctx,
      noWait,
    );
    expect(r.kind).toBe('escalated');
    if (r.kind === 'escalated') expect(r.scenario).toBe('CompletionGateBlocked');
    expect(calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// BuildFailed
// ---------------------------------------------------------------------------

describe('runWithRecovery — BuildFailed', () => {
  it('1 retry with the guardrail prompt suffix', () => {
    const ctx = defaultCtx();
    const calls: AttemptContext[] = [];
    const r = runWithRecovery(
      queuedOp<string>([
        fail(1, 'error TS2304', '', 'verification', ['build']),
        ok('built'),
      ], calls),
      ctx,
      noWait,
    );
    expect(r.kind).toBe('ok');
    expect(calls.length).toBe(2);
    expect(calls[0]!.attemptNumber).toBe(1);
    expect(calls[0]!.action).toBeUndefined();
    expect(calls[1]!.attemptNumber).toBe(2);
    expect(calls[1]!.action).toBe('retry_with_guardrail_prompt');
    expect(calls[1]!.guardrailPrompt).toContain(BUILD_GUARDRAIL_PROMPT);
    expect(calls[1]!.guardrailPrompt).toContain('error TS2304');
  });

  it('2 BuildFailed in a row exhaust the budget (1 retry)', () => {
    const ctx = defaultCtx();
    const r = runWithRecovery(
      queuedOp<string>([
        fail(1, 'error TS2304', '', 'verification', ['build']),
        fail(1, 'error TS2304', '', 'verification', ['build']),
      ]),
      ctx,
      noWait,
    );
    expect(r.kind).toBe('escalated');
    if (r.kind === 'escalated') expect(r.scenario).toBe('BuildFailed');
  });
});

// ---------------------------------------------------------------------------
// StaleBranch — git_rebase_then_retry executes BEFORE retry
// ---------------------------------------------------------------------------

describe('runWithRecovery — StaleBranch', () => {
  it('successful rebase: runs git fetch origin -> git rebase origin/main -> retries op', () => {
    const ctx = defaultCtx();
    const opCalls: AttemptContext[] = [];
    const op = queuedOp<string>([
      fail(1, "Your branch is behind 'origin/main'", '', 'git'),
      ok('rebased'),
    ], opCalls);
    const gitCalls: string[][] = [];
    const gitRunner: GitRunner = (args) => {
      gitCalls.push([...args]);
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const r = runWithRecovery(op, ctx, { ...noWait, gitRunner });
    expect(r.kind).toBe('ok');
    expect(gitCalls).toEqual([
      ['fetch', 'origin'],
      ['rebase', 'origin/main'],
    ]);
    expect(opCalls.length).toBe(2);
    expect(opCalls[1]!.action).toBe('git_rebase_then_retry');
  });

  it('rebase conflict: runs rebase --abort and escalates WITHOUT retrying op', () => {
    const ctx = defaultCtx();
    const opCalls: AttemptContext[] = [];
    const op = queuedOp<string>([
      fail(1, "Your branch is behind 'origin/main'", '', 'git'),
    ], opCalls);
    const gitCalls: string[][] = [];
    const gitRunner: GitRunner = (args) => {
      gitCalls.push([...args]);
      if (args[0] === 'fetch') return { exitCode: 0, stdout: '', stderr: '' };
      if (args[0] === 'rebase' && args[1] === 'origin/main') {
        return { exitCode: 1, stdout: '', stderr: 'CONFLICT (content): Merge conflict in src/foo.ts' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const r = runWithRecovery(op, ctx, { ...noWait, gitRunner });
    expect(r.kind).toBe('escalated');
    if (r.kind === 'escalated') {
      expect(r.scenario).toBe('StaleBranch');
      expect(r.reason).toMatch(/git rebase conflict/i);
      expect(r.reason).toMatch(/CONFLICT/);
    }
    expect(gitCalls).toEqual([
      ['fetch', 'origin'],
      ['rebase', 'origin/main'],
      ['rebase', '--abort'],
    ]);
    expect(opCalls.length).toBe(1); // op NOT retried
  });

  it('git fetch failure: escalates WITHOUT running rebase or retrying op', () => {
    const ctx = defaultCtx();
    const opCalls: AttemptContext[] = [];
    const op = queuedOp<string>([
      fail(1, "Your branch is behind 'origin/main'", '', 'git'),
    ], opCalls);
    const gitCalls: string[][] = [];
    const gitRunner: GitRunner = (args) => {
      gitCalls.push([...args]);
      return { exitCode: 128, stdout: '', stderr: 'fatal: unable to access origin' };
    };

    const r = runWithRecovery(op, ctx, { ...noWait, gitRunner });
    expect(r.kind).toBe('escalated');
    if (r.kind === 'escalated') {
      expect(r.scenario).toBe('StaleBranch');
      expect(r.reason).toMatch(/git fetch failed/i);
    }
    expect(gitCalls).toEqual([['fetch', 'origin']]);
    expect(opCalls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cap-blocked retry: cost.cap_crossed BEFORE recovery.escalated
// ---------------------------------------------------------------------------

describe('runWithRecovery — cap-blocked retry', () => {
  it('per-run cap crossed before retry: emits cost.cap_crossed BEFORE recovery.escalated', () => {
    const ctx = defaultCtx();
    // Pre-seed a cost record so aggregateRunCost returns total >= cap.
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const costDir = path.join(ctx.artifactRoot, 'cost');
    fs.mkdirSync(costDir, { recursive: true });
    fs.writeFileSync(
      path.join(costDir, `${ctx.runId}.jsonl`),
      JSON.stringify({
        run_id: ctx.runId,
        packet_id: null,
        spec_id: null,
        provider: 'claude',
        model: 'claude-opus-4-7',
        tokens_in: 1_000_000,
        tokens_out: 100_000,
        dollars: 100,
        timestamp: '2026-05-01T10:00:00.000Z',
      }) + '\n',
    );

    const r = runWithRecovery(
      queuedOp<string>([
        fail(1, 'HTTP 503'),
      ]),
      ctx,
      { ...noWait, perRunCap: 50 },
    );
    expect(r.kind).toBe('escalated');
    if (r.kind === 'escalated') {
      expect(r.scenario).toBe('ProviderTransient');
      expect(r.reason).toMatch(/per-run cost cap/i);
    }

    const events = readEventStream(ctx.artifactRoot, ctx.runId).map((e) => e.event_type);
    expect(events).toContain('cost.cap_crossed');
    expect(events).toContain('recovery.escalated');
    expect(events.indexOf('cost.cap_crossed')).toBeLessThan(events.indexOf('recovery.escalated'));
  });
});

// ---------------------------------------------------------------------------
// Per-packet budget enforcement
// ---------------------------------------------------------------------------

describe('runWithRecovery — per-packet budget across calls', () => {
  it('shared budget: 2 ProviderTransient retries used; 3rd transient call escalates', () => {
    const ctx = defaultCtx();
    // First call: 1 transient -> 1 retry succeeds (1 retry used)
    const r1 = runWithRecovery(
      queuedOp<string>([fail(1, 'HTTP 503'), ok('a')]),
      ctx,
      noWait,
    );
    expect(r1.kind).toBe('ok');

    // Second call: 1 transient -> 1 retry succeeds (2 retries total)
    const r2 = runWithRecovery(
      queuedOp<string>([fail(1, 'HTTP 503'), ok('b')]),
      ctx,
      noWait,
    );
    expect(r2.kind).toBe('ok');

    // Third call: 1 transient -> budget=0 left -> escalate
    const r3 = runWithRecovery(
      queuedOp<string>([fail(1, 'HTTP 503')]),
      ctx,
      noWait,
    );
    expect(r3.kind).toBe('escalated');
    if (r3.kind === 'escalated') expect(r3.scenario).toBe('ProviderTransient');
  });

  it('mixed scenarios tracked independently: 1 BuildFailed retry + 2 transient retries all succeed', () => {
    const ctx = defaultCtx();
    // 1 transient retry
    const r1 = runWithRecovery(
      queuedOp<string>([fail(1, 'HTTP 503'), ok('t')]),
      ctx,
      noWait,
    );
    expect(r1.kind).toBe('ok');
    // 1 BuildFailed retry
    const r2 = runWithRecovery(
      queuedOp<string>([fail(1, 'error TS2304', '', 'verification', ['build']), ok('b')]),
      ctx,
      noWait,
    );
    expect(r2.kind).toBe('ok');
    // 1 more transient retry — still allowed because budget=2 and only 1 used
    const r3 = runWithRecovery(
      queuedOp<string>([fail(1, 'HTTP 503'), ok('t2')]),
      ctx,
      noWait,
    );
    expect(r3.kind).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Unclassified failure
// ---------------------------------------------------------------------------

describe('runWithRecovery — unclassified failure', () => {
  it('escalates immediately with honest "we do not know" reason', () => {
    const ctx = defaultCtx();
    const r = runWithRecovery(
      queuedOp<string>([
        // Empty kind hint, no recognizable text.
        { outcome: 'fail', failure: { exit_code: 1, stdout: '', stderr: 'mystery banner', error_message: null } },
      ]),
      ctx,
      noWait,
    );
    expect(r.kind).toBe('escalated');
    if (r.kind === 'escalated') {
      expect(r.scenario).toBe('Unclassified');
      expect(r.reason).toMatch(/Unclassified/);
    }
  });
});

// ---------------------------------------------------------------------------
// disableRecovery escape hatch
// ---------------------------------------------------------------------------

describe('runWithRecovery — disableRecovery', () => {
  it('runs op once on success; no events', () => {
    const ctx = defaultCtx();
    const r = runWithRecovery(() => ok(99), ctx, { disableRecovery: true });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value).toBe(99);
    const events = readEventStream(ctx.artifactRoot, ctx.runId);
    expect(events.length).toBe(0);
  });

  it('on failure: surfaces escalation discriminator; no events; no escalation file written', () => {
    const ctx = defaultCtx();
    const r = runWithRecovery(
      () => fail(1, 'HTTP 503'),
      ctx,
      { disableRecovery: true },
    );
    expect(r.kind).toBe('escalated');
    if (r.kind === 'escalated') {
      expect(r.scenario).toBe('Unclassified');
      expect(r.escalation_path).toBeNull();
    }
    const events = readEventStream(ctx.artifactRoot, ctx.runId);
    expect(events.length).toBe(0);
    // No escalation dir created.
    expect(existsSync(join(ctx.artifactRoot, 'escalations'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Escalation record on disk
// ---------------------------------------------------------------------------

describe('runWithRecovery — escalation record', () => {
  it('writes one escalation file with the structured record', () => {
    const ctx = defaultCtx();
    const r = runWithRecovery(
      queuedOp<string>([fail(1, '', '', 'verification', ['lint'])]),
      ctx,
      noWait,
    );
    expect(r.kind).toBe('escalated');
    if (r.kind === 'escalated') {
      expect(r.escalation_path).not.toBeNull();
      expect(existsSync(r.escalation_path!)).toBe(true);
      const raw = readFileSync(r.escalation_path!, 'utf-8');
      const rec = JSON.parse(raw) as { scenario: string; spec_id: string | null; reason: string };
      expect(rec.scenario).toBe('LintFailed');
      expect(rec.spec_id).toBe('spec-x');
    }
  });

  it('the escalation dir gets exactly one file per escalation', () => {
    const ctx = defaultCtx();
    runWithRecovery(
      queuedOp<string>([fail(1, '', '', 'verification', ['lint'])]),
      ctx,
      noWait,
    );
    const dir = join(ctx.artifactRoot, 'escalations');
    expect(readdirSync(dir).length).toBe(1);
  });
});
