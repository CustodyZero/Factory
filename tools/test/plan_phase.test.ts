/**
 * Tests for tools/pipeline/plan_phase.ts.
 *
 * The plan phase is imperative — it shells out to a planner agent in
 * production. To keep tests deterministic and fast we exercise only
 * the deterministic branches that don't actually invoke the agent:
 *
 *   - The "feature already exists for this intent" early return
 *   - The dry-run early return
 *
 * These two branches cover the structural shape of the function
 * (signature, return value, idempotence on a pre-planned intent)
 * without spawning a real provider CLI. The agent-spawn path is
 * exercised end-to-end by the broader pipeline integration tests.
 */

import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPlanPhase } from '../pipeline/plan_phase.js';
import type { FactoryConfig } from '../config.js';
import type { IntentArtifact } from '../plan.js';

function makeIntent(overrides: Partial<IntentArtifact> = {}): IntentArtifact {
  return {
    id: overrides.id ?? 'intent-x',
    title: overrides.title ?? 'A test intent',
    description: overrides.description ?? 'Some description',
    requirements: overrides.requirements ?? [],
    constraints: overrides.constraints ?? [],
    acceptance_criteria: overrides.acceptance_criteria ?? [],
    spec: overrides.spec ?? null,
  } as IntentArtifact;
}

function makeConfig(): FactoryConfig {
  return {
    project_name: 'test',
    factory_dir: '.',
    artifact_dir: '.',
    verification: { build: 'true', lint: 'true', test: 'true' },
    validation: { command: 'true' },
    infrastructure_patterns: [],
    completed_by_default: { kind: 'agent', id: 'test' },
    personas: {
      planner: { description: '', instructions: ['plan well'] },
      developer: { description: '', instructions: [] },
      code_reviewer: { description: '', instructions: [] },
      qa: { description: '', instructions: [] },
    },
  } as FactoryConfig;
}

function setupArtifactRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'plan-phase-'));
  mkdirSync(join(root, 'intents'));
  mkdirSync(join(root, 'features'));
  return root;
}

describe('runPlanPhase — structural shape', () => {
  it('exports a callable named runPlanPhase', () => {
    expect(typeof runPlanPhase).toBe('function');
  });
});

describe('runPlanPhase — pre-existing feature short-circuit', () => {
  it('returns the existing feature_id without invoking an agent when the intent has already been planned', async () => {
    const root = setupArtifactRoot();
    try {
      // Pre-existing feature linked to the intent.
      writeFileSync(
        join(root, 'features', 'feat-1.json'),
        JSON.stringify({
          id: 'feat-1',
          intent_id: 'intent-x',
          status: 'executing',
          packets: [],
        }, null, 2),
        'utf-8',
      );
      writeFileSync(
        join(root, 'intents', 'intent-x.json'),
        JSON.stringify({ id: 'intent-x', title: 't' }, null, 2),
        'utf-8',
      );

      const result = await runPlanPhase({
        intent: makeIntent({ id: 'intent-x' }),
        config: makeConfig(),
        artifactRoot: root,
        dryRun: false, // would otherwise spawn an agent — but the early return triggers first
      });

      expect(result.feature_id).toBe('feat-1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT mutate the intent file when a feature already exists (idempotence)', async () => {
    const root = setupArtifactRoot();
    try {
      writeFileSync(
        join(root, 'features', 'feat-2.json'),
        JSON.stringify({
          id: 'feat-2',
          intent_id: 'intent-y',
          status: 'completed',
          packets: [],
        }, null, 2),
        'utf-8',
      );
      const intentPath = join(root, 'intents', 'intent-y.json');
      const intentBefore = JSON.stringify({ id: 'intent-y', title: 't', status: 'planned' }, null, 2) + '\n';
      writeFileSync(intentPath, intentBefore, 'utf-8');
      const mtimeBefore = statSync(intentPath).mtimeMs;
      const start = Date.now();
      while (Date.now() - start < 20) { /* spin to catch any rewrite */ }

      await runPlanPhase({
        intent: makeIntent({ id: 'intent-y' }),
        config: makeConfig(),
        artifactRoot: root,
        dryRun: false,
      });

      // No rewrite, no mtime change — the early-return path doesn't patch the intent.
      expect(statSync(intentPath).mtimeMs).toBe(mtimeBefore);
      expect(readFileSync(intentPath, 'utf-8')).toBe(intentBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runPlanPhase — dry-run path', () => {
  it('returns { feature_id: null } in dry-run mode without invoking an agent', async () => {
    const root = setupArtifactRoot();
    try {
      // No pre-existing feature; without dry-run this would call the agent.
      writeFileSync(
        join(root, 'intents', 'intent-d.json'),
        JSON.stringify({ id: 'intent-d', title: 't' }, null, 2),
        'utf-8',
      );

      const result = await runPlanPhase({
        intent: makeIntent({ id: 'intent-d' }),
        config: makeConfig(),
        artifactRoot: root,
        dryRun: true,
      });

      expect(result.feature_id).toBeNull();
      // Verify no feature file was created (dry-run must not touch disk).
      expect(() => readFileSync(join(root, 'features', 'feat-d.json'), 'utf-8'))
        .toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not modify the intent file in dry-run mode', async () => {
    const root = setupArtifactRoot();
    try {
      const intentPath = join(root, 'intents', 'intent-dry.json');
      const intentBefore = JSON.stringify({ id: 'intent-dry', title: 't' }, null, 2) + '\n';
      writeFileSync(intentPath, intentBefore, 'utf-8');

      await runPlanPhase({
        intent: makeIntent({ id: 'intent-dry' }),
        config: makeConfig(),
        artifactRoot: root,
        dryRun: true,
      });

      expect(readFileSync(intentPath, 'utf-8')).toBe(intentBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
