/**
 * Phase 5.5 — provenance integrity test.
 *
 * Single, dedicated test file pinning the most load-bearing safety
 * invariant of the events system:
 *
 *   When the orchestrator runs under vitest, EVERY emitted event has
 *   provenance: 'test'. No `live_run` or `dry_run` slips through.
 *
 * Why this matters: the recovery layer (Phase 6) and the future
 * memory write-side filter on provenance. A bug that flagged test
 * runs as `live_run` would silently feed test fixtures into trained
 * memory or trigger recovery on synthetic failures. The
 * deriveProvenance VITEST-wins-over-everything rule is what prevents
 * that — this test exists so a future refactor of that helper is
 * caught immediately.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOrchestrator } from '../pipeline/orchestrator/index.js';
import { readEvents } from '../events.js';
import type { FactoryConfig } from '../config.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function mkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'event-prov-'));
  dirs.push(root);
  const config: FactoryConfig = ({
    project_name: 'event-prov-test',
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
  writeFileSync(
    join(root, 'factory.config.json'),
    JSON.stringify(config, null, 2),
    'utf-8',
  );
  return root;
}

function writeSpec(root: string, id: string): void {
  if (!existsSync(join(root, 'specs'))) mkdirSync(join(root, 'specs'), { recursive: true });
  writeFileSync(
    join(root, 'specs', `${id}.md`),
    `---\nid: ${id}\ntitle: Spec ${id}\n---\n\nbody\n`,
    'utf-8',
  );
}

describe('event provenance', () => {
  it("a full orchestrator run under vitest tags every event with 'test'", async () => {
    const root = mkRoot();
    writeSpec(root, 'pv');
    const result = await runOrchestrator({
      args: ['pv'],
      config: ({
        project_name: 'pv',
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
      } as unknown) as FactoryConfig,
      projectRoot: root,
      artifactRoot: root,
      dryRun: false,
    });
    const events = readEvents(result.run_id, root);
    expect(events.length).toBeGreaterThan(0);
    // Pin every single emitted event individually so any regression
    // points at the first leaking event.
    for (const e of events) {
      expect(e.provenance).toBe('test');
    }
    // Sanity: no non-test provenance values appear at all.
    const provenances = new Set(events.map((e) => e.provenance));
    expect(provenances).toEqual(new Set(['test']));
  });
});
