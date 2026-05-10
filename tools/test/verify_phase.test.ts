/**
 * Tests for tools/pipeline/verify_phase.ts.
 *
 * Like the develop phase, the full verify path requires invoking a
 * real QA provider CLI. Coverage here pins the deterministic
 * branches that don't shell out:
 *
 *   - Structural: the function is exported with the documented result
 *     shape ({ completed, failed, skipped }).
 *   - Empty-feature: no QA packets to process produces empty arrays.
 *   - Already-complete short-circuit: pre-existing completion record
 *     reports as completed without invoking the QA agent.
 *   - Blocked-by-dev: `verifies` target not yet completed reports as
 *     skipped (not failed).
 *   - Dry-run: per-packet dry-run logging without invoking the agent
 *     or mutating disk state.
 */

import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVerifyPhase } from '../pipeline/verify_phase.js';
import type { Feature } from '../execute.js';
import type { FactoryConfig } from '../config.js';

function makeMinimalConfig(): FactoryConfig {
  return {
    project_name: 'test',
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
  } as FactoryConfig;
}

function makeFeature(packetIds: string[]): Feature {
  return {
    id: 'feat-test',
    intent: 'test',
    status: 'executing',
    packets: packetIds,
    created_by: { kind: 'agent', id: 'test' },
  } as Feature;
}

function setupArtifactRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'verify-phase-'));
  mkdirSync(join(root, 'packets'));
  mkdirSync(join(root, 'completions'));
  mkdirSync(join(root, 'features'));
  return root;
}

describe('runVerifyPhase — structural shape', () => {
  it('exports a callable named runVerifyPhase', () => {
    expect(typeof runVerifyPhase).toBe('function');
  });

  it('returns { completed, failed, skipped } with empty arrays for an empty feature', async () => {
    const root = setupArtifactRoot();
    try {
      const result = await runVerifyPhase({
        feature: makeFeature([]),
        config: makeMinimalConfig(),
        artifactRoot: root,
        projectRoot: root,
        dryRun: false,
      });
      expect(result.completed).toEqual([]);
      expect(result.failed).toEqual([]);
      expect(result.skipped).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runVerifyPhase — already-complete short-circuit', () => {
  it('reports a pre-completed QA packet without invoking the QA agent', async () => {
    const root = setupArtifactRoot();
    try {
      writeFileSync(
        join(root, 'packets', 'qa-done.json'),
        JSON.stringify({
          id: 'qa-done',
          kind: 'qa',
          title: 'A QA packet',
          status: 'completed',
          verifies: 'pkt-something',
        }, null, 2),
        'utf-8',
      );
      writeFileSync(
        join(root, 'completions', 'qa-done.json'),
        JSON.stringify({ packet_id: 'qa-done' }, null, 2),
        'utf-8',
      );

      const result = await runVerifyPhase({
        feature: makeFeature(['qa-done']),
        config: makeMinimalConfig(),
        artifactRoot: root,
        projectRoot: root,
        dryRun: false,
      });

      expect(result.completed).toEqual(['qa-done']);
      expect(result.failed).toEqual([]);
      expect(result.skipped).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runVerifyPhase — blocked-by-dev', () => {
  it('reports a QA packet whose `verifies` target is not complete as skipped (not failed)', async () => {
    const root = setupArtifactRoot();
    try {
      // The dev packet referenced by `verifies` is NOT in completions.
      writeFileSync(
        join(root, 'packets', 'qa-pending.json'),
        JSON.stringify({
          id: 'qa-pending',
          kind: 'qa',
          title: 'Awaiting dev',
          verifies: 'dev-not-done',
        }, null, 2),
        'utf-8',
      );

      const result = await runVerifyPhase({
        feature: makeFeature(['qa-pending']),
        config: makeMinimalConfig(),
        artifactRoot: root,
        projectRoot: root,
        dryRun: false,
      });

      expect(result.skipped).toEqual(['qa-pending']);
      expect(result.completed).toEqual([]);
      expect(result.failed).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runVerifyPhase — dry-run', () => {
  it('does not invoke any agent or write a completion file in dry-run mode', async () => {
    const root = setupArtifactRoot();
    try {
      // QA packet whose dev-side dependency IS complete (so it would
      // otherwise get invoked) — dry-run must skip the invocation.
      writeFileSync(
        join(root, 'packets', 'qa-dry.json'),
        JSON.stringify({
          id: 'qa-dry',
          kind: 'qa',
          title: 'Dry QA',
          verifies: 'dev-done',
        }, null, 2),
        'utf-8',
      );
      writeFileSync(
        join(root, 'completions', 'dev-done.json'),
        JSON.stringify({ packet_id: 'dev-done' }, null, 2),
        'utf-8',
      );

      const result = await runVerifyPhase({
        feature: makeFeature(['qa-dry']),
        config: makeMinimalConfig(),
        artifactRoot: root,
        projectRoot: root,
        dryRun: true,
      });

      // The packet enters the loop body, prints the dry-run message,
      // and continues — neither completed nor failed nor skipped.
      expect(result.completed).toEqual([]);
      expect(result.failed).toEqual([]);
      expect(result.skipped).toEqual([]);

      // No completion file was written; the dev-done completion
      // remains the only one on disk.
      expect(existsSync(join(root, 'completions', 'qa-dry.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runVerifyPhase — only operates on QA packets', () => {
  it('ignores dev packets even when listed on the feature', async () => {
    const root = setupArtifactRoot();
    try {
      writeFileSync(
        join(root, 'packets', 'pkt-dev.json'),
        JSON.stringify({
          id: 'pkt-dev',
          kind: 'dev',
          title: 'Dev packet',
        }, null, 2),
        'utf-8',
      );

      // Read the file we just wrote — verifies the JSON file we wrote
      // is valid (otherwise readJsonDir would silently filter it out
      // and the test wouldn't actually be exercising what it claims).
      expect(readFileSync(join(root, 'packets', 'pkt-dev.json'), 'utf-8'))
        .toMatch(/"kind": "dev"/);

      const result = await runVerifyPhase({
        feature: makeFeature(['pkt-dev']),
        config: makeMinimalConfig(),
        artifactRoot: root,
        projectRoot: root,
        dryRun: false,
      });

      // Dev packet on a verify run produces no entries anywhere — the
      // filter at the top of the loop excludes it.
      expect(result.completed).toEqual([]);
      expect(result.failed).toEqual([]);
      expect(result.skipped).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
