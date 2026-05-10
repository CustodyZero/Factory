/**
 * Phase 5.5 — Integration tests for orchestrator-emitted events.
 *
 * These tests are the structural anchor for the events wire-up: they
 * run the orchestrator under tmpdir, then read the JSONL stream and
 * assert the expected sequence of event types. Any future refactor
 * that drops or moves an emission point will surface here first.
 *
 * Two invariants are pinned in this file:
 *
 *   1. Sequence: pipeline.started -> pipeline.spec_resolved
 *      -> spec.started -> phase.started(plan) -> phase.completed(plan)
 *      -> spec.completed -> pipeline.finished. (Develop / verify
 *      phases also emit; their phase events are checked separately.)
 *
 *   2. Tests cannot pollute the host project: events files live in
 *      the tmpdir-rooted artifactRoot. The host's `factory/events/`
 *      tree is never touched by tests.
 *
 *   3. Provenance under vitest is always 'test'. deriveProvenance is
 *      hardwired on VITEST; a regression here would mean tests
 *      flowing into the live event stream.
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

function makeBaseConfig(): FactoryConfig {
  return ({
    project_name: 'orch-events-test',
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
  const root = mkdtempSync(join(tmpdir(), 'orch-events-'));
  dirs.push(root);
  writeFileSync(
    join(root, 'factory.config.json'),
    JSON.stringify(makeBaseConfig(), null, 2),
    'utf-8',
  );
  return root;
}

function writeSpec(root: string, id: string, opts: { dependsOn?: ReadonlyArray<string> } = {}): void {
  if (!existsSync(join(root, 'specs'))) mkdirSync(join(root, 'specs'), { recursive: true });
  const deps = opts.dependsOn ?? [];
  const fmLines = [`id: ${id}`, `title: Spec ${id}`];
  if (deps.length > 0) fmLines.push(`depends_on: [${deps.join(', ')}]`);
  writeFileSync(
    join(root, 'specs', `${id}.md`),
    `---\n${fmLines.join('\n')}\n---\n\nbody for ${id}\n`,
    'utf-8',
  );
}

function writeMalformedIntent(root: string, id: string): void {
  if (!existsSync(join(root, 'intents'))) mkdirSync(join(root, 'intents'), { recursive: true });
  writeFileSync(join(root, 'intents', `${id}.json`), '{not valid json', 'utf-8');
}

// ---------------------------------------------------------------------------
// Sequence anchor — single dry-run spec
//
// The dry-run path stops the plan phase before the planner is invoked,
// so develop/verify still run their own phase events but find zero
// packets. This produces a clean, deterministic event sequence.
// ---------------------------------------------------------------------------

describe('orchestrator events — sequence', () => {
  it('emits pipeline -> spec -> phase events in the expected order for a single spec', async () => {
    const root = mkRoot();
    writeSpec(root, 'foo');
    const result = await runOrchestrator({
      args: ['foo'],
      config: makeBaseConfig(),
      projectRoot: root,
      artifactRoot: root,
      dryRun: true,
    });
    expect(result.success).toBe(true);

    const events = readEvents(result.run_id, root);
    const types = events.map((e) => e.event_type);

    // The full prefix the spec brief calls out:
    //   pipeline.started -> pipeline.spec_resolved -> spec.started ->
    //   phase.started(plan) -> phase.completed(plan) -> ...
    //   -> spec.completed -> pipeline.finished
    expect(types[0]).toBe('pipeline.started');
    expect(types[1]).toBe('pipeline.spec_resolved');
    expect(types[2]).toBe('spec.started');
    // Phase-3 phase events follow; we don't assert their exact relative
    // order here (that's what orchestrator_events_phases.test.ts could
    // do; for this anchor we only need to confirm presence and end).
    expect(types).toContain('phase.started');
    expect(types).toContain('phase.completed');
    // spec.completed comes BEFORE pipeline.finished; that's the bracket-
    // close ordering the brief pins.
    const specCompletedIdx = types.indexOf('spec.completed');
    const pipelineFinishedIdx = types.indexOf('pipeline.finished');
    expect(specCompletedIdx).toBeGreaterThan(2);
    expect(pipelineFinishedIdx).toBeGreaterThan(specCompletedIdx);
    expect(types[types.length - 1]).toBe('pipeline.finished');
  });

  it('emits all three phase pairs (plan / develop / verify) when planning is short-circuited by an existing feature', async () => {
    // The dry-run plan path returns early when there is no existing
    // feature for the intent (planning would invoke the real planner,
    // which dry-run skips). To exercise develop and verify too we
    // pre-seed the intent + feature so the plan phase finds the
    // feature and falls through to develop/verify.
    const root = mkRoot();
    writeSpec(root, 'foo');
    mkdirSync(join(root, 'features'), { recursive: true });
    mkdirSync(join(root, 'intents'), { recursive: true });
    writeFileSync(
      join(root, 'intents', 'foo.json'),
      JSON.stringify({
        id: 'foo',
        title: 'Spec foo',
        spec_path: 'specs/foo.md',
        status: 'planned',
        depends_on: [],
        feature_id: 'feat-foo',
        created_by: { kind: 'cli', id: 'test' },
        created_at: '2026-04-29T00:00:00.000Z',
      }, null, 2),
      'utf-8',
    );
    writeFileSync(
      join(root, 'features', 'feat-foo.json'),
      JSON.stringify({
        id: 'feat-foo',
        intent_id: 'foo',
        status: 'executing',
        packets: [],
      }, null, 2),
      'utf-8',
    );
    const result = await runOrchestrator({
      args: ['foo'],
      config: makeBaseConfig(),
      projectRoot: root,
      artifactRoot: root,
      dryRun: true,
    });
    const events = readEvents(result.run_id, root);
    const phaseEvents = events.filter(
      (e) => e.event_type === 'phase.started' || e.event_type === 'phase.completed',
    );
    // 3 starts + 3 completions = 6 phase events
    expect(phaseEvents).toHaveLength(6);
    const phasesStarted = events
      .filter((e) => e.event_type === 'phase.started')
      .map((e) => (e.payload.event_type === 'phase.started' ? e.payload.phase : null));
    expect(new Set(phasesStarted)).toEqual(new Set(['plan', 'develop', 'verify']));
  });
});

// ---------------------------------------------------------------------------
// Provenance — under vitest the events MUST be tagged 'test'
// ---------------------------------------------------------------------------

describe('orchestrator events — provenance', () => {
  it('every event under vitest carries provenance: test', async () => {
    const root = mkRoot();
    writeSpec(root, 'p');
    const result = await runOrchestrator({
      args: ['p'],
      config: makeBaseConfig(),
      projectRoot: root,
      artifactRoot: root,
      dryRun: false, // 'test' must win over 'live_run' too
    });
    const events = readEvents(result.run_id, root);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.provenance).toBe('test');
    }
  });

  it("'test' provenance is invariant whether dry-run is true or false", async () => {
    // Two runs, same setup, opposite dryRun values. Provenance must
    // be 'test' in both cases — vitest beats both branches.
    const root1 = mkRoot();
    writeSpec(root1, 's');
    const r1 = await runOrchestrator({
      args: ['s'],
      config: makeBaseConfig(),
      projectRoot: root1,
      artifactRoot: root1,
      dryRun: false,
    });
    const e1 = readEvents(r1.run_id, root1);

    const root2 = mkRoot();
    writeSpec(root2, 's');
    const r2 = await runOrchestrator({
      args: ['s'],
      config: makeBaseConfig(),
      projectRoot: root2,
      artifactRoot: root2,
      dryRun: true,
    });
    const e2 = readEvents(r2.run_id, root2);

    expect(e1.every((e) => e.provenance === 'test')).toBe(true);
    expect(e2.every((e) => e.provenance === 'test')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tmpdir isolation — the host project must NEVER receive test events
// ---------------------------------------------------------------------------

describe('orchestrator events — tmpdir isolation', () => {
  it('writes events to the tmpdir artifactRoot, NOT the host project root', async () => {
    const root = mkRoot();
    writeSpec(root, 'iso');
    const result = await runOrchestrator({
      args: ['iso'],
      config: makeBaseConfig(),
      projectRoot: root,
      artifactRoot: root,
      dryRun: true,
    });
    // The tmpdir-rooted events file exists.
    const tmpEventsFile = join(root, 'events', `${result.run_id}.jsonl`);
    expect(existsSync(tmpEventsFile)).toBe(true);
    // The file actually has content.
    const events = readEvents(result.run_id, root);
    expect(events.length).toBeGreaterThan(0);
    // The host project root must NOT have an events file with this run_id.
    // We use process.cwd() because the tests are run from the repo root.
    const hostEventsFile = join(process.cwd(), 'events', `${result.run_id}.jsonl`);
    expect(existsSync(hostEventsFile)).toBe(false);
  });

  it('top-level resolution failure still produces pipeline.started + pipeline.failed in tmpdir', async () => {
    const root = mkRoot();
    // No spec / intent for 'ghost' — resolution fails.
    const result = await runOrchestrator({
      args: ['ghost'],
      config: makeBaseConfig(),
      projectRoot: root,
      artifactRoot: root,
      dryRun: true,
    });
    expect(result.success).toBe(false);
    const events = readEvents(result.run_id, root);
    const types = events.map((e) => e.event_type);
    expect(types).toContain('pipeline.started');
    expect(types).toContain('pipeline.failed');
    // pipeline.finished must NOT be present on the failure path.
    expect(types).not.toContain('pipeline.finished');
  });
});

// ---------------------------------------------------------------------------
// spec.blocked — emitted once per blocked dependent
// ---------------------------------------------------------------------------

describe('orchestrator events — spec.blocked', () => {
  it('emits spec.blocked for a dependent whose upstream failed', async () => {
    const root = mkRoot();
    writeMalformedIntent(root, 'a');           // 'a' fails at intent-parse
    writeSpec(root, 'b', { dependsOn: ['a'] }); // 'b' depends on 'a'
    const result = await runOrchestrator({
      args: ['a', 'b'],
      config: makeBaseConfig(),
      projectRoot: root,
      artifactRoot: root,
      dryRun: true,
    });
    const events = readEvents(result.run_id, root);
    const blocked = events.filter((e) => e.event_type === 'spec.blocked');
    expect(blocked).toHaveLength(1);
    if (blocked[0]!.payload.event_type === 'spec.blocked') {
      expect(blocked[0]!.payload.spec_id).toBe('b');
      expect(blocked[0]!.payload.blocked_by).toContain('a');
    }
    // 'b' must NOT have spec.started or spec.completed — blocked specs
    // skip those entirely.
    const bStarted = events.find(
      (e) => e.event_type === 'spec.started' && e.payload.event_type === 'spec.started' && e.payload.spec_id === 'b',
    );
    expect(bStarted).toBeUndefined();
  });
});
