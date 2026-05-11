/**
 * Cross-phase integration test for Phase 4.5.
 *
 * Confirms that a coordinator can call runPlanPhase, runDevelopPhase,
 * and runVerifyPhase in sequence against a single fixture and the
 * three phases produce the documented result shapes. We use dry-run
 * mode and a pre-planned feature so no agent is invoked.
 *
 * The point is to pin the wiring contract that run.ts depends on
 * after Phase 4.5: each phase is independently invokable, takes its
 * documented options shape, returns its documented result shape,
 * and does not require the coordinator to pass anything beyond what
 * it would naturally have at call time (config, artifactRoot,
 * projectRoot, dryRun).
 */

import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPlanPhase } from '../pipeline/plan_phase.js';
import { runDevelopPhase } from '../pipeline/develop_phase.js';
import { runVerifyPhase } from '../pipeline/verify_phase.js';
import type { FactoryConfig } from '../config.js';
import type { IntentArtifact } from '../plan.js';
import type { Feature } from '../execute.js';

function makeMinimalConfig(): FactoryConfig {
  return {
    project_name: 'integration',
    factory_dir: '.',
    artifact_dir: '.',
    verification: { build: 'true', lint: 'true', test: 'true' },
    validation: { command: 'true' },
    infrastructure_patterns: [],
    completed_by_default: { kind: 'agent', id: 'test' },
    personas: {
      planner: { description: '', instructions: ['plan'] },
      developer: { description: '', instructions: ['dev'] },
      code_reviewer: { description: '', instructions: ['review'] },
      qa: { description: '', instructions: ['verify'] },
    },
  } as FactoryConfig;
}

function makeIntent(id: string): IntentArtifact {
  return {
    id,
    title: 'Integration intent',
    description: 'A description',
    requirements: [],
    constraints: [],
    acceptance_criteria: [],
    spec: null,
  } as IntentArtifact;
}

function setupFixture(): { root: string; feature: Feature } {
  const root = mkdtempSync(join(tmpdir(), 'phases-integration-'));
  mkdirSync(join(root, 'intents'));
  mkdirSync(join(root, 'features'));
  mkdirSync(join(root, 'packets'));
  mkdirSync(join(root, 'completions'));

  // Pre-existing intent -> feature mapping (so the plan phase
  // short-circuits without invoking an agent).
  writeFileSync(
    join(root, 'intents', 'intent-int.json'),
    JSON.stringify({ id: 'intent-int', title: 'Integration intent', status: 'planned' }, null, 2),
    'utf-8',
  );
  const feature: Feature = {
    id: 'feat-int',
    intent: 'integration',
    intent_id: 'intent-int',
    status: 'executing',
    packets: ['pkt-dev', 'pkt-qa'],
    created_by: { kind: 'agent', id: 'test' },
  } as Feature;
  writeFileSync(
    join(root, 'features', 'feat-int.json'),
    JSON.stringify(feature, null, 2),
    'utf-8',
  );

  // One dev packet (fresh) and one QA packet that verifies it.
  writeFileSync(
    join(root, 'packets', 'pkt-dev.json'),
    JSON.stringify({
      id: 'pkt-dev',
      kind: 'dev',
      title: 'Dev packet',
      status: 'ready',
    }, null, 2),
    'utf-8',
  );
  writeFileSync(
    join(root, 'packets', 'pkt-qa.json'),
    JSON.stringify({
      id: 'pkt-qa',
      kind: 'qa',
      title: 'QA packet',
      verifies: 'pkt-dev',
    }, null, 2),
    'utf-8',
  );

  return { root, feature };
}

describe('Phase 4.5 — three phases callable in sequence (dry-run)', () => {
  it('runPlanPhase + runDevelopPhase + runVerifyPhase produce expected dry-run results against a fixture', async () => {
    const { root, feature } = setupFixture();
    try {
      const config = makeMinimalConfig();

      // Plan: pre-existing feature for this intent — short-circuits.
      const planResult = await runPlanPhase({
        intent: makeIntent('intent-int'),
        config,
        artifactRoot: root,
        dryRun: true,
      });
      expect(planResult.feature_id).toBe('feat-int');

      // Develop (dry-run): the dev packet enters the loop body, logs
      // the dry-run line, and is reported as neither completed nor
      // failed (the original loop's `continue` semantics).
      const devResult = await runDevelopPhase({
        feature,
        config,
        artifactRoot: root,
        projectRoot: root,
        dryRun: true,
      });
      expect(devResult.completed).toEqual([]);
      expect(devResult.failed).toEqual([]);

      // Verify (dry-run): the QA packet's `verifies` target (pkt-dev)
      // is NOT in completions, so it's reported as skipped (the
      // dependency check runs before the dry-run early-exit).
      const qaResult = await runVerifyPhase({
        feature,
        config,
        artifactRoot: root,
        projectRoot: root,
        dryRun: true,
      });
      expect(qaResult.skipped).toEqual(['pkt-qa']);
      expect(qaResult.completed).toEqual([]);
      expect(qaResult.failed).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runVerifyPhase reports a pre-completed dev packet as a satisfied dependency', async () => {
    // This pins the contract that the coordinator relies on: when the
    // dev packet IS complete, the verify phase moves past the
    // dependency check and (in dry-run) hits the per-packet dry-run
    // branch — neither completed nor failed nor skipped.
    const { root, feature } = setupFixture();
    try {
      // Mark pkt-dev as complete on disk.
      writeFileSync(
        join(root, 'completions', 'pkt-dev.json'),
        JSON.stringify({ packet_id: 'pkt-dev' }, null, 2),
        'utf-8',
      );

      const result = await runVerifyPhase({
        feature,
        config: makeMinimalConfig(),
        artifactRoot: root,
        projectRoot: root,
        dryRun: true,
      });

      // The QA packet's dependency is now met, so it does NOT skip;
      // the dry-run early exit then prevents an agent invocation
      // and the packet is recorded as neither completed nor failed.
      expect(result.skipped).toEqual([]);
      expect(result.completed).toEqual([]);
      expect(result.failed).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
