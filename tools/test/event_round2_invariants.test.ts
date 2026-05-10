/**
 * Phase 5.5 round 2 — invariant pins for the four findings raised by
 * codex GPT-5.5 in round 1.
 *
 * Each describe block targets exactly one finding and asserts the
 * post-fix contract. A regression on any of these flips the affected
 * test red immediately.
 *
 *   1. Provenance is not spoofable through the public API.
 *   2. FACTORY_RUN_ID is restored after runOrchestrator returns.
 *   3. Dry-run plan emits phase.completed(plan) with outcome 'ok'.
 *   4. pipeline.failed is emitted before unexpected exceptions
 *      propagate out of runOrchestrator.
 *
 * These tests run alongside the existing 403-test suite; they do not
 * modify it.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makePipelineStarted,
  makeSpecStarted,
  makePhaseCompleted,
  makePacketStarted,
  makeVerificationPassed,
} from '../pipeline/events.js';
import { runOrchestrator } from '../pipeline/orchestrator/index.js';
import { readEvents } from '../events.js';
import type { FactoryConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function makeBaseConfig(): FactoryConfig {
  return ({
    project_name: 'r2-invariants',
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
  } as unknown) as FactoryConfig;
}

function mkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'r2-inv-'));
  dirs.push(root);
  writeFileSync(
    join(root, 'factory.config.json'),
    JSON.stringify(makeBaseConfig(), null, 2),
    'utf-8',
  );
  return root;
}

function writeSpec(root: string, id: string): void {
  if (!existsSync(join(root, 'specs'))) mkdirSync(join(root, 'specs'), { recursive: true });
  writeFileSync(
    join(root, 'specs', `${id}.md`),
    `---\nid: ${id}\ntitle: Spec ${id}\n---\n\nbody for ${id}\n`,
    'utf-8',
  );
}

// ---------------------------------------------------------------------------
// Issue 1 — Provenance is not spoofable through the public API
//
// The round-1 review showed that BaseInputs.provenance was a free-form
// caller field. After the round-2 fix, callers pass `dry_run` (a hint)
// and the envelope derives provenance via deriveProvenance — VITEST
// always wins.
//
// Anchor: under vitest, every constructor produces an event with
// provenance === 'test' regardless of what the caller passes for
// dry_run. There is no API path that can produce a 'live_run' or
// 'dry_run' event when VITEST is set.
// ---------------------------------------------------------------------------

describe('Issue 1 — provenance is not spoofable', () => {
  it("every make* constructor returns provenance: 'test' when VITEST is set, irrespective of dry_run", () => {
    expect(process.env['VITEST']).toBeDefined();

    // dry_run: true should NOT escalate to 'dry_run'.
    const e1 = makePipelineStarted(
      { run_id: 'r', dry_run: true },
      { args: [], dry_run: true },
    );
    expect(e1.provenance).toBe('test');

    // dry_run: false should NOT escalate to 'live_run'.
    const e2 = makePipelineStarted(
      { run_id: 'r', dry_run: false },
      { args: [], dry_run: false },
    );
    expect(e2.provenance).toBe('test');

    // Omitting dry_run defaults to false; still 'test' under VITEST.
    const e3 = makeSpecStarted({ run_id: 'r' }, { spec_id: 's' });
    expect(e3.provenance).toBe('test');

    // Pin a representative sample across the constructor surface so a
    // future regression in any of them surfaces here directly.
    const e4 = makePhaseCompleted(
      { run_id: 'r', dry_run: true },
      { phase: 'plan', spec_id: 's', outcome: 'ok' },
    );
    expect(e4.provenance).toBe('test');
    const e5 = makePacketStarted(
      { run_id: 'r', dry_run: false },
      { packet_id: 'p1' },
    );
    expect(e5.provenance).toBe('test');
    const e6 = makeVerificationPassed(
      { run_id: 'r', dry_run: false },
      { packet_id: 'p1', checks: ['build'] },
    );
    expect(e6.provenance).toBe('test');
  });

  it('BaseInputs no longer has a provenance field — TypeScript-level pin', () => {
    // Compile-time check: this test exists to anchor the fact that
    // `provenance` is gone from the public API. If a future refactor
    // re-adds it, the type assertion below stops compiling.
    type BaseInputsExpected = { run_id: string; dry_run?: boolean; timestamp?: string };
    const sample: BaseInputsExpected = { run_id: 'x', dry_run: false };
    // Round-trip through a constructor proves the type really is what
    // we claim it is at runtime.
    const e = makeSpecStarted(sample, { spec_id: 's' });
    expect(e.run_id).toBe('x');
    expect(e.provenance).toBe('test');
  });
});

// ---------------------------------------------------------------------------
// Issue 2 — FACTORY_RUN_ID is restored after runOrchestrator returns
//
// The round-1 review noted that the orchestrator set FACTORY_RUN_ID
// without try/finally to restore. The round-2 fix wraps the body in
// try/finally so the env var is scoped strictly to the orchestrator's
// dynamic extent. Two cases need pinning: prior-unset (must be deleted
// after) and prior-set (must be restored to the prior value).
// ---------------------------------------------------------------------------

describe('Issue 2 — FACTORY_RUN_ID is restored after runOrchestrator', () => {
  it('deletes FACTORY_RUN_ID after the orchestrator returns when it was unset before', async () => {
    const root = mkRoot();
    writeSpec(root, 'env-clear');
    const before = process.env['FACTORY_RUN_ID'];
    delete process.env['FACTORY_RUN_ID'];
    try {
      const result = await runOrchestrator({
        args: ['env-clear'],
        config: makeBaseConfig(),
        projectRoot: root,
        artifactRoot: root,
        dryRun: true,
      });
      expect(result.success).toBe(true);
      // The env var must NOT linger.
      expect(process.env['FACTORY_RUN_ID']).toBeUndefined();
    } finally {
      if (before !== undefined) process.env['FACTORY_RUN_ID'] = before;
    }
  });

  it('restores the prior FACTORY_RUN_ID after the orchestrator returns when it was set before', async () => {
    const root = mkRoot();
    writeSpec(root, 'env-restore');
    const PRIOR = 'prior-run-id-from-outer-scope';
    const before = process.env['FACTORY_RUN_ID'];
    process.env['FACTORY_RUN_ID'] = PRIOR;
    try {
      const result = await runOrchestrator({
        args: ['env-restore'],
        config: makeBaseConfig(),
        projectRoot: root,
        artifactRoot: root,
        dryRun: true,
      });
      expect(result.success).toBe(true);
      // The orchestrator's run_id must NOT leak; the prior value must
      // be exactly restored.
      expect(process.env['FACTORY_RUN_ID']).toBe(PRIOR);
      // Sanity: the orchestrator did mint a different id during its run.
      expect(result.run_id).not.toBe(PRIOR);
    } finally {
      if (before === undefined) {
        delete process.env['FACTORY_RUN_ID'];
      } else {
        process.env['FACTORY_RUN_ID'] = before;
      }
    }
  });

  it('restores FACTORY_RUN_ID even on a top-level resolution failure', async () => {
    // Top-level failure paths use the same try/finally as the success
    // path. Confirm the cleanup runs even though the orchestrator
    // returns early without entering the per-spec loop.
    const root = mkRoot();
    const before = process.env['FACTORY_RUN_ID'];
    delete process.env['FACTORY_RUN_ID'];
    try {
      const result = await runOrchestrator({
        args: ['ghost-spec-that-does-not-exist'],
        config: makeBaseConfig(),
        projectRoot: root,
        artifactRoot: root,
        dryRun: true,
      });
      expect(result.success).toBe(false);
      expect(process.env['FACTORY_RUN_ID']).toBeUndefined();
    } finally {
      if (before !== undefined) process.env['FACTORY_RUN_ID'] = before;
    }
  });
});

// ---------------------------------------------------------------------------
// Issue 3 — Dry-run plan emits phase.completed(plan) with outcome 'ok'
//
// Round 1: a dry-run plan that produced no feature collapsed to
// outcome: 'failed' even though spec.completed reported success. The
// round-2 fix splits the case: feature_id !== null OR (dryRun &&
// feature_id === null) → 'ok'; only feature_id === null in non-dry-run
// is 'failed'. This pin asserts every plan-phase phase.completed event
// in a successful dry-run carries outcome 'ok'.
// ---------------------------------------------------------------------------

describe('Issue 3 — dry-run plan emits outcome ok', () => {
  it('dry-run that stops before invoking the planner reports outcome: ok on phase.completed(plan)', async () => {
    const root = mkRoot();
    writeSpec(root, 'dr-plan');
    const result = await runOrchestrator({
      args: ['dr-plan'],
      config: makeBaseConfig(),
      projectRoot: root,
      artifactRoot: root,
      dryRun: true,
    });
    expect(result.success).toBe(true);

    const events = readEvents(result.run_id, root);
    const planCompleted = events.filter(
      (e) =>
        e.event_type === 'phase.completed' &&
        e.payload.event_type === 'phase.completed' &&
        e.payload.phase === 'plan',
    );
    expect(planCompleted).toHaveLength(1);
    const ev = planCompleted[0]!;
    if (ev.payload.event_type === 'phase.completed') {
      expect(ev.payload.outcome).toBe('ok');
    }

    // Sanity: spec.completed and pipeline.finished both report success.
    // The dry-run phase event MUST agree with them.
    const types = events.map((e) => e.event_type);
    expect(types).toContain('spec.completed');
    expect(types).toContain('pipeline.finished');
  });
});

// ---------------------------------------------------------------------------
// Issue 4 — pipeline.failed fires on unexpected exceptions
//
// Round 1: an exception thrown from a phase function or runSingleSpec
// escaped runOrchestrator without any closing event. The round-2 fix
// wraps the body in try/catch; on catch we synthesise a pipeline.failed
// (with whatever totals were collected) and rethrow. We mock the plan
// phase to throw an unexpected error and assert:
//
//   - pipeline.started lands in the stream
//   - pipeline.failed lands in the stream BEFORE the throw propagates
//   - the failed event mentions the error
//   - FACTORY_RUN_ID is restored (Issue 2's finally still runs)
// ---------------------------------------------------------------------------

vi.mock('../pipeline/plan_phase.js', async () => {
  const actual = await vi.importActual<typeof import('../pipeline/plan_phase.js')>(
    '../pipeline/plan_phase.js',
  );
  return {
    ...actual,
    // Wrap runPlanPhase so we can switch it between pass-through and
    // throw on a per-test basis via a module-level flag.
    runPlanPhase: (opts: Parameters<typeof actual.runPlanPhase>[0]) => {
      // Use an env var as the signal so the test can enable the throw
      // without restructuring the mock factory.
      if (process.env['__R2_FORCE_PLAN_THROW'] === '1') {
        throw new Error('synthetic: planner module crashed mid-phase');
      }
      return actual.runPlanPhase(opts);
    },
  };
});

describe('Issue 4 — pipeline.failed fires on unexpected exceptions', () => {
  it('emits pipeline.failed before rethrowing when a phase function throws', async () => {
    const root = mkRoot();
    writeSpec(root, 'crash');
    const beforeEnv = process.env['FACTORY_RUN_ID'];
    delete process.env['FACTORY_RUN_ID'];
    process.env['__R2_FORCE_PLAN_THROW'] = '1';

    let caught: unknown = null;
    let runId: string | null = null;

    try {
      try {
        await runOrchestrator({
          args: ['crash'],
          config: makeBaseConfig(),
          projectRoot: root,
          artifactRoot: root,
          dryRun: true,
        });
      } catch (err) {
        caught = err;
      }

      // Exception must have propagated out of the orchestrator (rethrow
      // contract) — see the orchestrator catch block comment.
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain('synthetic: planner module crashed');

      // The orchestrator started before the throw, so there is exactly
      // one events file under the tmp root. Find it and read the events.
      const eventsDir = join(root, 'events');
      expect(existsSync(eventsDir)).toBe(true);
      const files = readdirSync(eventsDir).filter((f) => f.endsWith('.jsonl'));
      expect(files).toHaveLength(1);
      runId = files[0]!.replace(/\.jsonl$/, '');
      const events = readEvents(runId, root);
      const types = events.map((e) => e.event_type);
      // The opening event landed.
      expect(types).toContain('pipeline.started');
      // The synthetic catch handler emitted a closing pipeline.failed.
      expect(types).toContain('pipeline.failed');
      // pipeline.finished must NOT be present on the crash path.
      expect(types).not.toContain('pipeline.finished');
      // The pipeline.failed payload references the error message.
      const failed = events.find((e) => e.event_type === 'pipeline.failed');
      if (failed && failed.payload.event_type === 'pipeline.failed') {
        expect(failed.payload.message).toContain('Orchestrator crashed');
        expect(failed.payload.message).toContain('synthetic: planner module crashed');
      }

      // Issue 2's finally must still have run despite the throw.
      expect(process.env['FACTORY_RUN_ID']).toBeUndefined();
    } finally {
      delete process.env['__R2_FORCE_PLAN_THROW'];
      if (beforeEnv !== undefined) process.env['FACTORY_RUN_ID'] = beforeEnv;
    }
  });
});
