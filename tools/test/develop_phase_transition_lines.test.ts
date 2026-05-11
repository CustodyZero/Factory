/**
 * Item B — closing transition log lines after agent invocations.
 *
 * The convergence pass left in-flight invocations covered by
 * heartbeats; transitions BETWEEN invocations were inconsistent.
 * Operators following heartbeat output ("developer working on packet
 * X...") want a closing transition line that confirms the agent
 * exited cleanly and names the next step.
 *
 * This test pins the operator-UX contract by driving a happy-path
 * develop_phase run with mocked agent invocations and asserting at
 * least two of the transition lines fire at the expected points:
 *
 *   - `developer finished implementing '<packet-id>' — proceeding to review`
 *   - `review complete for '<packet-id>' — proceeding to finalize`
 *   - `developer finished finalize on '<packet-id>'`
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

// completePacket mock — happy path always succeeds (ci_pass=true) and
// stamps the completion record to disk so the develop loop sees the
// terminal `completed` state.
vi.mock('../lifecycle/complete.js', () => ({
  completePacket: (opts: Record<string, unknown>) => {
    const packetId = opts['packetId'] as string;
    const projectRoot = opts['projectRoot'] as string | undefined;
    if (typeof projectRoot === 'string') {
      const completionPath = join(projectRoot, 'completions', `${packetId}.json`);
      writeFileSync(completionPath, JSON.stringify({
        packet_id: packetId,
        completed_at: '2024-01-01T00:00:00Z',
        completed_by: { kind: 'agent', id: 'test' },
        summary: 'mock completion',
        files_changed: [],
        verification: {
          ci_pass: true, build_pass: true, lint_pass: true, tests_pass: true,
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
      ci_pass: true,
      build_pass: true,
      lint_pass: true,
      tests_pass: true,
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
});

beforeEach(() => {
  __invokeQueue.length = 0;
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
  it('emits at least two transition lines on a happy-path packet through implement -> review -> finalize', async () => {
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

    // CRITICAL: at least two of the three documented transitions fire
    // on the happy path. The brief asks for "at least 2", so we pin
    // the implement->review and finalize ones explicitly. The review
    // transition is a third bonus that also fires here.
    const messages = transitionLines.map((c) => c.message);
    expect(messages).toContain(
      `developer finished implementing 'pkt-happy' — proceeding to review`,
    );
    expect(messages).toContain(
      `developer finished finalize on 'pkt-happy'`,
    );
    // And the third transition fires too — pin it as well so the
    // operator-UX contract is fully covered.
    expect(messages).toContain(
      `review complete for 'pkt-happy' — proceeding to finalize`,
    );
  });
});
