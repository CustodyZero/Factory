/**
 * Phase 7 — Integration tests for the cross-CLI / within-CLI
 * provider cascade as exercised through `runDevelopPhase`.
 *
 * Pins:
 *   - persona_providers = ['copilot', 'claude', 'codex'] with the
 *     PRIMARY (copilot) failing ProviderUnavailable: cascade walks
 *     to 'claude'; that hop succeeds; packet completes
 *   - copilot.model_failover = ['claude-opus-4-6', 'GPT-5.4'] +
 *     persona_providers = ['copilot', 'codex']: within-CLI
 *     failover happens BEFORE falling through to codex
 *   - Direct provider (codex with no model_failover) failing in
 *     the cascade goes straight to the next CLI without trying
 *     alternate models
 *   - Backward compatibility: persona_providers.developer = ['codex']
 *     (single-element list, equivalent to the legacy single-string
 *     "codex" form after normalization) cannot fail over and
 *     escalates with a cascade-exhausted reason on the first
 *     ProviderUnavailable failure
 *   - ProviderTransient exhaustion reclassifies to ProviderUnavailable
 *     and triggers the cascade through the phase boundary
 *
 * Like `develop_phase_recovery.test.ts`, these tests mock
 * `invokeAgent` so we drive every cascade dispatch deterministically
 * without spawning real CLIs.
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

// ---------------------------------------------------------------------------
// invokeAgent mock — captures (provider, model, prompt) per call so
// each test can drive cascade hops deterministically.
// ---------------------------------------------------------------------------

interface InvokeOutcome {
  readonly exit_code: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly model?: string | null;
}

interface InvokeCall {
  readonly provider: string;
  readonly model: string | null;
  readonly prompt: string;
}

const __invokeQueue: InvokeOutcome[] = [];
const __invokeCalls: InvokeCall[] = [];
// Convergence pass — the post-Phase-8 control flow no longer
// silently force-approves when the reviewer agent exits 0 without
// recording a verdict. To keep the existing happy-path cascade
// fixtures running, the invokeAgent mock now mirrors the real
// reviewer behavior: when the prompt is a review prompt AND the
// invocation succeeds (exit_code 0), the mock writes packet
// status='review_approved' to the artifact tree using the per-test
// root configured below. Tests that want to exercise the
// no-decision path explicitly disable this auto-approve via
// __reviewerAutoApprove=false.
let __reviewerArtifactRoot: string | null = null;
let __reviewerAutoApprove = true;

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
    const model = next.model !== undefined ? next.model : (modelOverride ?? null);
    __invokeCalls.push({ provider, model, prompt });
    // Mirror the real reviewer-calls-review.ts behavior on the
    // happy path. The reviewer prompt is the only one that begins
    // with "You are a code reviewer" — see prompts.ts:buildReviewPrompt.
    if (
      next.exit_code === 0 &&
      __reviewerAutoApprove &&
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
      stdout: next.stdout ?? '',
      stderr: next.stderr ?? '',
      cost: {
        provider,
        model,
        tokens_in: 100,
        tokens_out: 50,
        dollars: 0.01,
      },
    };
  },
}));

// completePacket mock — atomic: ci_pass=true writes record + sets
// status=completed; ci_pass=false leaves disk untouched. Mirrors
// real lifecycle code per Phase 6 round-2.
interface CompleteOutcome {
  readonly already_complete?: boolean;
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
    const next = __completeQueue.shift();
    const outcome: CompleteOutcome = next === undefined
      ? { ci_pass: true, build_pass: true, lint_pass: true, tests_pass: true }
      : next;
    if (outcome.ci_pass && typeof projectRoot === 'string') {
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
      ci_pass: outcome.ci_pass,
      build_pass: outcome.build_pass,
      lint_pass: outcome.lint_pass,
      tests_pass: outcome.tests_pass,
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
import type { FactoryConfig, PipelineProvider } from '../config.js';
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
});

beforeEach(() => {
  __invokeCalls.length = 0;
  __invokeQueue.length = 0;
  __completeQueue.length = 0;
  __reviewerArtifactRoot = null;
  __reviewerAutoApprove = true;
});

function mkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'develop-cascade-'));
  for (const d of ['packets', 'completions', 'features', 'events']) {
    if (!existsSync(join(root, d))) mkdirSync(join(root, d), { recursive: true });
  }
  dirs.push(root);
  // Wire the per-test reviewer-auto-approve mock to this root so the
  // invokeAgent mock can mirror the real reviewer-calls-review.ts
  // behavior on the happy path.
  __reviewerArtifactRoot = root;
  return root;
}

interface ConfigOverrides {
  readonly developerProviders?: ReadonlyArray<PipelineProvider>;
  readonly copilotModelFailover?: ReadonlyArray<string>;
  readonly codexModelFailover?: ReadonlyArray<string>;
  readonly claudeModelFailover?: ReadonlyArray<string>;
}

function makeConfig(overrides: ConfigOverrides = {}): FactoryConfig {
  return ({
    project_name: 'cascade-it',
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
        codex: {
          enabled: true,
          command: 'codex',
          ...(overrides.codexModelFailover !== undefined
            ? { model_failover: overrides.codexModelFailover }
            : {}),
        },
        claude: {
          enabled: true,
          command: 'claude',
          ...(overrides.claudeModelFailover !== undefined
            ? { model_failover: overrides.claudeModelFailover }
            : {}),
        },
        copilot: {
          enabled: true,
          command: 'gh',
          prefix_args: ['copilot', '--'],
          model_map: { high: 'claude-opus-4-6', medium: 'GPT-5.4', low: 'claude-haiku-4-5' },
          ...(overrides.copilotModelFailover !== undefined
            ? { model_failover: overrides.copilotModelFailover }
            : {}),
        },
      },
      persona_providers: {
        planner: ['claude'],
        developer: overrides.developerProviders ?? ['codex'],
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

function writeFeature(root: string, id: string, packets: string[]): Feature {
  return {
    id,
    intent: 'cascade-it',
    status: 'executing',
    packets,
    created_by: { kind: 'agent', id: 'test' },
  } as Feature;
}

const noopGit: GitRunner = () => ({ exitCode: 0, stdout: '', stderr: '' });

// ---------------------------------------------------------------------------
// Cross-CLI cascade — multi-element persona_providers
// ---------------------------------------------------------------------------

describe('runDevelopPhase — Phase 7 cross-CLI cascade', () => {
  it('persona_providers = [copilot, claude, codex]: primary (copilot) ProviderUnavailable -> falls through to claude -> succeeds', async () => {
    const root = mkRoot();
    writePacket(root, 'pkt-cross', { status: 'ready', started_at: '2024-01-01T00:00:00Z' });
    // Implement closure: copilot fails ProviderUnavailable, claude succeeds.
    __invokeQueue.push({ exit_code: 1, stderr: "Provider 'copilot' is disabled" });
    __invokeQueue.push({ exit_code: 0 });
    // Reviewer runs (claude), then complete on success.
    __invokeQueue.push({ exit_code: 0 });

    const result = await runDevelopPhase({
      feature: writeFeature(root, 'feat-x', ['pkt-cross']),
      config: makeConfig({ developerProviders: ['copilot', 'claude', 'codex'] }),
      artifactRoot: root,
      projectRoot: root,
      dryRun: false,
      runId: 'run-cross',
      specId: 'spec-x',
      gitRunner: noopGit,
    });
    expect(result.completed).toEqual(['pkt-cross']);
    // First call hit copilot (primary); second hit claude (cascade hop).
    const devCalls = __invokeCalls.filter(
      (c) => c.provider === 'copilot' || c.provider === 'claude' || c.provider === 'codex',
    );
    // First two calls are the implement closure (cascade hops).
    expect(devCalls[0]?.provider).toBe('copilot');
    expect(devCalls[1]?.provider).toBe('claude');
  });

  it('cascade exhausted (all CLIs in persona_providers fail): packet escalates with cascade-exhausted reason', async () => {
    const root = mkRoot();
    writePacket(root, 'pkt-exhausted', { status: 'ready', started_at: '2024-01-01T00:00:00Z' });
    // All three CLIs fail ProviderUnavailable.
    __invokeQueue.push({ exit_code: 1, stderr: "Provider 'copilot' is disabled" });
    __invokeQueue.push({ exit_code: 1, stderr: "Provider 'claude' is disabled" });
    __invokeQueue.push({ exit_code: 1, stderr: "Provider 'codex' is disabled" });

    const result = await runDevelopPhase({
      feature: writeFeature(root, 'feat-x', ['pkt-exhausted']),
      config: makeConfig({ developerProviders: ['copilot', 'claude', 'codex'] }),
      artifactRoot: root,
      projectRoot: root,
      dryRun: false,
      runId: 'run-exhausted',
      specId: 'spec-x',
      gitRunner: noopGit,
    });
    expect(result.failed).toEqual(['pkt-exhausted']);
    // Packet stamped with the cascade-exhausted failure reason.
    const packet = JSON.parse(readFileSync(join(root, 'packets', 'pkt-exhausted.json'), 'utf-8')) as Record<string, unknown>;
    const failure = packet['failure'] as Record<string, unknown>;
    expect(failure['scenario']).toBe('ProviderUnavailable');
    expect(String(failure['reason'])).toMatch(/cascade exhausted/i);
    expect(String(failure['reason'])).toContain('copilot');
    expect(String(failure['reason'])).toContain('claude');
    expect(String(failure['reason'])).toContain('codex');
  });

  it('direct providers (codex, claude) without model_failover go straight to next CLI without alternates', async () => {
    const root = mkRoot();
    writePacket(root, 'pkt-direct', { status: 'ready', started_at: '2024-01-01T00:00:00Z' });
    // codex fails; claude succeeds. With NO model_failover on either,
    // each CLI gets exactly ONE attempt before the cascade advances.
    __invokeQueue.push({ exit_code: 1, stderr: "Provider 'codex' is disabled" });
    __invokeQueue.push({ exit_code: 0 });
    __invokeQueue.push({ exit_code: 0 }); // reviewer

    const result = await runDevelopPhase({
      feature: writeFeature(root, 'feat-x', ['pkt-direct']),
      config: makeConfig({ developerProviders: ['codex', 'claude'] }),
      artifactRoot: root,
      projectRoot: root,
      dryRun: false,
      runId: 'run-direct',
      specId: 'spec-x',
      gitRunner: noopGit,
    });
    expect(result.completed).toEqual(['pkt-direct']);
    // EXACTLY 2 dev-agent calls in the implement step: one to codex
    // (primary, fails) and one to claude (cascade hop, succeeds). No
    // within-CLI alternates because neither provider had model_failover.
    const devCalls = __invokeCalls.filter(
      (c) => c.provider === 'codex' || c.provider === 'claude',
    );
    // First two calls = implement; the 3rd is reviewer (also claude).
    expect(devCalls[0]?.provider).toBe('codex');
    expect(devCalls[1]?.provider).toBe('claude');
  });
});

// ---------------------------------------------------------------------------
// Within-CLI cascade — copilot model_failover
// ---------------------------------------------------------------------------

describe('runDevelopPhase — Phase 7 within-CLI cascade', () => {
  it('copilot.model_failover = [claude-opus-4-6, GPT-5.4]: first model fails -> second model on same CLI succeeds (no fall-through to codex)', async () => {
    const root = mkRoot();
    writePacket(root, 'pkt-within', { status: 'ready', started_at: '2024-01-01T00:00:00Z' });
    // First copilot model fails; second copilot model succeeds.
    __invokeQueue.push({ exit_code: 1, stderr: "Provider 'copilot' is disabled", model: 'claude-opus-4-6' });
    __invokeQueue.push({ exit_code: 0, model: 'GPT-5.4' });
    __invokeQueue.push({ exit_code: 0 }); // reviewer

    const result = await runDevelopPhase({
      feature: writeFeature(root, 'feat-x', ['pkt-within']),
      config: makeConfig({
        developerProviders: ['copilot', 'codex'],
        copilotModelFailover: ['claude-opus-4-6', 'GPT-5.4'],
      }),
      artifactRoot: root,
      projectRoot: root,
      dryRun: false,
      runId: 'run-within',
      specId: 'spec-x',
      gitRunner: noopGit,
    });
    expect(result.completed).toEqual(['pkt-within']);

    // Both implement-step calls hit copilot — the within-CLI failover
    // happened on the same CLI before any cross-CLI hop. Specifically:
    //   call 1: copilot @ claude-opus-4-6 (primary, fails)
    //   call 2: copilot @ GPT-5.4         (within-CLI hop, succeeds)
    const devCalls = __invokeCalls.filter((c) => c.provider === 'copilot');
    expect(devCalls.length).toBe(2);
    expect(devCalls[0]?.model).toBe('claude-opus-4-6');
    expect(devCalls[1]?.model).toBe('GPT-5.4');
    // codex never hit during implement step.
    const codexCalls = __invokeCalls.filter((c) => c.provider === 'codex');
    expect(codexCalls.length).toBe(0);
  });

  it('within-CLI exhausted -> falls through to next CLI in persona_providers', async () => {
    const root = mkRoot();
    writePacket(root, 'pkt-mixed', { status: 'ready', started_at: '2024-01-01T00:00:00Z' });
    // Both copilot models fail; codex succeeds. We tag each queued
    // outcome with the model id so the test mock surfaces it back
    // through cost.model — replacing the mocked resolveModelId
    // (which returns undefined) for the primary attempt only.
    // Cascade hops come through the modelOverride path and the
    // mock already records that.
    __invokeQueue.push({ exit_code: 1, stderr: "Provider 'copilot' is disabled", model: 'claude-opus-4-6' });
    __invokeQueue.push({ exit_code: 1, stderr: "Provider 'copilot' is disabled" }); // cascade hop -> override observed
    __invokeQueue.push({ exit_code: 0 }); // codex hop
    __invokeQueue.push({ exit_code: 0 }); // reviewer

    const result = await runDevelopPhase({
      feature: writeFeature(root, 'feat-x', ['pkt-mixed']),
      config: makeConfig({
        developerProviders: ['copilot', 'codex'],
        copilotModelFailover: ['claude-opus-4-6', 'GPT-5.4'],
      }),
      artifactRoot: root,
      projectRoot: root,
      dryRun: false,
      runId: 'run-mixed',
      specId: 'spec-x',
      gitRunner: noopGit,
    });
    expect(result.completed).toEqual(['pkt-mixed']);

    // Two copilot attempts (within-CLI failover), then one codex
    // attempt (cross-CLI hop) — in that order.
    const orderedDev: string[] = [];
    for (const c of __invokeCalls) {
      if (c.provider === 'copilot' || c.provider === 'codex') {
        orderedDev.push(`${c.provider}:${c.model ?? ''}`);
      }
    }
    expect(orderedDev[0]).toBe('copilot:claude-opus-4-6');
    expect(orderedDev[1]).toBe('copilot:GPT-5.4');
    expect(orderedDev[2]?.startsWith('codex:')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 7 round-2 fix — primary invocation must use cascade[0]
//
// Pin that when `model_map[tier] !== model_failover[0]`, the FIRST
// invokeAgent call for the implement closure is sent to
// model_failover[0] (i.e. cascade[0].model), NOT model_map[tier].
//
// Before the fix, the closure invoked the primary as
//   invokeAgent(devProvider, prompt, config, devTier)
// — no modelOverride — so the resolved model was model_map[tier].
// Recovery would then fire cascade[1] thinking cascade[0] was
// already attempted, having silently skipped model_failover[0].
//
// The test fixture deliberately differs the two so the bug is
// observable: model_map.high='fast-model' but
// model_failover=['careful-model','backup-model']. The first
// invokeAgent call must record 'careful-model' as the model.
// ---------------------------------------------------------------------------

describe('runDevelopPhase — Phase 7 round-2: primary uses cascade[0]', () => {
  it("model_map[high]='fast-model' but model_failover=['careful-model',...]: FIRST invokeAgent call uses 'careful-model'", async () => {
    const root = mkRoot();
    writePacket(root, 'pkt-primary', { status: 'ready', started_at: '2024-01-01T00:00:00Z' });
    // The primary attempt succeeds. We want to assert the model id
    // the closure passed to invokeAgent on the FIRST call, so we
    // intentionally do NOT pre-set `model` on the queued outcome —
    // the mock falls back to whatever modelOverride was supplied.
    __invokeQueue.push({ exit_code: 0 });
    __invokeQueue.push({ exit_code: 0 }); // reviewer

    // Build a config where copilot has BOTH a model_map AND a
    // model_failover, with DIFFERENT first entries — this is the
    // shape the bug silently miscounted.
    const config = makeConfig({
      developerProviders: ['copilot'],
      copilotModelFailover: ['careful-model', 'backup-model'],
    }) as unknown as Record<string, unknown>;
    // Override model_map.high to a third id distinct from
    // model_failover[0]. The fixture's makeConfig already sets
    // model_map = { high: 'claude-opus-4-6', medium: 'GPT-5.4', low: '...' }
    // so we re-write model_map.high to 'fast-model'.
    const pipeline = config['pipeline'] as Record<string, unknown>;
    const providers = pipeline['providers'] as Record<string, unknown>;
    const copilot = providers['copilot'] as Record<string, unknown>;
    copilot['model_map'] = { high: 'fast-model', medium: 'fast-model', low: 'fast-model' };

    const result = await runDevelopPhase({
      feature: writeFeature(root, 'feat-x', ['pkt-primary']),
      config: config as unknown as FactoryConfig,
      artifactRoot: root,
      projectRoot: root,
      dryRun: false,
      runId: 'run-primary',
      specId: 'spec-x',
      gitRunner: noopGit,
    });
    expect(result.completed).toEqual(['pkt-primary']);

    // FIRST invokeAgent call = primary attempt of the implement
    // closure. It MUST record model='careful-model' (cascade[0].model
    // = model_failover[0]), NOT 'fast-model' (model_map[high]).
    expect(__invokeCalls.length).toBeGreaterThan(0);
    expect(__invokeCalls[0]?.provider).toBe('copilot');
    expect(__invokeCalls[0]?.model).toBe('careful-model');
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility — single-element persona_providers
// ---------------------------------------------------------------------------

describe('runDevelopPhase — Phase 7 backward compat', () => {
  it('persona_providers = [codex] (single element, equivalent to legacy "codex" string): cascade has only one entry; immediate ProviderUnavailable escalates', async () => {
    const root = mkRoot();
    writePacket(root, 'pkt-legacy', { status: 'ready', started_at: '2024-01-01T00:00:00Z' });
    // The single CLI fails ProviderUnavailable; cascade is exhausted
    // after the primary -> escalate.
    __invokeQueue.push({ exit_code: 1, stderr: "Provider 'codex' is disabled" });

    const result = await runDevelopPhase({
      feature: writeFeature(root, 'feat-x', ['pkt-legacy']),
      config: makeConfig({ developerProviders: ['codex'] }),
      artifactRoot: root,
      projectRoot: root,
      dryRun: false,
      runId: 'run-legacy',
      specId: 'spec-x',
      gitRunner: noopGit,
    });
    expect(result.failed).toEqual(['pkt-legacy']);
    // Pin the on-disk failure shape: scenario + cascade-exhausted reason.
    const packet = JSON.parse(readFileSync(join(root, 'packets', 'pkt-legacy.json'), 'utf-8')) as Record<string, unknown>;
    const failure = packet['failure'] as Record<string, unknown>;
    expect(failure['scenario']).toBe('ProviderUnavailable');
    expect(String(failure['reason'])).toMatch(/cascade exhausted/i);
  });
});

// ---------------------------------------------------------------------------
// ProviderTransient -> ProviderUnavailable reclassification at the
// phase boundary
// ---------------------------------------------------------------------------

describe('runDevelopPhase — Phase 7 transient exhaustion -> cascade', () => {
  it('5xx -> 2 retries fail -> reclassified as ProviderUnavailable -> cascade fires -> succeeds on 2nd hop', async () => {
    const root = mkRoot();
    writePacket(root, 'pkt-reclass', { status: 'ready', started_at: '2024-01-01T00:00:00Z' });
    // 3 transient failures consume the budget; reclassification
    // hands off to ProviderUnavailable; cascade[1] (claude) succeeds.
    __invokeQueue.push({ exit_code: 1, stderr: 'HTTP 503 Service Unavailable' });
    __invokeQueue.push({ exit_code: 1, stderr: 'HTTP 503 Service Unavailable' });
    __invokeQueue.push({ exit_code: 1, stderr: 'HTTP 503 Service Unavailable' });
    __invokeQueue.push({ exit_code: 0 });
    __invokeQueue.push({ exit_code: 0 }); // reviewer

    const result = await runDevelopPhase({
      feature: writeFeature(root, 'feat-x', ['pkt-reclass']),
      config: makeConfig({ developerProviders: ['codex', 'claude'] }),
      artifactRoot: root,
      projectRoot: root,
      dryRun: false,
      runId: 'run-reclass',
      specId: 'spec-x',
      gitRunner: noopGit,
    });
    expect(result.completed).toEqual(['pkt-reclass']);
    // 3 codex attempts (primary + 2 transient retries), then 1 claude
    // (cascade hop).
    const orderedDev: string[] = [];
    for (const c of __invokeCalls) {
      if (c.provider === 'codex' || c.provider === 'claude') {
        orderedDev.push(c.provider);
      }
    }
    expect(orderedDev[0]).toBe('codex');
    expect(orderedDev[1]).toBe('codex');
    expect(orderedDev[2]).toBe('codex');
    expect(orderedDev[3]).toBe('claude');
  });
});
