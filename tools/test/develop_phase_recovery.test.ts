/**
 * Phase 6 — Integration tests for develop_phase recovery integration.
 *
 * These tests are the load-bearing complement to the unit tests in
 * `recovery.test.ts` and `recovery_loop.test.ts`. The unit tests pin
 * the orchestration layer's contract IN ISOLATION; these tests pin
 * what happens when the orchestration's `RecoveryResult<T>` discriminator
 * meets the per-packet state machine in develop_phase.
 *
 * The previous Phase 6 attempt was reverted because the recovery layer
 * was correct in isolation but the calling state machine ignored
 * escalations. Round 3 codex flagged this as observable-but-not-
 * controlling. These tests exist to catch that exact failure mode.
 *
 * Post-escalation invariants pinned here:
 *   1. The packet was marked `failed` in `packets/<id>.json` — the
 *      controlling contract, not just the observable contract.
 *   2. NO `packet.completed` event was emitted for the escalated
 *      packet — the state machine stopped, NOT just logged.
 *   3. `runDevelopPhase` returned the escalated packet in the `failed`
 *      list, NOT the `completed` list — the post-escalation invariant.
 *   4. Subsequent independent packets continued to run.
 *   5. A `packet.failed` event WAS emitted with the recovery reason.
 *   6. A `recovery.escalated` event WAS emitted.
 *
 * Plus integration tests for the auto-recovery success paths:
 *   - ProviderTransient retry succeeds; packet completed
 *   - BuildFailed retry-with-guardrail-prompt succeeds; packet completed
 *   - StaleBranch rebase-then-retry succeeds; packet completed
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Mocks. invokeAgent + completePacket + requestReview must all be
// stubbable so we can drive every recovery scenario through the state
// machine without spawning real CLIs.
// ---------------------------------------------------------------------------

interface InvokeOutcome {
  readonly exit_code: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

const __invokeQueue: InvokeOutcome[] = [];
const __invokeCalls: Array<{ provider: string; prompt: string }> = [];

vi.mock('../pipeline/agent_invoke.js', () => ({
  resolveModelId: () => undefined,
  buildProviderArgs: () => ({ command: 'noop', args: [] }),
  invokeAgent: (provider: string, prompt: string) => {
    __invokeCalls.push({ provider, prompt });
    const next = __invokeQueue.shift();
    const outcome = next ?? { exit_code: 0 };
    return {
      exit_code: outcome.exit_code,
      stdout: outcome.stdout ?? '',
      stderr: outcome.stderr ?? '',
      cost: {
        provider,
        model: 'mock-model',
        tokens_in: 100,
        tokens_out: 50,
        dollars: 0.01,
      },
    };
  },
}));

interface CompleteOutcome {
  readonly already_complete?: boolean;
  readonly ci_pass: boolean;
  readonly build_pass: boolean;
  readonly lint_pass: boolean;
  readonly tests_pass: boolean;
}

type CompleteEntry = CompleteOutcome | (() => CompleteOutcome);

const __completeQueue: CompleteEntry[] = [];
const __completeCalls: Array<Record<string, unknown>> = [];

vi.mock('../lifecycle/complete.js', () => ({
  completePacket: (opts: Record<string, unknown>) => {
    __completeCalls.push(opts);
    const next = __completeQueue.shift();
    if (next === undefined) {
      // Default: success.
      return {
        packet_id: opts['packetId'] as string,
        ci_pass: true,
        build_pass: true,
        lint_pass: true,
        tests_pass: true,
        files_changed: [],
        already_complete: false,
      };
    }
    if (typeof next === 'function') return next();
    return next;
  },
}));

type RequestReviewEntry = (() => unknown) | undefined;
const __requestReviewQueue: RequestReviewEntry[] = [];
const __requestReviewCalls: Array<Record<string, unknown>> = [];

vi.mock('../lifecycle/request_review.js', () => ({
  requestReview: (opts: Record<string, unknown>) => {
    __requestReviewCalls.push(opts);
    const next = __requestReviewQueue.shift();
    if (next === undefined) {
      return {
        kind: 'recorded',
        packet_id: opts['packetId'],
        branch: 'fake',
        review_iteration: 1,
        was_changes_requested: false,
        already_requested: false,
      };
    }
    return next();
  },
  RequestReviewError: class RequestReviewError extends Error {
    readonly details: ReadonlyArray<string>;
    constructor(summary: string, details: ReadonlyArray<string> = []) {
      super(summary);
      this.name = 'RequestReviewError';
      this.details = details;
    }
  },
}));

vi.mock('../lifecycle/start.js', () => ({
  startPacket: () => undefined,
}));
vi.mock('../lifecycle/review.js', () => ({
  recordReview: () => undefined,
}));

import { runDevelopPhase } from '../pipeline/develop_phase.js';
import type { FactoryConfig } from '../config.js';
import type { Feature } from '../execute.js';
import type { GitRunner } from '../pipeline/recovery_loop.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  __invokeCalls.length = 0;
  __invokeQueue.length = 0;
  __completeQueue.length = 0;
  __completeCalls.length = 0;
  __requestReviewQueue.length = 0;
  __requestReviewCalls.length = 0;
});

beforeEach(() => {
  __invokeCalls.length = 0;
  __invokeQueue.length = 0;
  __completeQueue.length = 0;
  __completeCalls.length = 0;
  __requestReviewQueue.length = 0;
  __requestReviewCalls.length = 0;
});

function mkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'develop-recovery-'));
  if (!existsSync(join(root, 'packets'))) mkdirSync(join(root, 'packets'), { recursive: true });
  if (!existsSync(join(root, 'completions'))) mkdirSync(join(root, 'completions'), { recursive: true });
  if (!existsSync(join(root, 'features'))) mkdirSync(join(root, 'features'), { recursive: true });
  if (!existsSync(join(root, 'events'))) mkdirSync(join(root, 'events'), { recursive: true });
  dirs.push(root);
  return root;
}

function makeConfig(): FactoryConfig {
  return ({
    project_name: 'recovery-it',
    factory_dir: '.',
    artifact_dir: '.',
    verification: { build: 'true', lint: 'true', test: 'true' },
    validation: { command: 'true' },
    infrastructure_patterns: [],
    completed_by_default: { kind: 'agent', id: 'test' },
    personas: {
      planner: { description: '', instructions: [] },
      developer: { description: '', instructions: [] },
      code_reviewer: { description: '', instructions: [] },
      qa: { description: '', instructions: [] },
    },
    pipeline: {
      providers: {
        codex: { enabled: true, command: 'codex' },
        claude: { enabled: true, command: 'claude' },
      },
      persona_providers: {
        planner: 'claude',
        developer: 'codex',
        code_reviewer: 'claude',
        qa: 'claude',
      },
      completion_identities: {
        developer: 'codex-dev',
        code_reviewer: 'claude-cr',
        qa: 'claude-qa',
      },
      max_review_iterations: 3,
    },
  } as unknown) as FactoryConfig;
}

function writePacket(root: string, id: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(root, 'packets', `${id}.json`),
    JSON.stringify({
      id,
      kind: 'dev',
      title: `Packet ${id}`,
      status: 'ready',
      ...extra,
    }, null, 2),
    'utf-8',
  );
}

function writeFeature(root: string, id: string, packets: string[]): Feature {
  return {
    id,
    intent: 'recovery-it',
    status: 'executing',
    packets,
    created_by: { kind: 'agent', id: 'test' },
  } as Feature;
}

function readEvents(runId: string, root: string): Array<{ event_type: string; payload: Record<string, unknown> }> {
  const out: Array<{ event_type: string; payload: Record<string, unknown> }> = [];
  const dir = join(root, 'events');
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    for (const line of readFileSync(join(dir, f), 'utf-8').split('\n')) {
      if (line.length === 0) continue;
      try {
        const e = JSON.parse(line) as { event_type: string; run_id: string; payload: Record<string, unknown> };
        if (e.run_id === runId) out.push({ event_type: e.event_type, payload: e.payload });
      } catch { /* skip */ }
    }
  }
  return out;
}

function readPacket(root: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, 'packets', `${id}.json`), 'utf-8')) as Record<string, unknown>;
}

const noopGit: GitRunner = () => ({ exitCode: 0, stdout: '', stderr: '' });

// ---------------------------------------------------------------------------
// ESCALATION-PATH INTEGRATION TESTS
//
// Each test drives a packet through runDevelopPhase with a fixture
// that produces a failure the recovery layer escalates on, then
// asserts the post-escalation invariants.
// ---------------------------------------------------------------------------

describe('runDevelopPhase — TestFailed escalates: post-escalation invariants', () => {
  it('returns the packet in failed list, NOT completed; marks packet failed; emits packet.failed; emits no packet.completed', () => {
    const root = mkRoot();
    writePacket(root, 'pkt-test', { status: 'review_approved', started_at: '2024-01-01T00:00:00Z' });
    // completePacket returns ci_pass=false with tests_pass=false ->
    // classifier dispatches TestFailed -> recipe escalates immediately.
    __completeQueue.push({
      ci_pass: false,
      build_pass: true,
      lint_pass: true,
      tests_pass: false,
    });
    const feature = writeFeature(root, 'feat-x', ['pkt-test']);
    const result = runDevelopPhase({
      feature,
      config: makeConfig(),
      artifactRoot: root,
      projectRoot: root,
      dryRun: false,
      runId: 'run-test-failed',
      specId: 'spec-x',
      gitRunner: noopGit,
    });

    // (1) Post-escalation invariant: in failed list, NOT completed.
    expect(result.failed).toEqual(['pkt-test']);
    expect(result.completed).toEqual([]);

    // (2) Controlling contract: packet status is 'failed'.
    const packet = readPacket(root, 'pkt-test');
    expect(packet['status']).toBe('failed');
    expect(packet['failure']).toBeDefined();
    const failure = packet['failure'] as Record<string, unknown>;
    expect(failure['scenario']).toBe('TestFailed');

    // (3) Observable contract: recovery.escalated AND packet.failed
    // events fired; NO packet.completed for this packet.
    const events = readEvents('run-test-failed', root);
    const types = events.map((e) => e.event_type);
    expect(types).toContain('recovery.escalated');
    expect(types).toContain('packet.failed');
    // No packet.completed for the escalated packet.
    const completedEvents = events.filter(
      (e) => e.event_type === 'packet.completed' && e.payload['packet_id'] === 'pkt-test',
    );
    expect(completedEvents.length).toBe(0);
  });
});

describe('runDevelopPhase — LintFailed escalates immediately, no retry', () => {
  it('packet marked failed; recovery scenario is LintFailed; no recovery.attempt_started', () => {
    const root = mkRoot();
    writePacket(root, 'pkt-lint', { status: 'review_approved', started_at: '2024-01-01T00:00:00Z' });
    __completeQueue.push({
      ci_pass: false,
      build_pass: true,
      lint_pass: false,
      tests_pass: true,
    });
    const result = runDevelopPhase({
      feature: writeFeature(root, 'feat-x', ['pkt-lint']),
      config: makeConfig(),
      artifactRoot: root,
      projectRoot: root,
      dryRun: false,
      runId: 'run-lint',
      specId: 'spec-x',
      gitRunner: noopGit,
    });
    expect(result.failed).toEqual(['pkt-lint']);

    const packet = readPacket(root, 'pkt-lint');
    expect(packet['status']).toBe('failed');
    expect((packet['failure'] as Record<string, unknown>)['scenario']).toBe('LintFailed');

    const events = readEvents('run-lint', root);
    const types = events.map((e) => e.event_type);
    // No retry: no recovery.attempt_started, no recovery.exhausted.
    expect(types).not.toContain('recovery.attempt_started');
    expect(types).not.toContain('recovery.exhausted');
    expect(types).toContain('recovery.escalated');
  });
});

describe('runDevelopPhase — CompletionGateBlocked escalates immediately', () => {
  it('completePacket throws FI-7 -> CompletionGateBlocked -> packet failed', () => {
    const root = mkRoot();
    writePacket(root, 'pkt-fi7', { status: 'review_approved', started_at: '2024-01-01T00:00:00Z' });
    __completeQueue.push(() => {
      throw new Error('pre-commit hook failed (FI-7 enforcement)');
    });
    const result = runDevelopPhase({
      feature: writeFeature(root, 'feat-x', ['pkt-fi7']),
      config: makeConfig(),
      artifactRoot: root,
      projectRoot: root,
      dryRun: false,
      runId: 'run-fi7',
      specId: 'spec-x',
      gitRunner: noopGit,
    });
    expect(result.failed).toEqual(['pkt-fi7']);

    const packet = readPacket(root, 'pkt-fi7');
    expect((packet['failure'] as Record<string, unknown>)['scenario']).toBe('CompletionGateBlocked');

    const events = readEvents('run-fi7', root).map((e) => e.event_type);
    expect(events).not.toContain('recovery.attempt_started');
    expect(events).toContain('recovery.escalated');
  });
});

describe('runDevelopPhase — ProviderUnavailable escalates immediately', () => {
  it('agent stderr says provider disabled -> ProviderUnavailable -> packet failed', () => {
    const root = mkRoot();
    writePacket(root, 'pkt-pu');
    __invokeQueue.push({
      exit_code: 1,
      stderr: "Provider 'codex' is disabled",
    });
    const result = runDevelopPhase({
      feature: writeFeature(root, 'feat-x', ['pkt-pu']),
      config: makeConfig(),
      artifactRoot: root,
      projectRoot: root,
      dryRun: false,
      runId: 'run-pu',
      specId: 'spec-x',
      gitRunner: noopGit,
    });
    expect(result.failed).toEqual(['pkt-pu']);

    const packet = readPacket(root, 'pkt-pu');
    expect((packet['failure'] as Record<string, unknown>)['scenario']).toBe('ProviderUnavailable');

    const events = readEvents('run-pu', root).map((e) => e.event_type);
    expect(events).not.toContain('recovery.attempt_started');
    expect(events).toContain('recovery.escalated');
  });
});

describe('runDevelopPhase — StaleBranch rebase conflict escalates', () => {
  it('completePacket throws stale-branch -> rebase conflict -> packet failed; subsequent independent packet still runs', () => {
    const root = mkRoot();
    // Note: readdirSync returns alphabetical order. We use names so
    // the stale-branch packet runs FIRST in the alphabetical order.
    writePacket(root, 'pkt-a-stale', { status: 'review_approved', started_at: '2024-01-01T00:00:00Z' });
    writePacket(root, 'pkt-b-ok', { status: 'review_approved', started_at: '2024-01-01T00:00:00Z' });
    // First packet's completePacket throws stale-branch.
    __completeQueue.push(() => {
      throw new Error("Branch is behind 'origin/main' by 3 commits; non-fast-forward state.");
    });
    // Second packet's completePacket succeeds.
    __completeQueue.push({
      ci_pass: true,
      build_pass: true,
      lint_pass: true,
      tests_pass: true,
    });
    // Git runner: fetch ok, rebase conflicts.
    const gitRunner: GitRunner = (args) => {
      if (args[0] === 'fetch') return { exitCode: 0, stdout: '', stderr: '' };
      if (args[0] === 'rebase' && args[1] === 'origin/main') {
        return { exitCode: 1, stdout: '', stderr: 'CONFLICT (content): Merge conflict in src/foo.ts' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const result = runDevelopPhase({
      feature: writeFeature(root, 'feat-x', ['pkt-a-stale', 'pkt-b-ok']),
      config: makeConfig(),
      artifactRoot: root,
      projectRoot: root,
      dryRun: false,
      runId: 'run-stale',
      specId: 'spec-x',
      gitRunner,
    });
    // Subsequent independent packet still ran.
    expect(result.failed).toEqual(['pkt-a-stale']);
    expect(result.completed).toEqual(['pkt-b-ok']);

    // Stale-branch packet marked failed with StaleBranch scenario.
    const stalePacket = readPacket(root, 'pkt-a-stale');
    expect(stalePacket['status']).toBe('failed');
    expect((stalePacket['failure'] as Record<string, unknown>)['scenario']).toBe('StaleBranch');

    const events = readEvents('run-stale', root).map((e) => e.event_type);
    // attempt_started fires for the rebase try; rebase fails; escalated.
    expect(events).toContain('recovery.attempt_started');
    expect(events).toContain('recovery.escalated');
    expect(events).toContain('packet.failed');
  });
});

// ---------------------------------------------------------------------------
// AUTO-RECOVERY SUCCESS-PATH INTEGRATION TESTS
// ---------------------------------------------------------------------------

describe('runDevelopPhase — ProviderTransient retry succeeds; packet completed', () => {
  it('first dev call hits HTTP 503; retry succeeds; packet ends up in completed list', () => {
    const root = mkRoot();
    writePacket(root, 'pkt-t');
    // First implement: 503; second: success. Then review (success).
    __invokeQueue.push({ exit_code: 1, stderr: 'HTTP 503 Service Unavailable' });
    __invokeQueue.push({ exit_code: 0 });
    __invokeQueue.push({ exit_code: 0 });
    // After review approves and code is finalized, completePacket
    // succeeds.
    const result = runDevelopPhase({
      feature: writeFeature(root, 'feat-x', ['pkt-t']),
      config: makeConfig(),
      artifactRoot: root,
      projectRoot: root,
      dryRun: false,
      runId: 'run-trans',
      specId: 'spec-x',
      gitRunner: noopGit,
    });
    expect(result.completed).toEqual(['pkt-t']);
    expect(result.failed).toEqual([]);

    const events = readEvents('run-trans', root).map((e) => e.event_type);
    expect(events).toContain('recovery.attempt_started');
    expect(events).toContain('recovery.succeeded');
    expect(events).not.toContain('recovery.escalated');
  });
});

describe('runDevelopPhase — BuildFailed retry-with-guardrail succeeds', () => {
  it('first finalize fails build; retry sees the guardrail; build passes; packet completed', () => {
    const root = mkRoot();
    writePacket(root, 'pkt-b', { status: 'review_approved', started_at: '2024-01-01T00:00:00Z' });
    // First completePacket: build_pass=false. Second: success.
    __completeQueue.push({
      ci_pass: false,
      build_pass: false,
      lint_pass: true,
      tests_pass: true,
    });
    __completeQueue.push({
      ci_pass: true,
      build_pass: true,
      lint_pass: true,
      tests_pass: true,
    });
    const result = runDevelopPhase({
      feature: writeFeature(root, 'feat-x', ['pkt-b']),
      config: makeConfig(),
      artifactRoot: root,
      projectRoot: root,
      dryRun: false,
      runId: 'run-build',
      specId: 'spec-x',
      gitRunner: noopGit,
    });
    expect(result.completed).toEqual(['pkt-b']);

    // completePacket called twice.
    expect(__completeCalls.length).toBe(2);

    const events = readEvents('run-build', root).map((e) => e.event_type);
    expect(events).toContain('recovery.attempt_started');
    expect(events).toContain('recovery.succeeded');
    expect(events).not.toContain('recovery.escalated');
  });
});

describe('runDevelopPhase — StaleBranch successful rebase + retry', () => {
  it('first finalize throws stale-branch; rebase succeeds; retry succeeds; packet completed', () => {
    const root = mkRoot();
    writePacket(root, 'pkt-rb', { status: 'review_approved', started_at: '2024-01-01T00:00:00Z' });
    // First completePacket throws stale-branch; second succeeds.
    __completeQueue.push(() => {
      throw new Error("Branch is behind 'origin/main' by 1 commit; non-fast-forward state.");
    });
    __completeQueue.push({
      ci_pass: true,
      build_pass: true,
      lint_pass: true,
      tests_pass: true,
    });
    const gitCalls: string[][] = [];
    const gitRunner: GitRunner = (args) => {
      gitCalls.push([...args]);
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const result = runDevelopPhase({
      feature: writeFeature(root, 'feat-x', ['pkt-rb']),
      config: makeConfig(),
      artifactRoot: root,
      projectRoot: root,
      dryRun: false,
      runId: 'run-rebase',
      specId: 'spec-x',
      gitRunner,
    });
    expect(result.completed).toEqual(['pkt-rb']);

    // Recovery layer ran git fetch + rebase before retrying.
    expect(gitCalls).toContainEqual(['fetch', 'origin']);
    expect(gitCalls).toContainEqual(['rebase', 'origin/main']);

    const events = readEvents('run-rebase', root).map((e) => e.event_type);
    expect(events).toContain('recovery.attempt_started');
    expect(events).toContain('recovery.succeeded');
    expect(events).not.toContain('recovery.escalated');
  });
});

// ---------------------------------------------------------------------------
// INDEPENDENT PACKETS CONTINUE AFTER ESCALATION
// ---------------------------------------------------------------------------

describe('runDevelopPhase — independent packets continue after one escalates', () => {
  it('two independent packets: first escalates, second still runs and completes', () => {
    const root = mkRoot();
    // Names chosen so alphabetical readdir order gives pkt-a-fail
    // BEFORE pkt-b-good, matching the queue we set up below.
    writePacket(root, 'pkt-a-fail', { status: 'review_approved', started_at: '2024-01-01T00:00:00Z' });
    writePacket(root, 'pkt-b-good', { status: 'review_approved', started_at: '2024-01-01T00:00:00Z' });

    __completeQueue.push({
      ci_pass: false, build_pass: true, lint_pass: true, tests_pass: false,
    });
    __completeQueue.push({
      ci_pass: true, build_pass: true, lint_pass: true, tests_pass: true,
    });
    const result = runDevelopPhase({
      feature: writeFeature(root, 'feat-x', ['pkt-a-fail', 'pkt-b-good']),
      config: makeConfig(),
      artifactRoot: root,
      projectRoot: root,
      dryRun: false,
      runId: 'run-mixed',
      specId: 'spec-x',
      gitRunner: noopGit,
    });
    expect(result.failed).toContain('pkt-a-fail');
    expect(result.completed).toContain('pkt-b-good');
  });
});
