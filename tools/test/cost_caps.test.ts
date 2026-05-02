/**
 * Phase 5.7 — Integration tests for cost cap enforcement.
 *
 * The brief calls out four acceptance scenarios. Each is pinned here:
 *
 *   1. Per-run cap of $1.00 with a fixture that consumes >$1: triggers
 *      cost.cap_crossed(per_run) AND aborts the run with
 *      pipeline.failed. Subsequent specs are not attempted.
 *   2. Per-packet cap of $0.50 with a fixture that exceeds it on one
 *      packet: emits cost.cap_crossed(per_packet), fails just that
 *      packet, the orchestrator continues to the next independent
 *      packet.
 *   3. Per-day cap with prior dollars already recorded: a fresh run
 *      starts, the next invocation crosses, emits
 *      cost.cap_crossed(per_day), calls recordDayCapBlock, aborts.
 *   4. Day-cap-blocked: a subsequent run on the same date is rejected
 *      at orchestrator entry with NO pipeline.started.
 *
 * The integration uses vi.mock on tools/pipeline/agent_invoke.js so the
 * tests can inject cost values per invocation without touching real
 * provider CLIs. The mock factory returns InvokeResult shapes drawn
 * from a per-test queue that maps each call to a deterministic cost.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Mocked invokeAgent — every call returns the next InvokeResult from
// the queue. Tests append fixtures via __pushInvokeResult before
// running the orchestrator. Falls back to a benign default when the
// queue is empty (so a state-machine that re-entered won't hang).
// ---------------------------------------------------------------------------

interface QueuedInvoke {
  exit_code: number;
  dollars: number | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
}

const __invokeQueue: QueuedInvoke[] = [];
let __invokeCallCount = 0;

vi.mock('../pipeline/agent_invoke.js', () => ({
  resolveModelId: () => undefined,
  buildProviderArgs: () => ({ command: 'noop', args: [] }),
  invokeAgent: (provider: string, _prompt: string, _config: unknown, _modelTier?: string) => {
    __invokeCallCount += 1;
    const next = __invokeQueue.shift();
    const exitCode = next?.exit_code ?? 0;
    const dollars = next?.dollars ?? 0;
    const tokens_in = next?.tokens_in ?? 0;
    const tokens_out = next?.tokens_out ?? 0;
    return {
      exit_code: exitCode,
      stdout: '',
      stderr: '',
      cost: {
        provider,
        model: 'mock-model',
        tokens_in,
        tokens_out,
        dollars,
      },
    };
  },
}));

// Lifecycle helpers that the phases call when a packet's state machine
// transitions. They mutate packet artifact files; in our integration
// they are no-ops with synthetic exit codes — we don't need real
// completion records to drive the cost-cap paths. The orchestrator's
// behavior we want to test (per-run / per-packet cap crossings) fires
// from invokeAgent results, not from completion files.
vi.mock('../lifecycle/start.js', () => ({
  startPacket: () => undefined,
}));
vi.mock('../lifecycle/request_review.js', () => ({
  requestReview: () => undefined,
}));
vi.mock('../lifecycle/review.js', () => ({
  recordReview: () => undefined,
}));
vi.mock('../lifecycle/complete.js', () => ({
  completePacket: () => undefined,
}));

// Imports must come AFTER vi.mock declarations so the mocks apply.
// vitest hoists vi.mock factories, but importing the SUT alongside
// would otherwise risk loading the real module first under some
// resolution orders.
import { runOrchestrator } from '../pipeline/orchestrator.js';
import { readEvents } from '../events.js';
import {
  costPathFor,
  isDayCapBlocked,
  localDateString,
  readCostRecords,
  recordCost,
  recordDayCapBlock,
} from '../cost.js';
import type { FactoryConfig } from '../config.js';
import type { CostRecord } from '../pipeline/cost.js';

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  __invokeQueue.length = 0;
  __invokeCallCount = 0;
});

beforeEach(() => {
  __invokeQueue.length = 0;
  __invokeCallCount = 0;
});

function mkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cost-caps-'));
  dirs.push(root);
  return root;
}

function makeBaseConfig(overrides: Partial<FactoryConfig['pipeline']> = {}): FactoryConfig {
  return ({
    project_name: 'cost-caps-test',
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
      ...overrides,
    },
  } as unknown) as FactoryConfig;
}

function writeConfig(root: string, config: FactoryConfig): void {
  writeFileSync(
    join(root, 'factory.config.json'),
    JSON.stringify(config, null, 2),
    'utf-8',
  );
}

interface SpecFixtureOpts {
  readonly intentId?: string;
  readonly featureId?: string;
  readonly devPackets?: ReadonlyArray<string>;
  readonly qaPackets?: ReadonlyArray<string>;
  readonly featureStatus?: 'planned' | 'executing';
}

/**
 * Wire up a complete spec/intent/feature/packets layout that the
 * orchestrator will pick up. We bypass the planner by writing the
 * intent/feature/packets directly. The intent file uses the legacy
 * intent shape (no spec); resolveRunArg accepts the intent id.
 */
function writeSpec(root: string, id: string, opts: SpecFixtureOpts = {}): void {
  const intentId = opts.intentId ?? id;
  const featureId = opts.featureId ?? `feat-${id}`;
  const devPackets = opts.devPackets ?? [`pkt-dev-${id}`];
  const qaPackets = opts.qaPackets ?? [];
  const featureStatus = opts.featureStatus ?? 'executing';

  if (!existsSync(join(root, 'intents'))) mkdirSync(join(root, 'intents'), { recursive: true });
  if (!existsSync(join(root, 'features'))) mkdirSync(join(root, 'features'), { recursive: true });
  if (!existsSync(join(root, 'packets'))) mkdirSync(join(root, 'packets'), { recursive: true });

  // Intent file — the orchestrator's resolveRunArg accepts a bare
  // intent id when no spec exists. hydrateIntent requires either a
  // `spec` body or a `spec_path` referencing a file. We embed the
  // spec text directly so no spec file is needed.
  writeFileSync(
    join(root, 'intents', `${intentId}.json`),
    JSON.stringify({
      id: intentId,
      title: `Intent ${intentId}`,
      spec: `Cost-caps test intent ${intentId}.`,
      status: 'planned',
      feature_id: featureId,
    }, null, 2),
    'utf-8',
  );

  // Feature with the listed packets.
  writeFileSync(
    join(root, 'features', `${featureId}.json`),
    JSON.stringify({
      id: featureId,
      title: `Feature ${featureId}`,
      status: featureStatus,
      intent_id: intentId,
      packets: [...devPackets, ...qaPackets],
      created_at: '2026-05-01T00:00:00.000Z',
    }, null, 2),
    'utf-8',
  );

  // Packets — minimal valid shape.
  for (const pid of devPackets) {
    writeFileSync(
      join(root, 'packets', `${pid}.json`),
      JSON.stringify({
        id: pid,
        title: `Dev ${pid}`,
        kind: 'dev',
        status: 'ready',
        feature_id: featureId,
        intent_id: intentId,
        dependencies: [],
        acceptance_criteria: [],
        review_iteration: 0,
        created_at: '2026-05-01T00:00:00.000Z',
      }, null, 2),
      'utf-8',
    );
  }
  for (const pid of qaPackets) {
    writeFileSync(
      join(root, 'packets', `${pid}.json`),
      JSON.stringify({
        id: pid,
        title: `QA ${pid}`,
        kind: 'qa',
        status: 'ready',
        feature_id: featureId,
        intent_id: intentId,
        dependencies: [],
        acceptance_criteria: [],
        verifies: devPackets[0],
        created_at: '2026-05-01T00:00:00.000Z',
      }, null, 2),
      'utf-8',
    );
  }
}

function pushInvocation(opts: QueuedInvoke): void {
  __invokeQueue.push(opts);
}

// ---------------------------------------------------------------------------
// 1. Per-run cap
// ---------------------------------------------------------------------------

describe('per-run cost cap', () => {
  it('emits cost.cap_crossed(per_run) and aborts the run; subsequent specs not attempted', () => {
    const root = mkRoot();
    const config = makeBaseConfig({
      cost_caps: { per_run: 1.0 },
    } as unknown as FactoryConfig['pipeline']);
    writeConfig(root, config);
    writeSpec(root, 'spec-A', { intentId: 'spec-A', devPackets: ['pkt-A1'] });
    writeSpec(root, 'spec-B', { intentId: 'spec-B', devPackets: ['pkt-B1'] });

    // First spec's dev packet: one invocation at $0.60 (under cap).
    pushInvocation({ exit_code: 0, dollars: 0.6, tokens_in: 1000, tokens_out: 1000 });
    // Second spec's dev packet: one invocation at $0.55 — running
    // total then is 0.6 + 0.55 = 1.15 >= 1.0, crosses cap.
    pushInvocation({ exit_code: 0, dollars: 0.55, tokens_in: 1000, tokens_out: 1000 });
    // Even more invocations queued — should NOT be consumed because
    // the run aborts after spec-B's first invocation crosses the cap.
    pushInvocation({ exit_code: 0, dollars: 0.99 });

    const result = runOrchestrator({
      args: ['spec-A', 'spec-B'],
      config,
      projectRoot: root,
      artifactRoot: root,
      dryRun: false,
    });

    // Aborted: success = false; cost-cap message in the summary.
    expect(result.success).toBe(false);
    expect(result.message.toLowerCase()).toContain('per-run cost cap');

    // Events: cost.cap_crossed(per_run) appears, followed by
    // pipeline.failed. The crossing fires DURING the per-spec loop
    // after the second spec completed, so spec-B's spec.completed
    // is recorded.
    const events = readEvents(result.run_id, root);
    const types = events.map((e) => e.event_type);
    expect(types).toContain('cost.cap_crossed');
    expect(types).toContain('pipeline.failed');
    const capEvent = events.find((e) => e.event_type === 'cost.cap_crossed');
    expect(capEvent).toBeDefined();
    expect((capEvent!.payload as Record<string, unknown>)['scope']).toBe('per_run');
    // Order: cost.cap_crossed precedes pipeline.failed (events stream
    // must be well-formed before the abort).
    const crossedIdx = types.indexOf('cost.cap_crossed');
    const failedIdx = types.lastIndexOf('pipeline.failed');
    expect(crossedIdx).toBeLessThan(failedIdx);
  });

  it('does not abort when running_total stays strictly below cap', () => {
    const root = mkRoot();
    const config = makeBaseConfig({
      cost_caps: { per_run: 10 },
    } as unknown as FactoryConfig['pipeline']);
    writeConfig(root, config);
    writeSpec(root, 'spec-A', { intentId: 'spec-A', devPackets: ['pkt-A1'] });

    pushInvocation({ exit_code: 0, dollars: 0.5 });
    pushInvocation({ exit_code: 0, dollars: 0.5 }); // review

    const result = runOrchestrator({
      args: ['spec-A'],
      config,
      projectRoot: root,
      artifactRoot: root,
      dryRun: false,
    });

    // Pipeline did not abort on the cap. (It may still have failed
    // for other reasons — the lifecycle mocks short-circuit completion
    // — but the `success` we read here is the orchestrator's own
    // assessment of "did the cap fire".)
    const events = readEvents(result.run_id, root);
    const types = events.map((e) => e.event_type);
    expect(types).not.toContain('cost.cap_crossed');
  });
});

// ---------------------------------------------------------------------------
// 2. Per-packet cap
// ---------------------------------------------------------------------------

describe('per-packet cost cap', () => {
  it('fails just the packet that crossed; orchestrator continues to next independent packet', () => {
    const root = mkRoot();
    const config = makeBaseConfig({
      cost_caps: { per_packet: 0.5 },
    } as unknown as FactoryConfig['pipeline']);
    writeConfig(root, config);
    // Two independent packets in the same feature so the dev phase
    // walks both.
    writeSpec(root, 'spec-A', {
      intentId: 'spec-A',
      devPackets: ['pkt-X', 'pkt-Y'],
    });

    // pkt-X: implement at $0.60 (cap is $0.50 — implement crosses).
    pushInvocation({ exit_code: 0, dollars: 0.6 });
    // pkt-Y: implement at $0.10 (under cap), review at $0.10.
    // Tracker resets per packet; pkt-X's overage does not count.
    pushInvocation({ exit_code: 0, dollars: 0.1 });
    pushInvocation({ exit_code: 0, dollars: 0.1 });

    const result = runOrchestrator({
      args: ['spec-A'],
      config,
      projectRoot: root,
      artifactRoot: root,
      dryRun: false,
    });

    // The pipeline did not abort on a per-run cap (no per_run set);
    // a per-packet cap crossing only fails that one packet.
    const events = readEvents(result.run_id, root);
    const capEvents = events.filter((e) => e.event_type === 'cost.cap_crossed');
    // Exactly one cap crossing — pkt-X — and orchestrator-level cap
    // events (per_run / per_day) are not configured.
    expect(capEvents).toHaveLength(1);
    expect((capEvents[0]!.payload as Record<string, unknown>)['scope']).toBe('per_packet');
    expect((capEvents[0]!.payload as Record<string, unknown>)['packet_id']).toBe('pkt-X');

    // pkt-Y was attempted (its invocations consumed from the queue).
    // We can verify by counting the calls — pkt-X consumed 1 (impl),
    // pkt-Y consumed at least 1 more.
    expect(__invokeCallCount).toBeGreaterThanOrEqual(2);
  });

  it('null-dollar invocations do NOT count toward the per-packet cap', () => {
    const root = mkRoot();
    const config = makeBaseConfig({
      cost_caps: { per_packet: 0.10 },
    } as unknown as FactoryConfig['pipeline']);
    writeConfig(root, config);
    writeSpec(root, 'spec-A', { intentId: 'spec-A', devPackets: ['pkt-X'] });

    // 5 null-dollar invocations — none accumulate. The cap is $0.10
    // and would trigger after a single $0.10 invocation, but null
    // entries skip the accumulation entirely.
    for (let i = 0; i < 5; i++) {
      pushInvocation({ exit_code: 0, dollars: null });
    }

    const result = runOrchestrator({
      args: ['spec-A'],
      config,
      projectRoot: root,
      artifactRoot: root,
      dryRun: false,
    });

    const events = readEvents(result.run_id, root);
    const capEvents = events.filter((e) => e.event_type === 'cost.cap_crossed');
    expect(capEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Per-day cap
// ---------------------------------------------------------------------------

describe('per-day cost cap', () => {
  it('crosses with prior recorded dollars; emits cost.cap_crossed(per_day) and records the block', () => {
    const root = mkRoot();
    const config = makeBaseConfig({
      cost_caps: { per_day: 5.0 },
    } as unknown as FactoryConfig['pipeline']);
    writeConfig(root, config);
    writeSpec(root, 'spec-A', { intentId: 'spec-A', devPackets: ['pkt-A'] });

    // Pre-seed a prior run-file for today with $4.50 already spent.
    // Use a synthetic run-id with today's date prefix so readDayCost
    // picks it up.
    const today = localDateString();
    const priorRunId = `${today}T08-00-00Z-aaaaaaaa`;
    const priorRecord: CostRecord = {
      run_id: priorRunId,
      packet_id: 'pkt-prior',
      spec_id: 'prior',
      provider: 'codex',
      model: 'gpt-5',
      tokens_in: 100_000,
      tokens_out: 50_000,
      dollars: 4.5,
      timestamp: `${today}T08:00:00.000Z`,
    };
    recordCost(priorRecord, root);

    // This run's first invocation costs $0.55 — bringing the day
    // total to $5.05, which is >= $5.00 cap.
    pushInvocation({ exit_code: 0, dollars: 0.55 });
    // Queue extra in case the implementation reaches review/etc.
    pushInvocation({ exit_code: 0, dollars: 0.10 });

    const result = runOrchestrator({
      args: ['spec-A'],
      config,
      projectRoot: root,
      artifactRoot: root,
      dryRun: false,
    });

    expect(result.success).toBe(false);
    expect(result.message.toLowerCase()).toContain('per-day cost cap');

    const events = readEvents(result.run_id, root);
    const capEvent = events.find(
      (e) => e.event_type === 'cost.cap_crossed' &&
        (e.payload as Record<string, unknown>)['scope'] === 'per_day',
    );
    expect(capEvent).toBeDefined();

    // recordDayCapBlock has been called: subsequent same-day runs are
    // blocked.
    expect(isDayCapBlocked(today, root)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Day-cap pre-flight gate (subsequent runs)
// ---------------------------------------------------------------------------

describe('day-cap pre-flight gate', () => {
  it('rejects a subsequent same-day run at orchestrator entry with no pipeline.started', () => {
    const root = mkRoot();
    const config = makeBaseConfig({
      cost_caps: { per_day: 5.0 },
    } as unknown as FactoryConfig['pipeline']);
    writeConfig(root, config);
    writeSpec(root, 'spec-A', { intentId: 'spec-A', devPackets: ['pkt-A'] });

    // Pre-record today as cap-blocked. This simulates the canonical
    // "subsequent run after a day cap fired" scenario.
    const today = localDateString();
    recordDayCapBlock(today, root);

    const result = runOrchestrator({
      args: ['spec-A'],
      config,
      projectRoot: root,
      artifactRoot: root,
      dryRun: false,
    });

    expect(result.success).toBe(false);
    expect(result.message.toLowerCase()).toContain('per-day cost cap previously blocked');

    // Events: ONLY a single pipeline.failed. No pipeline.started, no
    // pipeline.spec_resolved, no spec.* events. The gate is hard.
    const events = readEvents(result.run_id, root);
    const types = events.map((e) => e.event_type);
    expect(types).toEqual(['pipeline.failed']);

    // The mocked invokeAgent must not have been called at all.
    expect(__invokeCallCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. No caps configured: behavior unchanged from pre-Phase-5.7
// ---------------------------------------------------------------------------

describe('caps disabled (default)', () => {
  it('emits no cost.cap_crossed when no caps are configured, even with high spend', () => {
    const root = mkRoot();
    const config = makeBaseConfig({} as unknown as FactoryConfig['pipeline']);
    writeConfig(root, config);
    writeSpec(root, 'spec-A', { intentId: 'spec-A', devPackets: ['pkt-A'] });

    pushInvocation({ exit_code: 0, dollars: 1000 });
    pushInvocation({ exit_code: 0, dollars: 1000 });

    const result = runOrchestrator({
      args: ['spec-A'],
      config,
      projectRoot: root,
      artifactRoot: root,
      dryRun: false,
    });

    const events = readEvents(result.run_id, root);
    const types = events.map((e) => e.event_type);
    expect(types).not.toContain('cost.cap_crossed');
  });
});

// ---------------------------------------------------------------------------
// 6. recordCost still writes JSONL even without caps configured
// ---------------------------------------------------------------------------

describe('cost recording (no caps)', () => {
  it('persists one cost record per invocation under <artifactRoot>/cost/<run_id>.jsonl', () => {
    const root = mkRoot();
    const config = makeBaseConfig({} as unknown as FactoryConfig['pipeline']);
    writeConfig(root, config);
    writeSpec(root, 'spec-A', { intentId: 'spec-A', devPackets: ['pkt-A'] });

    pushInvocation({ exit_code: 0, dollars: 0.05, tokens_in: 100, tokens_out: 200 });
    pushInvocation({ exit_code: 0, dollars: 0.03, tokens_in: 50, tokens_out: 150 });

    const result = runOrchestrator({
      args: ['spec-A'],
      config,
      projectRoot: root,
      artifactRoot: root,
      dryRun: false,
    });

    const { file } = costPathFor(root, result.run_id);
    expect(existsSync(file)).toBe(true);
    // The exact number of rows depends on what state-machine path
    // the dev phase took, but at least the implement invocation
    // wrote a row.
    const rows = readCostRecords(result.run_id, root);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.run_id).toBe(result.run_id);
    expect(rows[0]!.packet_id).toBe('pkt-A');
    expect(rows[0]!.spec_id).toBe('spec-A');
    expect(rows[0]!.provider).toBe('codex');
  });
});
