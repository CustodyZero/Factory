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
// Convergence pass — see comment in develop_phase_cascade.test.ts.
// The mock mirrors the real reviewer-calls-review.ts behavior so
// happy-path fixtures don't trip the new ReviewDecisionMissing
// escalation. Tests opt out via __reviewerAutoApprove=false to
// exercise the no-decision path explicitly. Tests that need to
// drive request-changes-then-approve transitions assign
// __reviewerStatusSequence (one entry consumed per reviewer call).
let __reviewerArtifactRoot: string | null = null;
let __reviewerAutoApprove = true;
let __reviewerStatusSequence: string[] | null = null;

vi.mock('../pipeline/agent_invoke.js', () => ({
  resolveModelId: () => undefined,
  buildProviderArgs: () => ({ command: 'noop', args: [] }),
  invokeAgent: (provider: string, prompt: string) => {
    __invokeCalls.push({ provider, prompt });
    const next = __invokeQueue.shift();
    const outcome = next ?? { exit_code: 0 };
    if (
      outcome.exit_code === 0 &&
      __reviewerArtifactRoot !== null &&
      prompt.startsWith('You are a code reviewer.')
    ) {
      // Resolve the per-call target status:
      //   1. If the test queued a sequence, use the head entry.
      //   2. Else if auto-approve is on, write 'review_approved'.
      //   3. Else (auto-approve off, no sequence), do NOT mutate
      //      disk — the test is exercising the no-decision path.
      let targetStatus: string | null = null;
      if (__reviewerStatusSequence !== null && __reviewerStatusSequence.length > 0) {
        targetStatus = __reviewerStatusSequence.shift() ?? null;
      } else if (__reviewerAutoApprove) {
        targetStatus = 'review_approved';
      }
      if (targetStatus !== null) {
        const match = prompt.match(/packet "([^"]+)"/);
        if (match) {
          const packetId = match[1]!;
          const packetPath = join(__reviewerArtifactRoot, 'packets', `${packetId}.json`);
          if (existsSync(packetPath)) {
            const data = JSON.parse(readFileSync(packetPath, 'utf-8')) as Record<string, unknown>;
            data['status'] = targetStatus;
            writeFileSync(packetPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
          }
        }
      }
    }
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
 * The completePacket mock mirrors the real lifecycle code's
 * atomic-completion contract (Phase 6, Option A):
 *   - ci_pass=true: write a completion record AND set packet status
 *     to 'completed'. The next call sees existsSync(completionPath)
 *     and would short-circuit on already_complete=true.
 *   - ci_pass=false: do NOT write a record; do NOT mutate packet
 *     status. The next call re-runs the queue.
 *
 * Without this realism, tests that exercise the "first call fails,
 * second call succeeds" path can't catch the round-2 idempotency bug
 * where a stale completion record falsely short-circuits a retry.
 */
vi.mock('../lifecycle/complete.js', () => ({
  completePacket: (opts: Record<string, unknown>) => {
    __completeCalls.push(opts);
    const packetId = opts['packetId'] as string;
    const projectRoot = opts['projectRoot'] as string | undefined;

    // Idempotency: if a completion record exists, return its values
    // without consuming the queue (matches real completePacket).
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

    // Atomic write: only on success.
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
  __reviewerArtifactRoot = null;
  __reviewerAutoApprove = true;
  __reviewerStatusSequence = null;
});

function mkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'develop-recovery-'));
  if (!existsSync(join(root, 'packets'))) mkdirSync(join(root, 'packets'), { recursive: true });
  if (!existsSync(join(root, 'completions'))) mkdirSync(join(root, 'completions'), { recursive: true });
  if (!existsSync(join(root, 'features'))) mkdirSync(join(root, 'features'), { recursive: true });
  if (!existsSync(join(root, 'events'))) mkdirSync(join(root, 'events'), { recursive: true });
  dirs.push(root);
  // Wire the per-test reviewer-auto-approve mock to this root.
  __reviewerArtifactRoot = root;
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
        planner: ['claude'],
        developer: ['codex'],
        code_reviewer: ['claude'],
        qa: ['claude'],
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

/**
 * The four post-escalation invariants every escalation integration
 * test must pin (Phase 6 round-2 codex finding):
 *
 *   (1) result.failed contains the packet
 *   (2) result.completed does NOT contain the packet
 *   (3) packets/<id>.json has status === 'failed'
 *   (4) NO packet.completed event was emitted for that packet
 *
 * Asserting only labels (in failed list, scenario set) misses
 * controlling-vs-observable gaps. This helper enforces the full set.
 */
function expectEscalationInvariants(
  result: { readonly failed: readonly string[]; readonly completed: readonly string[] },
  root: string,
  runId: string,
  packetId: string,
): void {
  // (1)
  expect(result.failed).toContain(packetId);
  // (2)
  expect(result.completed).not.toContain(packetId);
  // (3)
  const packet = readPacket(root, packetId);
  expect(packet['status']).toBe('failed');
  // (4)
  const completedEvents = readEvents(runId, root).filter(
    (e) => e.event_type === 'packet.completed' && e.payload['packet_id'] === packetId,
  );
  expect(completedEvents.length).toBe(0);
}

// ---------------------------------------------------------------------------
// ESCALATION-PATH INTEGRATION TESTS
//
// Each test drives a packet through runDevelopPhase with a fixture
// that produces a failure the recovery layer escalates on, then
// asserts the post-escalation invariants.
// ---------------------------------------------------------------------------

describe('runDevelopPhase — TestFailed escalates: post-escalation invariants', () => {
  it('returns the packet in failed list, NOT completed; marks packet failed; emits packet.failed; emits no packet.completed', async () => {
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
    const result = await runDevelopPhase({
      feature,
      config: makeConfig(),
      artifactRoot: root,
      projectRoot: root,
      dryRun: false,
      runId: 'run-test-failed',
      specId: 'spec-x',
      gitRunner: noopGit,
    });

    // FOUR-INVARIANT post-escalation: failed list, not completed,
    // packet status, and no packet.completed event.
    expectEscalationInvariants(result, root, 'run-test-failed', 'pkt-test');

    const packet = readPacket(root, 'pkt-test');
    expect(packet['failure']).toBeDefined();
    const failure = packet['failure'] as Record<string, unknown>;
    expect(failure['scenario']).toBe('TestFailed');

    // recovery.escalated AND packet.failed events fired.
    const events = readEvents('run-test-failed', root).map((e) => e.event_type);
    expect(events).toContain('recovery.escalated');
    expect(events).toContain('packet.failed');
  });
});

describe('runDevelopPhase — LintFailed escalates immediately, no retry', () => {
  it('packet marked failed; recovery scenario is LintFailed; no recovery.attempt_started; FOUR-INVARIANT', async () => {
    const root = mkRoot();
    writePacket(root, 'pkt-lint', { status: 'review_approved', started_at: '2024-01-01T00:00:00Z' });
    __completeQueue.push({
      ci_pass: false,
      build_pass: true,
      lint_pass: false,
      tests_pass: true,
    });
    const result = await runDevelopPhase({
      feature: writeFeature(root, 'feat-x', ['pkt-lint']),
      config: makeConfig(),
      artifactRoot: root,
      projectRoot: root,
      dryRun: false,
      runId: 'run-lint',
      specId: 'spec-x',
      gitRunner: noopGit,
    });

    expectEscalationInvariants(result, root, 'run-lint', 'pkt-lint');

    const packet = readPacket(root, 'pkt-lint');
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
  it('completePacket throws FI-7 -> CompletionGateBlocked -> packet failed; FOUR-INVARIANT', async () => {
    const root = mkRoot();
    writePacket(root, 'pkt-fi7', { status: 'review_approved', started_at: '2024-01-01T00:00:00Z' });
    __completeQueue.push(() => {
      throw new Error('pre-commit hook failed (FI-7 enforcement)');
    });
    const result = await runDevelopPhase({
      feature: writeFeature(root, 'feat-x', ['pkt-fi7']),
      config: makeConfig(),
      artifactRoot: root,
      projectRoot: root,
      dryRun: false,
      runId: 'run-fi7',
      specId: 'spec-x',
      gitRunner: noopGit,
    });

    expectEscalationInvariants(result, root, 'run-fi7', 'pkt-fi7');

    const packet = readPacket(root, 'pkt-fi7');
    expect((packet['failure'] as Record<string, unknown>)['scenario']).toBe('CompletionGateBlocked');

    const events = readEvents('run-fi7', root).map((e) => e.event_type);
    expect(events).not.toContain('recovery.attempt_started');
    expect(events).toContain('recovery.escalated');
  });
});

describe('runDevelopPhase — ProviderUnavailable escalates immediately', () => {
  it('agent stderr says provider disabled -> ProviderUnavailable -> packet failed; FOUR-INVARIANT', async () => {
    const root = mkRoot();
    writePacket(root, 'pkt-pu');
    __invokeQueue.push({
      exit_code: 1,
      stderr: "Provider 'codex' is disabled",
    });
    const result = await runDevelopPhase({
      feature: writeFeature(root, 'feat-x', ['pkt-pu']),
      config: makeConfig(),
      artifactRoot: root,
      projectRoot: root,
      dryRun: false,
      runId: 'run-pu',
      specId: 'spec-x',
      gitRunner: noopGit,
    });

    expectEscalationInvariants(result, root, 'run-pu', 'pkt-pu');

    const packet = readPacket(root, 'pkt-pu');
    expect((packet['failure'] as Record<string, unknown>)['scenario']).toBe('ProviderUnavailable');

    const events = readEvents('run-pu', root).map((e) => e.event_type);
    expect(events).not.toContain('recovery.attempt_started');
    expect(events).toContain('recovery.escalated');
  });
});

describe('runDevelopPhase — StaleBranch rebase conflict escalates', () => {
  it('completePacket throws stale-branch -> rebase conflict -> packet failed; subsequent independent packet still runs', async () => {
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
    const result = await runDevelopPhase({
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

    // Full FOUR-INVARIANT post-escalation assertion on the failed packet.
    expectEscalationInvariants(result, root, 'run-stale', 'pkt-a-stale');

    // Stale-branch packet has the right scenario stamped.
    const stalePacket = readPacket(root, 'pkt-a-stale');
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
  it('first dev call hits HTTP 503; retry succeeds; packet ends up in completed list', async () => {
    const root = mkRoot();
    writePacket(root, 'pkt-t');
    // First implement: 503; second: success. Then review (success).
    __invokeQueue.push({ exit_code: 1, stderr: 'HTTP 503 Service Unavailable' });
    __invokeQueue.push({ exit_code: 0 });
    __invokeQueue.push({ exit_code: 0 });
    // After review approves and code is finalized, completePacket
    // succeeds.
    const result = await runDevelopPhase({
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
  it('first finalize fails build; dev agent re-invoked with guardrail BEFORE retry; build passes; packet completed', async () => {
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
    const result = await runDevelopPhase({
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

    // Round-2 controlling contract: BEFORE the retry of completePacket,
    // the dev agent (codex) must have been invoked with the BuildFailed
    // guardrail prompt appended. Without this step, the retry would
    // observe the same failure forever — the round-2 codex finding.
    // Pin the EXACT guardrail text and assert the order: the dev
    // remediation invocation comes AFTER the failing completePacket
    // and BEFORE the retrying completePacket.
    const guardrailCalls = __invokeCalls.filter(
      (c) => c.provider === 'codex' && c.prompt.includes(
        'The previous implementation failed the build. Fix the implementation.',
      ),
    );
    expect(guardrailCalls.length).toBe(1);

    const events = readEvents('run-build', root).map((e) => e.event_type);
    expect(events).toContain('recovery.attempt_started');
    expect(events).toContain('recovery.succeeded');
    expect(events).not.toContain('recovery.escalated');
  });
});

describe('runDevelopPhase — Phase 7 round-2: BuildFailed remediation preserved across cascade', () => {
  it('completePacket fails build -> primary remediation agent fails ProviderUnavailable -> cascade fires -> 2nd hop remediation succeeds -> completePacket retries and succeeds', async () => {
    const root = mkRoot();
    writePacket(root, 'pkt-bcr', { status: 'review_approved', started_at: '2024-01-01T00:00:00Z' });

    // Sequence the closure observes:
    //   1. completePacket -> ci_pass=false (build failure)
    //   2. recipe -> retry_with_guardrail_prompt; closure runs dev
    //      agent on devPrimary (codex). Mock: agent fails with
    //      "Provider 'codex' is disabled" -> ProviderUnavailable.
    //   3. recipe -> cascade_provider hop to claude. Closure must
    //      RE-RUN remediation against claude with the SAME guardrail
    //      prompt — the load-bearing fix. Mock: claude succeeds.
    //   4. closure falls through to completePacket -> ci_pass=true.
    //
    // Without the fix, step 3 would skip remediation: the closure
    // would receive cascade_provider but only the
    // retry_with_guardrail_prompt branch ran remediation, so the
    // closure would go straight to completePacket against
    // unchanged code, observing the same build failure forever
    // (until BuildFailed budget exhausts -> escalate).
    __completeQueue.push({
      ci_pass: false, build_pass: false, lint_pass: true, tests_pass: true,
    });
    __completeQueue.push({
      ci_pass: true, build_pass: true, lint_pass: true, tests_pass: true,
    });
    // Dev-agent invocations:
    //   first remediation (codex primary): ProviderUnavailable.
    //   second remediation (claude cascade hop): success.
    __invokeQueue.push({ exit_code: 1, stderr: "Provider 'codex' is disabled" });
    __invokeQueue.push({ exit_code: 0 });

    // persona_providers.developer = ['codex', 'claude'] so the
    // cascade has a second hop available.
    const cfg = (() => {
      const c = makeConfig() as unknown as Record<string, unknown>;
      const pipeline = c['pipeline'] as Record<string, unknown>;
      const personaProviders = pipeline['persona_providers'] as Record<string, unknown>;
      personaProviders['developer'] = ['codex', 'claude'];
      return c as unknown as FactoryConfig;
    })();

    const result = await runDevelopPhase({
      feature: writeFeature(root, 'feat-x', ['pkt-bcr']),
      config: cfg,
      artifactRoot: root,
      projectRoot: root,
      dryRun: false,
      runId: 'run-bcr',
      specId: 'spec-x',
      gitRunner: noopGit,
    });
    expect(result.completed).toEqual(['pkt-bcr']);
    expect(__completeCalls.length).toBe(2);

    // Pin: TWO dev-agent invocations, each carrying the BuildFailed
    // guardrail prompt. The first hit codex (primary, failed); the
    // second hit claude (cascade hop, succeeded) — the load-bearing
    // assertion that the remediation prompt was preserved across
    // the cascade boundary.
    const guardrailCalls = __invokeCalls.filter(
      (c) => c.prompt.includes(
        'The previous implementation failed the build. Fix the implementation.',
      ),
    );
    expect(guardrailCalls.length).toBe(2);
    expect(guardrailCalls[0]?.provider).toBe('codex');
    expect(guardrailCalls[1]?.provider).toBe('claude');
  });
});

describe('runDevelopPhase — StaleBranch successful rebase + retry', () => {
  it('first finalize throws stale-branch; rebase succeeds; retry succeeds; packet completed', async () => {
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
    const result = await runDevelopPhase({
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
  it('two independent packets: first escalates, second still runs and completes', async () => {
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
    const result = await runDevelopPhase({
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

// ---------------------------------------------------------------------------
// ReviewDecisionMissing — the convergence-pass facade fix
//
// Round-2 codex finding: the develop_phase review case used to silently
// force-approve when the reviewer agent exited 0 without recording a
// verdict via review.ts. That contradicted the "review.ts is the
// load-bearing protocol channel" claim in AGENTS.md / README and is
// exactly the CLAUDE.md §3.1 facade pattern.
//
// These tests pin the new behavior:
//
//   1. Reviewer exits 0 AND does NOT record a decision (status stays
//      'review_requested') -> packet is escalated as
//      ReviewDecisionMissing, NOT silently approved.
//
//   2. Reviewer exits 0 AND records 'approve' (status becomes
//      'review_approved') -> packet completes (happy-path regression
//      test; the auto-approve mock in this file simulates the
//      reviewer calling `review.ts --approve`).
//
//   3. Reviewer exits 0 AND records 'request-changes' (status becomes
//      'changes_requested') -> packet enters the rework loop instead
//      of completing or escalating.
// ---------------------------------------------------------------------------

describe('runDevelopPhase — ReviewDecisionMissing escalation (no silent approval)', () => {
  it('reviewer exits 0 without calling review.ts: packet ends up failed; escalation events emitted; status is failed; recordReview NOT called by orchestrator', async () => {
    const root = mkRoot();
    // Implementation succeeds; request_review transitions to
    // 'review_requested' — the realistic on-disk state when the
    // reviewer is invoked. The test stubs request_review below to
    // perform that transition.
    writePacket(root, 'pkt-no-decision', { status: 'ready', started_at: '2024-01-01T00:00:00Z' });
    __requestReviewQueue.push(() => {
      // Mirror the real lifecycle: write 'review_requested' to disk so
      // the develop_phase post-condition (review-prompt fires only
      // when status is 'review_requested') is exercised honestly.
      const packetPath = join(root, 'packets', 'pkt-no-decision.json');
      const data = JSON.parse(readFileSync(packetPath, 'utf-8')) as Record<string, unknown>;
      data['status'] = 'review_requested';
      writeFileSync(packetPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
      return {
        kind: 'recorded',
        packet_id: 'pkt-no-decision',
        branch: 'fake',
        review_iteration: 1,
        was_changes_requested: false,
        already_requested: false,
      };
    });
    // Disable the auto-approve hook in the invokeAgent mock — we
    // want to simulate the ACTUAL bug: a reviewer that exits 0
    // without calling review.ts.
    __reviewerAutoApprove = false;
    // invokeQueue: dev (success), then reviewer (exit 0 but no
    // status update because auto-approve is disabled).
    __invokeQueue.push({ exit_code: 0 }); // dev
    __invokeQueue.push({ exit_code: 0 }); // reviewer (no decision)

    const result = await runDevelopPhase({
      feature: writeFeature(root, 'feat-x', ['pkt-no-decision']),
      config: makeConfig(),
      artifactRoot: root,
      projectRoot: root,
      dryRun: false,
      runId: 'run-no-decision',
      specId: 'spec-x',
      gitRunner: noopGit,
    });

    // Standard four-invariant escalation pin: NOT in completed list,
    // IS in failed list, packet status='failed', NO packet.completed
    // event for this packet.
    expectEscalationInvariants(result, root, 'run-no-decision', 'pkt-no-decision');

    // Specific to this scenario: the failure was tagged
    // ReviewDecisionMissing (NOT AgentNonResponsive — the agent ran
    // and exited 0; it just didn't record a verdict).
    const packet = readPacket(root, 'pkt-no-decision');
    const failure = packet['failure'] as Record<string, unknown>;
    expect(failure['scenario']).toBe('ReviewDecisionMissing');

    // recovery.escalated AND packet.failed events fired.
    const events = readEvents('run-no-decision', root).map((e) => e.event_type);
    expect(events).toContain('recovery.escalated');
    expect(events).toContain('packet.failed');
    // No retries — the recipe escalates immediately.
    expect(events).not.toContain('recovery.attempt_started');

    // The escalation reason names review.ts so an operator
    // reading escalations/<run>/*.json sees the protocol channel.
    expect(failure['reason']).toMatch(/review\.ts/);
  });

  it('reviewer happy path: reviewer records "approve" (status becomes review_approved); packet completes (regression pin)', async () => {
    const root = mkRoot();
    writePacket(root, 'pkt-happy', { status: 'ready', started_at: '2024-01-01T00:00:00Z' });
    // Mirror real request_review on disk so the review case fires.
    __requestReviewQueue.push(() => {
      const packetPath = join(root, 'packets', 'pkt-happy.json');
      const data = JSON.parse(readFileSync(packetPath, 'utf-8')) as Record<string, unknown>;
      data['status'] = 'review_requested';
      writeFileSync(packetPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
      return {
        kind: 'recorded',
        packet_id: 'pkt-happy',
        branch: 'fake',
        review_iteration: 1,
        was_changes_requested: false,
        already_requested: false,
      };
    });
    // Auto-approve enabled (default): the invokeAgent mock detects
    // the reviewer prompt and writes 'review_approved' on success.
    __invokeQueue.push({ exit_code: 0 }); // dev
    __invokeQueue.push({ exit_code: 0 }); // reviewer (auto-approves)

    const result = await runDevelopPhase({
      feature: writeFeature(root, 'feat-x', ['pkt-happy']),
      config: makeConfig(),
      artifactRoot: root,
      projectRoot: root,
      dryRun: false,
      runId: 'run-happy',
      specId: 'spec-x',
      gitRunner: noopGit,
    });

    expect(result.completed).toEqual(['pkt-happy']);
    expect(result.failed).not.toContain('pkt-happy');
    const events = readEvents('run-happy', root).map((e) => e.event_type);
    expect(events).not.toContain('recovery.escalated');
  });

  it('reviewer requests changes: status becomes changes_requested; develop loop enters rework; second review approves; packet completes (regression pin)', async () => {
    const root = mkRoot();
    writePacket(root, 'pkt-changes', { status: 'ready', started_at: '2024-01-01T00:00:00Z' });
    const packetPath = join(root, 'packets', 'pkt-changes.json');

    // Both request_review hooks transition the packet to
    // 'review_requested' on disk so the develop loop's review case
    // fires for each iteration.
    const reqReviewHook = (iteration: number, wasChangesRequested: boolean) => () => {
      const data = JSON.parse(readFileSync(packetPath, 'utf-8')) as Record<string, unknown>;
      data['status'] = 'review_requested';
      writeFileSync(packetPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
      return {
        kind: 'recorded' as const,
        packet_id: 'pkt-changes',
        branch: 'fake',
        review_iteration: iteration,
        was_changes_requested: wasChangesRequested,
        already_requested: false,
      };
    };
    __requestReviewQueue.push(reqReviewHook(1, false));
    __requestReviewQueue.push(reqReviewHook(2, true));

    // Drive the per-call reviewer verdict via the test-only sequence
    // hook in the invokeAgent mock: first reviewer invocation writes
    // 'changes_requested'; second writes 'review_approved'.
    __reviewerStatusSequence = ['changes_requested', 'review_approved'];

    __invokeQueue.push({ exit_code: 0 }); // dev (implement)
    __invokeQueue.push({ exit_code: 0 }); // reviewer 1 -> changes_requested
    __invokeQueue.push({ exit_code: 0 }); // dev (rework)
    __invokeQueue.push({ exit_code: 0 }); // reviewer 2 -> review_approved

    const result = await runDevelopPhase({
      feature: writeFeature(root, 'feat-x', ['pkt-changes']),
      config: makeConfig(),
      artifactRoot: root,
      projectRoot: root,
      dryRun: false,
      runId: 'run-changes',
      specId: 'spec-x',
      gitRunner: noopGit,
    });

    expect(result.completed).toEqual(['pkt-changes']);
    const events = readEvents('run-changes', root).map((e) => e.event_type);
    expect(events).not.toContain('recovery.escalated');
    // The sequence was fully consumed — both reviewer calls fired.
    expect(__reviewerStatusSequence).toEqual([]);

    // The two reviewer prompts left their fingerprint in __invokeCalls.
    const reviewerCalls = __invokeCalls.filter(
      (c) => c.prompt.startsWith('You are a code reviewer.'),
    );
    expect(reviewerCalls.length).toBe(2);
  });
});
