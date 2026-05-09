/**
 * Phase 6 — Integration tests for verify_phase recovery integration.
 *
 * Pins the same post-escalation invariants as
 * `develop_phase_recovery.test.ts`: packet failed in the failed list,
 * status=failed on disk, packet.failed event fired, no packet.completed
 * event for the escalated packet, subsequent packets continue.
 *
 * Plus the QA-specific dev-packet remediation test: when the QA
 * completion fires BuildFailed, the dev-agent remediation invokes
 * `buildDevPrompt` against the DEV packet (the `verifies` target),
 * NOT the QA packet. This is the round-3 codex finding from the
 * previous attempt, preserved here under the new typed-discriminator
 * contract.
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

interface InvokeCall {
  readonly provider: string;
  readonly prompt: string;
}

interface InvokeOutcome {
  readonly exit_code: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

const __invokeQueue: InvokeOutcome[] = [];
const __invokeCalls: InvokeCall[] = [];

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

vi.mock('../lifecycle/start.js', () => ({
  startPacket: () => undefined,
}));

import { runVerifyPhase } from '../pipeline/verify_phase.js';
import type { FactoryConfig } from '../config.js';
import type { Feature } from '../execute.js';
import type { GitRunner } from '../pipeline/recovery_loop.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  __invokeCalls.length = 0;
  __invokeQueue.length = 0;
  __completeQueue.length = 0;
  __completeCalls.length = 0;
});
beforeEach(() => {
  __invokeCalls.length = 0;
  __invokeQueue.length = 0;
  __completeQueue.length = 0;
  __completeCalls.length = 0;
});

function mkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'verify-recovery-'));
  for (const d of ['packets', 'completions', 'features', 'events']) {
    if (!existsSync(join(root, d))) mkdirSync(join(root, d), { recursive: true });
  }
  dirs.push(root);
  return root;
}

function makeConfig(): FactoryConfig {
  return ({
    project_name: 'verify-recovery-it',
    factory_dir: '.',
    artifact_dir: '.',
    verification: { build: 'true', lint: 'true', test: 'true' },
    validation: { command: 'true' },
    infrastructure_patterns: [],
    completed_by_default: { kind: 'agent', id: 'test' },
    personas: {
      planner: { description: '', instructions: [] },
      developer: { description: '', instructions: ['DEV_INSTRUCTIONS'] },
      code_reviewer: { description: '', instructions: [] },
      qa: { description: '', instructions: ['QA_INSTRUCTIONS'] },
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

function writeDevPacket(root: string, id: string, title: string): void {
  writeFileSync(
    join(root, 'packets', `${id}.json`),
    JSON.stringify({
      id,
      kind: 'dev',
      title,
      status: 'completed',
      started_at: '2024-01-01T00:00:00Z',
    }, null, 2),
    'utf-8',
  );
  // Also seed a completion record so the verify-phase dependency
  // check passes.
  writeFileSync(
    join(root, 'completions', `${id}.json`),
    JSON.stringify({ packet_id: id }, null, 2),
    'utf-8',
  );
}

function writeQaPacket(
  root: string,
  id: string,
  verifies: string,
  extra: Record<string, unknown> = {},
): void {
  writeFileSync(
    join(root, 'packets', `${id}.json`),
    JSON.stringify({
      id,
      kind: 'qa',
      title: `QA ${id}`,
      status: 'ready',
      verifies,
      dependencies: [verifies],
      ...extra,
    }, null, 2),
    'utf-8',
  );
}

function writeFeature(root: string, id: string, packets: string[]): Feature {
  return {
    id,
    intent: 'verify-recovery-it',
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
// ---------------------------------------------------------------------------

describe('runVerifyPhase — TestFailed escalates: post-escalation invariants', () => {
  it('packet marked failed; in failed list; packet.failed emitted; no packet.completed for escalated packet', () => {
    const root = mkRoot();
    writeDevPacket(root, 'pkt-d', 'Dev');
    writeQaPacket(root, 'pkt-q', 'pkt-d');
    // QA agent succeeds, then completePacket fails with tests.
    __completeQueue.push({
      ci_pass: false, build_pass: true, lint_pass: true, tests_pass: false,
    });
    const result = runVerifyPhase({
      feature: writeFeature(root, 'feat-x', ['pkt-d', 'pkt-q']),
      config: makeConfig(),
      artifactRoot: root,
      projectRoot: root,
      dryRun: false,
      runId: 'run-qa-test-failed',
      specId: 'spec-x',
      gitRunner: noopGit,
    });
    expect(result.failed).toEqual(['pkt-q']);
    expect(result.completed).toEqual([]);

    const packet = readPacket(root, 'pkt-q');
    expect(packet['status']).toBe('failed');
    expect((packet['failure'] as Record<string, unknown>)['scenario']).toBe('TestFailed');

    const events = readEvents('run-qa-test-failed', root);
    const types = events.map((e) => e.event_type);
    expect(types).toContain('recovery.escalated');
    expect(types).toContain('packet.failed');
    const completedEvents = events.filter(
      (e) => e.event_type === 'packet.completed' && e.payload['packet_id'] === 'pkt-q',
    );
    expect(completedEvents.length).toBe(0);
  });
});

describe('runVerifyPhase — LintFailed escalates immediately, no retry', () => {
  it('completePacket lint fail -> escalated; no recovery.attempt_started', () => {
    const root = mkRoot();
    writeDevPacket(root, 'pkt-d', 'Dev');
    writeQaPacket(root, 'pkt-q', 'pkt-d');
    __completeQueue.push({
      ci_pass: false, build_pass: true, lint_pass: false, tests_pass: true,
    });
    const result = runVerifyPhase({
      feature: writeFeature(root, 'feat-x', ['pkt-d', 'pkt-q']),
      config: makeConfig(),
      artifactRoot: root,
      projectRoot: root,
      dryRun: false,
      runId: 'run-qa-lint',
      specId: 'spec-x',
      gitRunner: noopGit,
    });
    expect(result.failed).toEqual(['pkt-q']);

    const events = readEvents('run-qa-lint', root).map((e) => e.event_type);
    expect(events).not.toContain('recovery.attempt_started');
    expect(events).toContain('recovery.escalated');
  });
});

describe('runVerifyPhase — StaleBranch from completePacket throw is reachable', () => {
  it('completePacket throws stale-branch -> recovery dispatches StaleBranch -> rebase conflict -> escalated', () => {
    const root = mkRoot();
    writeDevPacket(root, 'pkt-d', 'Dev');
    writeQaPacket(root, 'pkt-q', 'pkt-d');
    __completeQueue.push(() => {
      throw new Error("Branch is behind 'origin/main' by 1 commit; non-fast-forward state.");
    });
    const gitCalls: string[][] = [];
    const gitRunner: GitRunner = (args) => {
      gitCalls.push([...args]);
      if (args[0] === 'fetch') return { exitCode: 0, stdout: '', stderr: '' };
      if (args[0] === 'rebase' && args[1] === 'origin/main') {
        return { exitCode: 1, stdout: '', stderr: 'CONFLICT (content): Merge conflict in src/foo.ts' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const result = runVerifyPhase({
      feature: writeFeature(root, 'feat-x', ['pkt-d', 'pkt-q']),
      config: makeConfig(),
      artifactRoot: root,
      projectRoot: root,
      dryRun: false,
      runId: 'run-qa-stale',
      specId: 'spec-x',
      gitRunner,
    });
    expect(result.failed).toEqual(['pkt-q']);
    const packet = readPacket(root, 'pkt-q');
    expect((packet['failure'] as Record<string, unknown>)['scenario']).toBe('StaleBranch');
    // Recovery layer ran git fetch + rebase before escalating.
    expect(gitCalls).toContainEqual(['fetch', 'origin']);
    expect(gitCalls).toContainEqual(['rebase', 'origin/main']);
    expect(gitCalls).toContainEqual(['rebase', '--abort']);
  });
});

// ---------------------------------------------------------------------------
// QA BuildFailed remediation: targets the DEV packet, NOT the QA packet
// ---------------------------------------------------------------------------

describe('runVerifyPhase — QA BuildFailed remediation invokes the DEV packet', () => {
  it('build_pass=false at completePacket -> dev-agent remediation runs against the dev packet via verifies', () => {
    const root = mkRoot();
    writeDevPacket(root, 'pkt-dev-1', 'Dev packet implementation');
    writeQaPacket(root, 'pkt-qa-1', 'pkt-dev-1');
    // QA agent run succeeds (no need to override invokeQueue for the
    // first call). Then completePacket fails with build_pass=false.
    // Then completePacket succeeds on the retry.
    __completeQueue.push({
      ci_pass: false, build_pass: false, lint_pass: true, tests_pass: true,
    });
    __completeQueue.push({
      ci_pass: true, build_pass: true, lint_pass: true, tests_pass: true,
    });
    const result = runVerifyPhase({
      feature: writeFeature(root, 'feat-x', ['pkt-dev-1', 'pkt-qa-1']),
      config: makeConfig(),
      artifactRoot: root,
      projectRoot: root,
      dryRun: false,
      runId: 'run-qa-build-rem',
      specId: 'spec-x',
      gitRunner: noopGit,
    });
    expect(result.completed).toEqual(['pkt-qa-1']);

    // Dev-agent remediation prompt:
    //   - The dev agent (codex by default) was invoked on the retry.
    //   - The prompt was built from the DEV packet's title — i.e.
    //     it should reference "Dev packet implementation" (the dev
    //     packet's title), NOT "QA pkt-qa-1" (the QA packet).
    const devCalls = __invokeCalls.filter((c) => c.provider === 'codex');
    expect(devCalls.length).toBeGreaterThan(0);
    const remediationPrompt = devCalls[0]!.prompt;
    expect(remediationPrompt).toContain('Dev packet implementation');
    // The QA packet appears in the appended context for visibility.
    expect(remediationPrompt).toContain('pkt-qa-1');
    // Persona instructions of the dev are present (developer prompt
    // builds with developer instructions).
    expect(remediationPrompt).toContain('DEV_INSTRUCTIONS');
  });
});

// ---------------------------------------------------------------------------
// Auto-recovery success path
// ---------------------------------------------------------------------------

describe('runVerifyPhase — ProviderTransient retry succeeds', () => {
  it('first QA call hits 503; retry succeeds; packet completed', () => {
    const root = mkRoot();
    writeDevPacket(root, 'pkt-d', 'Dev');
    writeQaPacket(root, 'pkt-q', 'pkt-d');
    __invokeQueue.push({ exit_code: 1, stderr: 'HTTP 503 Service Unavailable' });
    __invokeQueue.push({ exit_code: 0 });
    const result = runVerifyPhase({
      feature: writeFeature(root, 'feat-x', ['pkt-d', 'pkt-q']),
      config: makeConfig(),
      artifactRoot: root,
      projectRoot: root,
      dryRun: false,
      runId: 'run-qa-trans',
      specId: 'spec-x',
      gitRunner: noopGit,
    });
    expect(result.completed).toEqual(['pkt-q']);

    const events = readEvents('run-qa-trans', root).map((e) => e.event_type);
    expect(events).toContain('recovery.attempt_started');
    expect(events).toContain('recovery.succeeded');
    expect(events).not.toContain('recovery.escalated');
  });
});
