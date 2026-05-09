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

/**
 * Atomic-completion mock (Phase 6, Option A): write completion record
 * + status='completed' ONLY when ci_pass=true. On retry, the existing
 * record short-circuits via already_complete=true. Without this
 * realism, the round-2 idempotency bug — a stale failed-completion
 * falsely succeeding on retry — slips past the test.
 */
vi.mock('../lifecycle/complete.js', () => ({
  completePacket: (opts: Record<string, unknown>) => {
    __completeCalls.push(opts);
    const packetId = opts['packetId'] as string;
    const projectRoot = opts['projectRoot'] as string | undefined;

    if (typeof projectRoot === 'string') {
      const completionPath = join(projectRoot, 'completions', `${packetId}.json`);
      if (existsSync(completionPath)) {
        const existing = JSON.parse(readFileSync(completionPath, 'utf-8')) as {
          packet_id: string;
          verification?: { ci_pass?: boolean; build_pass?: boolean; lint_pass?: boolean; tests_pass?: boolean };
        };
        const v = existing.verification ?? {};
        return {
          packet_id: existing.packet_id,
          ci_pass: v.ci_pass ?? false,
          build_pass: v.build_pass ?? false,
          lint_pass: v.lint_pass ?? false,
          tests_pass: v.tests_pass ?? false,
          files_changed: [],
          already_complete: true,
        };
      }
    }

    const next = __completeQueue.shift();
    const outcome: CompleteOutcome = next === undefined
      ? { ci_pass: true, build_pass: true, lint_pass: true, tests_pass: true }
      : (typeof next === 'function' ? next() : next);

    if (outcome.ci_pass && typeof projectRoot === 'string') {
      const completionPath = join(projectRoot, 'completions', `${packetId}.json`);
      writeFileSync(completionPath, JSON.stringify({
        packet_id: packetId,
        completed_at: '2024-01-01T00:00:00Z',
        completed_by: { kind: 'agent', id: 'test' },
        summary: 'mock completion',
        files_changed: [],
        verification: {
          ci_pass: outcome.ci_pass,
          build_pass: outcome.build_pass,
          lint_pass: outcome.lint_pass,
          tests_pass: outcome.tests_pass,
          notes: 'ok',
        },
      }, null, 2) + '\n', 'utf-8');
      const packetPath = join(projectRoot, 'packets', `${packetId}.json`);
      if (existsSync(packetPath)) {
        const data = JSON.parse(readFileSync(packetPath, 'utf-8')) as Record<string, unknown>;
        data['status'] = 'completed';
        writeFileSync(packetPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
      }
    }

    return {
      packet_id: packetId,
      ci_pass: outcome.ci_pass,
      build_pass: outcome.build_pass,
      lint_pass: outcome.lint_pass,
      tests_pass: outcome.tests_pass,
      files_changed: [],
      already_complete: false,
    };
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

/**
 * The four post-escalation invariants (Phase 6 round-2 codex finding):
 *   (1) result.failed contains the packet
 *   (2) result.completed does NOT contain the packet
 *   (3) packets/<id>.json has status === 'failed'
 *   (4) NO packet.completed event was emitted for that packet
 */
function expectEscalationInvariants(
  result: { readonly failed: readonly string[]; readonly completed: readonly string[] },
  root: string,
  runId: string,
  packetId: string,
): void {
  expect(result.failed).toContain(packetId);
  expect(result.completed).not.toContain(packetId);
  const packet = readPacket(root, packetId);
  expect(packet['status']).toBe('failed');
  const completedEvents = readEvents(runId, root).filter(
    (e) => e.event_type === 'packet.completed' && e.payload['packet_id'] === packetId,
  );
  expect(completedEvents.length).toBe(0);
}

// ---------------------------------------------------------------------------
// ESCALATION-PATH INTEGRATION TESTS
// ---------------------------------------------------------------------------

describe('runVerifyPhase — TestFailed escalates: post-escalation invariants', () => {
  it('packet marked failed; in failed list; packet.failed emitted; no packet.completed for escalated packet; FOUR-INVARIANT', () => {
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

    expectEscalationInvariants(result, root, 'run-qa-test-failed', 'pkt-q');

    const packet = readPacket(root, 'pkt-q');
    expect((packet['failure'] as Record<string, unknown>)['scenario']).toBe('TestFailed');

    const types = readEvents('run-qa-test-failed', root).map((e) => e.event_type);
    expect(types).toContain('recovery.escalated');
    expect(types).toContain('packet.failed');
  });
});

describe('runVerifyPhase — LintFailed escalates immediately, no retry', () => {
  it('completePacket lint fail -> escalated; no recovery.attempt_started; FOUR-INVARIANT', () => {
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

    expectEscalationInvariants(result, root, 'run-qa-lint', 'pkt-q');

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
    expectEscalationInvariants(result, root, 'run-qa-stale', 'pkt-q');

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

// ---------------------------------------------------------------------------
// Phase 6 — QA packet whose dev dependency is `status: "failed"` is
// terminated, NOT left waiting indefinitely as a skipped packet.
// ---------------------------------------------------------------------------

describe('runVerifyPhase — QA packet whose dev dependency failed is terminated', () => {
  it('dev packet status=failed (no completion) -> QA packet placed in failed list with cascaded scenario', () => {
    const root = mkRoot();
    // Write a dev packet in terminal-failed state with NO completion record.
    writeFileSync(
      join(root, 'packets', 'pkt-d-bad.json'),
      JSON.stringify({
        id: 'pkt-d-bad',
        kind: 'dev',
        title: 'Dev that failed',
        status: 'failed',
        started_at: '2024-01-01T00:00:00Z',
        failure: {
          scenario: 'TestFailed',
          reason: 'tests failed',
          attempts: 1,
          escalation_path: null,
        },
      }, null, 2),
      'utf-8',
    );
    writeQaPacket(root, 'pkt-q', 'pkt-d-bad');

    const result = runVerifyPhase({
      feature: writeFeature(root, 'feat-x', ['pkt-d-bad', 'pkt-q']),
      config: makeConfig(),
      artifactRoot: root,
      projectRoot: root,
      dryRun: false,
      runId: 'run-cascade',
      specId: 'spec-x',
      gitRunner: noopGit,
    });

    // The QA packet is failed, NOT skipped (would otherwise wait forever).
    expect(result.failed).toContain('pkt-q');
    expect(result.skipped).not.toContain('pkt-q');
    expect(result.completed).not.toContain('pkt-q');

    // The QA packet was stamped with the cascade scenario.
    const qaPacket = readPacket(root, 'pkt-q');
    expect(qaPacket['status']).toBe('failed');
    expect((qaPacket['failure'] as Record<string, unknown>)['scenario']).toBe('CascadedFromDependency');

    // The QA agent was NEVER invoked — there is nothing to verify.
    expect(__invokeCalls.length).toBe(0);
  });
});
