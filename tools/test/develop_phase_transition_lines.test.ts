/**
 * Item B — closing transition log lines after agent invocations.
 *
 * The convergence pass left in-flight invocations covered by
 * heartbeats; transitions BETWEEN invocations were inconsistent.
 * Operators following heartbeat output ("developer working on packet
 * X...") want a closing transition line that confirms the agent
 * exited cleanly and names the next step.
 *
 * Round-2 contract (post-codex review): one transition line per
 * AGENT invocation, no more. The happy-path finalize runs
 * `completePacket` only — no agent — so it emits NO transition line.
 * When the BuildFailed recovery loop re-invokes the developer to fix
 * the build, that ADDITIONAL invocation does emit its own line.
 *
 * Two scenarios are pinned here:
 *
 *   1. Happy path (no remediation): TWO agent transition lines.
 *        - `developer finished implementing '<packet-id>' — proceeding to review`
 *        - `review complete for '<packet-id>' — proceeding to finalize`
 *      NO `developer finished finalize on '<packet-id>'` — that line
 *      was an over-log; the channel='agent' implied an agent ran when
 *      none did. Removed.
 *
 *   2. BuildFailed-remediation path: THREE agent transition lines.
 *      The happy-path two PLUS a build-remediation line emitted at
 *      the point the dev-agent's remediation invocation completes
 *      inside the finalize recovery closure:
 *        - `developer finished build remediation on '<packet-id>'`
 *
 * Mocking shape mirrors `develop_phase_cascade.test.ts`: invokeAgent
 * is replaced with a deterministic queue and the reviewer-auto-approve
 * helper writes `status='review_approved'` to the packet file so the
 * post-Phase-8 ReviewDecisionMissing escalation does not fire on the
 * happy path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fmt from '../output.js';

// ---------------------------------------------------------------------------
// invokeAgent mock — drives the happy path. The third call in the
// queue (the reviewer) flips packet status to 'review_approved' via
// the same helper develop_phase_cascade.test.ts uses, so the post-
// Phase-8 reviewer-no-decision escalation does NOT fire here.
// ---------------------------------------------------------------------------

interface InvokeOutcome {
  readonly exit_code: number;
}

const __invokeQueue: InvokeOutcome[] = [];
let __reviewerArtifactRoot: string | null = null;

vi.mock('../pipeline/agent_invoke.js', () => ({
  resolveModelId: () => undefined,
  buildProviderArgs: () => ({ command: 'noop', args: [] }),
  invokeAgent: (
    provider: string,
    prompt: string,
    _config: unknown,
    _modelTier?: string,
    modelOverride?: string,
  ) => {
    const next = __invokeQueue.shift() ?? { exit_code: 0 };
    if (
      next.exit_code === 0 &&
      __reviewerArtifactRoot !== null &&
      prompt.startsWith('You are a code reviewer.')
    ) {
      const match = prompt.match(/packet "([^"]+)"/);
      if (match) {
        const packetId = match[1]!;
        const packetPath = join(__reviewerArtifactRoot, 'packets', `${packetId}.json`);
        if (existsSync(packetPath)) {
          const data = JSON.parse(readFileSync(packetPath, 'utf-8')) as Record<string, unknown>;
          data['status'] = 'review_approved';
          writeFileSync(packetPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
        }
      }
    }
    return {
      exit_code: next.exit_code,
      stdout: '',
      stderr: '',
      cost: {
        provider,
        model: modelOverride ?? null,
        tokens_in: 100,
        tokens_out: 50,
        dollars: 0.01,
      },
    };
  },
}));

// completePacket mock — supports an optional queue so tests that
// exercise the BuildFailed-remediation path can drive a fail-then-
// succeed sequence. Empty queue defaults to ci_pass=true (the happy
// path). Mirrors the atomic-completion contract from
// `develop_phase_recovery.test.ts`: only writes the completion record
// on success; on failure leaves no artifact so the retry re-runs.
interface CompleteOutcome {
  readonly ci_pass: boolean;
  readonly build_pass: boolean;
  readonly lint_pass: boolean;
  readonly tests_pass: boolean;
}
const __completeQueue: CompleteOutcome[] = [];

vi.mock('../lifecycle/complete.js', () => ({
  completePacket: (opts: Record<string, unknown>) => {
    const packetId = opts['packetId'] as string;
    const projectRoot = opts['projectRoot'] as string | undefined;

    // Idempotency: if a completion record exists, return its values
    // without consuming the queue.
    if (typeof projectRoot === 'string') {
      const completionPath = join(projectRoot, 'completions', `${packetId}.json`);
      if (existsSync(completionPath)) {
        return {
          packet_id: packetId,
          ci_pass: true,
          build_pass: true,
          lint_pass: true,
          tests_pass: true,
          files_changed: [],
          already_complete: true,
        };
      }
    }

    const next = __completeQueue.shift() ?? {
      ci_pass: true, build_pass: true, lint_pass: true, tests_pass: true,
    };

    // Atomic write: only on success.
    if (next.ci_pass && typeof projectRoot === 'string') {
      const completionPath = join(projectRoot, 'completions', `${packetId}.json`);
      writeFileSync(completionPath, JSON.stringify({
        packet_id: packetId,
        completed_at: '2024-01-01T00:00:00Z',
        completed_by: { kind: 'agent', id: 'test' },
        summary: 'mock completion',
        files_changed: [],
        verification: {
          ci_pass: next.ci_pass,
          build_pass: next.build_pass,
          lint_pass: next.lint_pass,
          tests_pass: next.tests_pass,
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
      ci_pass: next.ci_pass,
      build_pass: next.build_pass,
      lint_pass: next.lint_pass,
      tests_pass: next.tests_pass,
      files_changed: [],
      already_complete: false,
    };
  },
}));

vi.mock('../lifecycle/request_review.js', () => ({
  requestReview: () => ({
    kind: 'recorded',
    packet_id: 'noop',
    branch: 'fake',
    review_iteration: 1,
    was_changes_requested: false,
    already_requested: false,
  }),
  RequestReviewError: class extends Error {},
}));
vi.mock('../lifecycle/start.js', () => ({ startPacket: () => undefined }));
vi.mock('../lifecycle/review.js', () => ({ recordReview: () => undefined }));

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
  __invokeQueue.length = 0;
  __completeQueue.length = 0;
});

beforeEach(() => {
  __invokeQueue.length = 0;
  __completeQueue.length = 0;
  __reviewerArtifactRoot = null;
});

function mkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'develop-transitions-'));
  for (const d of ['packets', 'completions', 'features', 'events']) {
    if (!existsSync(join(root, d))) mkdirSync(join(root, d), { recursive: true });
  }
  dirs.push(root);
  __reviewerArtifactRoot = root;
  return root;
}

function makeConfig(): FactoryConfig {
  return ({
    project_name: 'transitions-test',
    factory_dir: '.',
    artifact_dir: '.',
    verification: { build: 'true', lint: 'true', test: 'true' },
    validation: { command: 'true' },
    infrastructure_patterns: [],
    completed_by_default: { kind: 'agent', id: 'test' },
    personas: {
      planner: { description: '', instructions: [] },
      developer: { description: '', instructions: [], model: 'high' },
      code_reviewer: { description: '', instructions: [], model: 'medium' },
      qa: { description: '', instructions: [], model: 'medium' },
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
    JSON.stringify({ id, kind: 'dev', title: `Packet ${id}`, status: 'ready', ...extra }, null, 2),
    'utf-8',
  );
}

function writeFeature(id: string, packets: string[]): Feature {
  return {
    id,
    intent: 'transitions-test',
    status: 'executing',
    packets,
    created_by: { kind: 'agent', id: 'test' },
  } as Feature;
}

const noopGit: GitRunner = () => ({ exitCode: 0, stdout: '', stderr: '' });

// ---------------------------------------------------------------------------
// Item B test — closing transition log lines
// ---------------------------------------------------------------------------

describe('runDevelopPhase — closing transition log lines (Item B)', () => {
  it('happy path: emits EXACTLY two agent transition lines (implement, review) — finalize without remediation runs no agent and emits no transition', async () => {
    const root = mkRoot();
    writePacket(root, 'pkt-happy');
    // Two successful agent invocations: implement + review.
    __invokeQueue.push({ exit_code: 0 }); // developer implement
    __invokeQueue.push({ exit_code: 0 }); // code reviewer

    const calls: Array<{ readonly channel: string; readonly message: string }> = [];
    const spy = vi.spyOn(fmt, 'log').mockImplementation((channel, message) => {
      calls.push({ channel, message });
    });

    try {
      const result = await runDevelopPhase({
        feature: writeFeature('feat-trans', ['pkt-happy']),
        config: makeConfig(),
        artifactRoot: root,
        projectRoot: root,
        dryRun: false,
        runId: 'run-trans',
        specId: 'spec-trans',
        gitRunner: noopGit,
      });
      expect(result.completed).toEqual(['pkt-happy']);
    } finally {
      spy.mockRestore();
    }

    // Collect the transition lines (channel='agent') so we can assert
    // on them independently of the operator-facing per-phase log lines.
    const transitionLines = calls.filter((c) => c.channel === 'agent');
    const messages = transitionLines.map((c) => c.message);

    // Round-2 contract: EXACTLY two agent transitions on the happy
    // path. Finalize without remediation invokes no agent, so the
    // previous unconditional 'developer finished finalize on ...'
    // line was an over-log and has been removed.
    expect(messages).toEqual([
      `developer finished implementing 'pkt-happy' — proceeding to review`,
      `review complete for 'pkt-happy' — proceeding to finalize`,
    ]);
    // Defense in depth: the removed line MUST NOT reappear.
    expect(messages).not.toContain(`developer finished finalize on 'pkt-happy'`);
  });

  it('BuildFailed remediation: emits THREE agent transition lines (implement, review, build-remediation)', async () => {
    const root = mkRoot();
    writePacket(root, 'pkt-bf');

    // Agent invocation sequence:
    //   1. developer implement -> success
    //   2. code reviewer       -> success (auto-approves packet)
    //   3. developer build remediation (inside finalize recovery) -> success
    __invokeQueue.push({ exit_code: 0 });
    __invokeQueue.push({ exit_code: 0 });
    __invokeQueue.push({ exit_code: 0 });

    // completePacket sequence: first call fails build, recovery loop
    // dispatches retry_with_guardrail_prompt; second call succeeds.
    __completeQueue.push({
      ci_pass: false, build_pass: false, lint_pass: true, tests_pass: true,
    });
    __completeQueue.push({
      ci_pass: true, build_pass: true, lint_pass: true, tests_pass: true,
    });

    const calls: Array<{ readonly channel: string; readonly message: string }> = [];
    const spy = vi.spyOn(fmt, 'log').mockImplementation((channel, message) => {
      calls.push({ channel, message });
    });

    try {
      const result = await runDevelopPhase({
        feature: writeFeature('feat-bf', ['pkt-bf']),
        config: makeConfig(),
        artifactRoot: root,
        projectRoot: root,
        dryRun: false,
        runId: 'run-bf',
        specId: 'spec-bf',
        gitRunner: noopGit,
      });
      expect(result.completed).toEqual(['pkt-bf']);
    } finally {
      spy.mockRestore();
    }

    const messages = calls
      .filter((c) => c.channel === 'agent')
      .map((c) => c.message);

    // THREE transitions: one per actual dev/reviewer invocation. The
    // remediation line is emitted INSIDE `runRemediation` at the
    // point the dev-agent's invocation completes — NOT at the
    // finalize-branch exit (where no agent ran).
    expect(messages).toEqual([
      `developer finished implementing 'pkt-bf' — proceeding to review`,
      `review complete for 'pkt-bf' — proceeding to finalize`,
      `developer finished build remediation on 'pkt-bf'`,
    ]);
    // Defense in depth: the removed unconditional finalize line MUST
    // NOT fire even on the remediation path.
    expect(messages).not.toContain(`developer finished finalize on 'pkt-bf'`);
  });
});
