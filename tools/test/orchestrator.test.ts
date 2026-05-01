/**
 * Orchestrator tests (Phase 5 — multi-spec dependency-aware sequencing).
 *
 * Two layers of coverage:
 *
 *   1. Pure helpers exported for testing (`_resolveAll`,
 *      `_detectCycles`, `_findMissingDeps`). These pin the
 *      pre-execution gates the orchestrator runs before invoking any
 *      agent.
 *
 *   2. `runOrchestrator` itself, exercised via tmpdir fixtures with
 *      `dryRun: true`. Dry-run skips real agent invocation while still
 *      executing the resolution / cycle / missing-dep / per-spec
 *      sequencing logic.
 *
 * Failure-propagation rules from specs/single-entry-pipeline.md Phase 5
 * are pinned: a failed spec blocks its dependents (transitively), but
 * independent specs continue. Cycles and missing transitive deps are
 * caught BEFORE any agent invocation — this is verified by inspecting
 * `runOrchestrator`'s result (no per-spec outcomes when the run was
 * never started).
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runOrchestrator,
  _resolveAll,
  _detectCycles,
  _findMissingDeps,
  type ResolvedSpec,
  type SpecOutcome,
} from '../pipeline/orchestrator.js';
import type { FactoryConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface Fixture {
  readonly root: string;
  readonly config: FactoryConfig;
}

let fixtures: Fixture[] = [];
afterEach(() => {
  for (const f of fixtures) rmSync(f.root, { recursive: true, force: true });
  fixtures = [];
});

function makeBaseConfig(): FactoryConfig {
  // Cast through unknown — the test fixture config doesn't need every
  // optional field that FactoryConfig declares (pipeline defaults fill
  // in at runtime). Vitest sees the real shape via loadConfig in the
  // CLI smoke tests; here we hand-build to avoid the disk round-trip.
  return ({
    project_name: 'orch-test',
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

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'orch-'));
  const config = makeBaseConfig();
  writeFileSync(
    join(root, 'factory.config.json'),
    JSON.stringify(config, null, 2),
    'utf-8',
  );
  fixtures.push({ root, config });
  return { root, config };
}

function writeSpec(
  root: string,
  id: string,
  opts: { readonly title?: string; readonly dependsOn?: ReadonlyArray<string> } = {},
): void {
  if (!existsSync(join(root, 'specs'))) mkdirSync(join(root, 'specs'), { recursive: true });
  const title = opts.title ?? `Spec ${id}`;
  const deps = opts.dependsOn ?? [];
  const fmLines = [`id: ${id}`, `title: ${title}`];
  if (deps.length > 0) fmLines.push(`depends_on: [${deps.join(', ')}]`);
  const content = `---\n${fmLines.join('\n')}\n---\n\nbody for ${id}\n`;
  writeFileSync(join(root, 'specs', `${id}.md`), content, 'utf-8');
}

function writeIntent(
  root: string,
  id: string,
): void {
  if (!existsSync(join(root, 'intents'))) mkdirSync(join(root, 'intents'), { recursive: true });
  const intent = {
    id,
    title: `Legacy intent ${id}`,
    spec: `inline ${id}`,
    status: 'proposed',
    created_by: { kind: 'cli', id: 'test' },
    created_at: '2026-04-29T00:00:00.000Z',
  };
  writeFileSync(join(root, 'intents', `${id}.json`), JSON.stringify(intent, null, 2), 'utf-8');
}

function makeResolved(
  id: string,
  dependsOn: ReadonlyArray<string> = [],
): ResolvedSpec {
  return {
    id,
    dependsOn,
    intentPath: `/dev/null/${id}.json`,
    source: 'spec',
  };
}

// ---------------------------------------------------------------------------
// _resolveAll — pure resolution layer
// ---------------------------------------------------------------------------

describe('_resolveAll', () => {
  it('returns an error for an empty arg list', () => {
    const f = makeFixture();
    const r = _resolveAll([], f.root, f.root);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('No spec or intent ids');
  });

  it('resolves a single spec to a ResolvedSpec node', () => {
    const f = makeFixture();
    writeSpec(f.root, 'a');
    const r = _resolveAll(['a'], f.root, f.root);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved).toHaveLength(1);
      expect(r.resolved[0]!.id).toBe('a');
      expect(r.resolved[0]!.dependsOn).toEqual([]);
      expect(r.resolved[0]!.source).toBe('spec');
    }
  });

  it('returns dependsOn from spec frontmatter', () => {
    const f = makeFixture();
    writeSpec(f.root, 'a', { dependsOn: ['b', 'c'] });
    writeSpec(f.root, 'b');
    writeSpec(f.root, 'c');
    const r = _resolveAll(['a', 'b', 'c'], f.root, f.root);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const a = r.resolved.find((s) => s.id === 'a')!;
      expect(a.dependsOn).toEqual(['b', 'c']);
    }
  });

  it('treats legacy intents as having empty dependsOn', () => {
    const f = makeFixture();
    writeIntent(f.root, 'legacy');
    const r = _resolveAll(['legacy'], f.root, f.root);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved[0]!.source).toBe('intent');
      expect(r.resolved[0]!.dependsOn).toEqual([]);
    }
  });

  it('dedupes repeated args by id', () => {
    const f = makeFixture();
    writeSpec(f.root, 'a');
    const r = _resolveAll(['a', 'a', 'a'], f.root, f.root);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved).toHaveLength(1);
  });

  it('preserves first-seen order across the resolved list', () => {
    const f = makeFixture();
    writeSpec(f.root, 'a');
    writeSpec(f.root, 'b');
    writeSpec(f.root, 'c');
    const r = _resolveAll(['c', 'a', 'b'], f.root, f.root);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.map((s) => s.id)).toEqual(['c', 'a', 'b']);
  });

  it('bails on the first unresolvable arg with a message naming both checked paths', () => {
    const f = makeFixture();
    writeSpec(f.root, 'a');
    const r = _resolveAll(['a', 'ghost'], f.root, f.root);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('ghost');
      expect(r.error).toContain('specs/ghost.md');
      expect(r.error).toContain('intents/ghost.json');
    }
  });
});

// ---------------------------------------------------------------------------
// _detectCycles
// ---------------------------------------------------------------------------

describe('_detectCycles', () => {
  it('returns no cycles for a DAG', () => {
    const r = _detectCycles([
      makeResolved('a'),
      makeResolved('b', ['a']),
      makeResolved('c', ['a', 'b']),
    ]);
    expect(r.cycles).toEqual([]);
  });

  it('detects a self-loop', () => {
    const r = _detectCycles([makeResolved('a', ['a'])]);
    expect(r.cycles).toHaveLength(1);
    expect(r.cycles[0]).toContain('a');
  });

  it('detects a 2-spec cycle (a -> b -> a)', () => {
    const r = _detectCycles([
      makeResolved('a', ['b']),
      makeResolved('b', ['a']),
    ]);
    expect(r.cycles).toHaveLength(1);
    const flat = r.cycles[0]!.join(',');
    expect(flat).toContain('a');
    expect(flat).toContain('b');
  });

  it('detects a 3-spec cycle (a -> b -> c -> a)', () => {
    const r = _detectCycles([
      makeResolved('a', ['b']),
      makeResolved('b', ['c']),
      makeResolved('c', ['a']),
    ]);
    expect(r.cycles).toHaveLength(1);
    const members = new Set(r.cycles[0]);
    expect(members.has('a')).toBe(true);
    expect(members.has('b')).toBe(true);
    expect(members.has('c')).toBe(true);
  });

  it('detects a cycle inside a larger graph (acyclic specs are not reported)', () => {
    // a is a clean leaf; b <-> c is the cycle; d depends on b but is
    // itself acyclic. Only the cycle members should be reported.
    const r = _detectCycles([
      makeResolved('a'),
      makeResolved('b', ['c']),
      makeResolved('c', ['b']),
      makeResolved('d', ['b']),
    ]);
    expect(r.cycles).toHaveLength(1);
    const members = new Set(r.cycles[0]);
    expect(members.has('b')).toBe(true);
    expect(members.has('c')).toBe(true);
    // 'a' and 'd' are not part of the cycle.
    expect(members.has('a')).toBe(false);
    expect(members.has('d')).toBe(false);
  });

  it('ignores deps that point at ids not in the input set', () => {
    // 'external' is not in the resolved set; must not be treated as
    // part of a cycle. (Missing-target detection is _findMissingDeps's
    // job, not the cycle detector's.)
    const r = _detectCycles([makeResolved('a', ['external'])]);
    expect(r.cycles).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// _findMissingDeps
// ---------------------------------------------------------------------------

describe('_findMissingDeps', () => {
  it('returns an empty list when every dep is in the input set', () => {
    const r = _findMissingDeps([
      makeResolved('a'),
      makeResolved('b', ['a']),
    ]);
    expect(r).toEqual([]);
  });

  it('reports a missing direct dep', () => {
    const r = _findMissingDeps([makeResolved('a', ['x'])]);
    expect(r).toHaveLength(1);
    expect(r[0]!.specId).toBe('a');
    expect(r[0]!.missingId).toBe('x');
  });

  it('reports each missing dep separately when one spec has multiple', () => {
    const r = _findMissingDeps([makeResolved('a', ['x', 'y'])]);
    expect(r).toHaveLength(2);
    expect(new Set(r.map((m) => m.missingId))).toEqual(new Set(['x', 'y']));
  });
});

// ---------------------------------------------------------------------------
// runOrchestrator — single-arg backward compat path (legacy intent)
// ---------------------------------------------------------------------------

describe('runOrchestrator — single-arg legacy intent', () => {
  it('runs a legacy intent (no spec, empty dependsOn) and reaches the planning phase', () => {
    const f = makeFixture();
    writeIntent(f.root, 'legacy');
    const result = runOrchestrator({
      args: ['legacy'],
      config: f.config,
      projectRoot: f.root,
      artifactRoot: f.root,
      dryRun: true,
    });
    // Dry-run can't complete (no agents invoked) but the spec was
    // attempted: we get one outcome and it is `failed` with the dry-
    // run reason. Critical: success === false but the spec WAS
    // resolved and reached PLANNING — not blocked or rejected up-
    // front.
    expect(result.specs).toHaveLength(1);
    expect(result.specs[0]!.id).toBe('legacy');
    expect(result.specs[0]!.status).toBe('failed');
    if (result.specs[0]!.status === 'failed') {
      expect(result.specs[0]!.reason).toContain('Dry run');
    }
  });
});

// ---------------------------------------------------------------------------
// runOrchestrator — single-arg spec, no deps
// ---------------------------------------------------------------------------

describe('runOrchestrator — single-arg spec without depends_on', () => {
  it('materializes the intent and reaches planning', () => {
    const f = makeFixture();
    writeSpec(f.root, 'foo', { title: 'Foo' });
    const result = runOrchestrator({
      args: ['foo'],
      config: f.config,
      projectRoot: f.root,
      artifactRoot: f.root,
      dryRun: true,
    });
    expect(existsSync(join(f.root, 'intents', 'foo.json'))).toBe(true);
    expect(result.specs).toHaveLength(1);
    expect(result.specs[0]!.id).toBe('foo');
    expect(result.specs[0]!.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// runOrchestrator — multi-spec, missing transitive dep
//
// The user passed `a` whose depends_on is [b], but never passed `b`.
// Phase 5 requires the orchestrator to fail upfront with a clear
// error before any agent is invoked. Verified by inspecting the
// result: success=false, no per-spec outcomes, and a message that
// names both 'a' and 'b'.
// ---------------------------------------------------------------------------

describe('runOrchestrator — multi-spec resolution gates', () => {
  it('errors when a depends_on points to an id not passed as an arg', () => {
    const f = makeFixture();
    writeSpec(f.root, 'a', { dependsOn: ['b'] });
    writeSpec(f.root, 'b');
    const result = runOrchestrator({
      args: ['a'],
      config: f.config,
      projectRoot: f.root,
      artifactRoot: f.root,
      dryRun: true,
    });
    expect(result.success).toBe(false);
    expect(result.specs).toEqual([]);
    expect(result.message).toContain('Missing transitive dependency');
    expect(result.message).toContain("'a'");
    expect(result.message).toContain("'b'");
  });

  it('errors when the spec arg cannot be resolved', () => {
    const f = makeFixture();
    const result = runOrchestrator({
      args: ['ghost'],
      config: f.config,
      projectRoot: f.root,
      artifactRoot: f.root,
      dryRun: true,
    });
    expect(result.success).toBe(false);
    expect(result.specs).toEqual([]);
    expect(result.message).toContain('No spec or intent found');
  });

  it('rejects a 2-spec cycle before invoking any agent', () => {
    const f = makeFixture();
    writeSpec(f.root, 'a', { dependsOn: ['b'] });
    writeSpec(f.root, 'b', { dependsOn: ['a'] });
    const result = runOrchestrator({
      args: ['a', 'b'],
      config: f.config,
      projectRoot: f.root,
      artifactRoot: f.root,
      dryRun: true,
    });
    expect(result.success).toBe(false);
    expect(result.specs).toEqual([]);
    expect(result.message).toContain('Cyclic spec dependency');
    // No feature should have been created (planner would have done
    // that as a side effect of being invoked); features dir is absent
    // or empty.
    expect(existsSync(join(f.root, 'features'))).toBe(false);
  });

  it('rejects a 3-spec cycle before invoking any agent', () => {
    const f = makeFixture();
    writeSpec(f.root, 'a', { dependsOn: ['b'] });
    writeSpec(f.root, 'b', { dependsOn: ['c'] });
    writeSpec(f.root, 'c', { dependsOn: ['a'] });
    const result = runOrchestrator({
      args: ['a', 'b', 'c'],
      config: f.config,
      projectRoot: f.root,
      artifactRoot: f.root,
      dryRun: true,
    });
    expect(result.success).toBe(false);
    expect(result.specs).toEqual([]);
    expect(result.message).toContain('Cyclic spec dependency');
  });
});

// ---------------------------------------------------------------------------
// runOrchestrator — sequencing (multi-spec, no deps)
// ---------------------------------------------------------------------------

describe('runOrchestrator — multi-spec sequencing', () => {
  it('runs each independent spec and returns one outcome per arg', () => {
    const f = makeFixture();
    writeSpec(f.root, 'x');
    writeSpec(f.root, 'y');
    const result = runOrchestrator({
      args: ['x', 'y'],
      config: f.config,
      projectRoot: f.root,
      artifactRoot: f.root,
      dryRun: true,
    });
    expect(result.specs).toHaveLength(2);
    const ids = result.specs.map((s) => s.id).sort();
    expect(ids).toEqual(['x', 'y']);
  });

  it('runs linear deps in topo order (a runs before b when b depends on a)', () => {
    // The orchestrator logs `Multi-spec run: a -> b` once it has built
    // the topo order. That line is the cleanest assertion target —
    // even with reversed args, the topo sort reorders to `a -> b`.
    const f = makeFixture();
    writeSpec(f.root, 'a');
    writeSpec(f.root, 'b', { dependsOn: ['a'] });

    const captured: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      captured.push(typeof chunk === 'string' ? chunk : (chunk as Buffer).toString());
      return origWrite(chunk as Buffer | string, ...(rest as []));
    }) as typeof process.stderr.write;
    try {
      runOrchestrator({
        args: ['b', 'a'],   // deliberately reversed; topo must reorder
        config: f.config,
        projectRoot: f.root,
        artifactRoot: f.root,
        dryRun: true,
      });
    } finally {
      process.stderr.write = origWrite;
    }
    const log = captured.join('');
    expect(log).toContain('Multi-spec run: a -> b');
  });

  it('respects diamond-shape topo order (b,c after a; d after b,c)', () => {
    // The `Multi-spec run: <id> -> <id> -> ...` log line emits the
    // topo ordering directly. We parse it to verify the diamond
    // ordering invariants (a before b/c, b/c before d) regardless of
    // the relative order between the two diamond shoulders.
    const f = makeFixture();
    writeSpec(f.root, 'a');
    writeSpec(f.root, 'b', { dependsOn: ['a'] });
    writeSpec(f.root, 'c', { dependsOn: ['a'] });
    writeSpec(f.root, 'd', { dependsOn: ['b', 'c'] });

    const captured: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      captured.push(typeof chunk === 'string' ? chunk : (chunk as Buffer).toString());
      return origWrite(chunk as Buffer | string, ...(rest as []));
    }) as typeof process.stderr.write;
    try {
      runOrchestrator({
        args: ['d', 'c', 'b', 'a'],
        config: f.config,
        projectRoot: f.root,
        artifactRoot: f.root,
        dryRun: true,
      });
    } finally {
      process.stderr.write = origWrite;
    }
    const log = captured.join('');
    const m = log.match(/Multi-spec run: ([^\n\x1b]+)/);
    expect(m).not.toBeNull();
    const order = (m![1]!).split(' -> ').map((s) => s.trim());
    const idx = (id: string) => order.indexOf(id);
    expect(idx('a')).toBeGreaterThanOrEqual(0);
    expect(idx('b')).toBeGreaterThanOrEqual(0);
    expect(idx('c')).toBeGreaterThanOrEqual(0);
    expect(idx('d')).toBeGreaterThanOrEqual(0);
    expect(idx('a')).toBeLessThan(idx('b'));
    expect(idx('a')).toBeLessThan(idx('c'));
    expect(idx('b')).toBeLessThan(idx('d'));
    expect(idx('c')).toBeLessThan(idx('d'));
  });
});

// ---------------------------------------------------------------------------
// runOrchestrator — failure propagation
//
// Dry-run mode causes every spec to come out as `failed` (no real
// planner runs to produce a feature). That gives us a deterministic
// "first spec fails" signal, which is exactly what we need to verify
// that downstream blocked propagation happens correctly.
// ---------------------------------------------------------------------------

describe('runOrchestrator — failure propagation', () => {
  it('marks a dependent spec as blocked when its upstream failed', () => {
    const f = makeFixture();
    writeSpec(f.root, 'a');
    writeSpec(f.root, 'b', { dependsOn: ['a'] });
    const result = runOrchestrator({
      args: ['a', 'b'],
      config: f.config,
      projectRoot: f.root,
      artifactRoot: f.root,
      dryRun: true,
    });
    const a = result.specs.find((s) => s.id === 'a')!;
    const b = result.specs.find((s) => s.id === 'b')!;
    expect(a.status).toBe('failed');
    expect(b.status).toBe('blocked');
    if (b.status === 'blocked') {
      expect(b.blocked_by).toContain('a');
      expect(b.reason).toContain('a');
    }
  });

  it('lets independent specs run even when another spec fails', () => {
    // a fails (dry-run). c has no deps, so it must still be attempted.
    const f = makeFixture();
    writeSpec(f.root, 'a');
    writeSpec(f.root, 'c');
    const result = runOrchestrator({
      args: ['a', 'c'],
      config: f.config,
      projectRoot: f.root,
      artifactRoot: f.root,
      dryRun: true,
    });
    expect(result.specs).toHaveLength(2);
    const a = result.specs.find((s) => s.id === 'a')!;
    const c = result.specs.find((s) => s.id === 'c')!;
    expect(a.status).toBe('failed');
    expect(c.status).toBe('failed'); // attempted, failed in dry-run; NOT blocked
    if (c.status === 'failed') {
      // c was not blocked — it was attempted on its own merits.
      expect((c as Extract<SpecOutcome, { status: 'failed' }>).reason).toContain('Dry run');
    }
  });

  it('mixed independent + dependent: a fails, b runs (independent), c blocked (depends on a)', () => {
    const f = makeFixture();
    writeSpec(f.root, 'a');
    writeSpec(f.root, 'b');
    writeSpec(f.root, 'c', { dependsOn: ['a'] });
    const result = runOrchestrator({
      args: ['a', 'b', 'c'],
      config: f.config,
      projectRoot: f.root,
      artifactRoot: f.root,
      dryRun: true,
    });
    const a = result.specs.find((s) => s.id === 'a')!;
    const b = result.specs.find((s) => s.id === 'b')!;
    const c = result.specs.find((s) => s.id === 'c')!;
    expect(a.status).toBe('failed');
    expect(b.status).toBe('failed'); // independent, attempted in dry-run
    expect(c.status).toBe('blocked');
    if (c.status === 'blocked') {
      expect(c.blocked_by).toContain('a');
    }
  });

  it('propagates blockage transitively: a fails, b depends on a, c depends on b', () => {
    const f = makeFixture();
    writeSpec(f.root, 'a');
    writeSpec(f.root, 'b', { dependsOn: ['a'] });
    writeSpec(f.root, 'c', { dependsOn: ['b'] });
    const result = runOrchestrator({
      args: ['a', 'b', 'c'],
      config: f.config,
      projectRoot: f.root,
      artifactRoot: f.root,
      dryRun: true,
    });
    const a = result.specs.find((s) => s.id === 'a')!;
    const b = result.specs.find((s) => s.id === 'b')!;
    const c = result.specs.find((s) => s.id === 'c')!;
    expect(a.status).toBe('failed');
    expect(b.status).toBe('blocked');
    expect(c.status).toBe('blocked');
    if (c.status === 'blocked') {
      // c's direct upstream is b (not a). Both are non-completed, so
      // c is blocked by 'b'.
      expect(c.blocked_by).toContain('b');
    }
  });

  it("aggregates message correctly: 'completed', 'failed', 'blocked' counts all add up", () => {
    const f = makeFixture();
    writeSpec(f.root, 'a');
    writeSpec(f.root, 'b', { dependsOn: ['a'] });
    const result = runOrchestrator({
      args: ['a', 'b'],
      config: f.config,
      projectRoot: f.root,
      artifactRoot: f.root,
      dryRun: true,
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('1 failed');
    expect(result.message).toContain('1 blocked');
  });
});

// ---------------------------------------------------------------------------
// runOrchestrator — completed-when-feature-already-done short-circuit
//
// When a feature for the spec already exists with status `completed`,
// the spec's pipeline early-exits in runSingleSpec ("Nothing to do.").
// The outcome is `completed`. Verify this works in a multi-spec run
// where the dependent spec is also pre-completed: both come out as
// `completed`, success is true.
// ---------------------------------------------------------------------------

describe('runOrchestrator — pre-completed features', () => {
  it("treats a spec with a pre-existing 'completed' feature as completed", () => {
    const f = makeFixture();
    writeSpec(f.root, 'done-spec');
    // Pre-create the intent so we don't go through ensureIntentForSpec.
    mkdirSync(join(f.root, 'features'), { recursive: true });
    mkdirSync(join(f.root, 'intents'), { recursive: true });
    writeFileSync(
      join(f.root, 'intents', 'done-spec.json'),
      JSON.stringify({
        id: 'done-spec',
        title: 'Spec done-spec',
        spec_path: 'specs/done-spec.md',
        status: 'planned',
        depends_on: [],
        feature_id: 'feat-done',
        created_by: { kind: 'cli', id: 'test' },
        created_at: '2026-04-29T00:00:00.000Z',
      }, null, 2),
      'utf-8',
    );
    writeFileSync(
      join(f.root, 'features', 'feat-done.json'),
      JSON.stringify({
        id: 'feat-done',
        intent_id: 'done-spec',
        status: 'completed',
        packets: [],
      }, null, 2),
      'utf-8',
    );

    const result = runOrchestrator({
      args: ['done-spec'],
      config: f.config,
      projectRoot: f.root,
      artifactRoot: f.root,
      dryRun: true,
    });
    expect(result.success).toBe(true);
    expect(result.specs).toHaveLength(1);
    expect(result.specs[0]!.status).toBe('completed');
    if (result.specs[0]!.status === 'completed') {
      expect(result.specs[0]!.feature_id).toBe('feat-done');
    }
  });

  it("does NOT block downstream specs when an upstream is pre-completed", () => {
    const f = makeFixture();
    writeSpec(f.root, 'up');
    writeSpec(f.root, 'down', { dependsOn: ['up'] });
    mkdirSync(join(f.root, 'features'), { recursive: true });
    mkdirSync(join(f.root, 'intents'), { recursive: true });
    writeFileSync(
      join(f.root, 'intents', 'up.json'),
      JSON.stringify({
        id: 'up',
        title: 'Spec up',
        spec_path: 'specs/up.md',
        status: 'planned',
        depends_on: [],
        feature_id: 'feat-up',
        created_by: { kind: 'cli', id: 'test' },
        created_at: '2026-04-29T00:00:00.000Z',
      }, null, 2),
      'utf-8',
    );
    writeFileSync(
      join(f.root, 'features', 'feat-up.json'),
      JSON.stringify({
        id: 'feat-up',
        intent_id: 'up',
        status: 'completed',
        packets: [],
      }, null, 2),
      'utf-8',
    );

    const result = runOrchestrator({
      args: ['up', 'down'],
      config: f.config,
      projectRoot: f.root,
      artifactRoot: f.root,
      dryRun: true,
    });
    const up = result.specs.find((s) => s.id === 'up')!;
    const down = result.specs.find((s) => s.id === 'down')!;
    expect(up.status).toBe('completed');
    // 'up' completed, so 'down' is NOT blocked. Dry-run still fails
    // it at the planning step, but that's failed-on-its-own-merits,
    // not blocked-by-upstream.
    expect(down.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// runOrchestrator — duplicate args are deduped at the arg-resolution
// layer, so a duplicate id in the CLI args produces a single outcome.
// ---------------------------------------------------------------------------

describe('runOrchestrator — dedup behavior', () => {
  it('produces one outcome when the same spec id is passed twice', () => {
    const f = makeFixture();
    writeSpec(f.root, 'unique');
    const result = runOrchestrator({
      args: ['unique', 'unique'],
      config: f.config,
      projectRoot: f.root,
      artifactRoot: f.root,
      dryRun: true,
    });
    expect(result.specs).toHaveLength(1);
    expect(result.specs[0]!.id).toBe('unique');
  });
});

// ---------------------------------------------------------------------------
// runOrchestrator — intent file generation side effect
//
// On a successful resolution of a spec arg, the orchestrator's
// resolveAll path materializes intents/<id>.json via ensureIntentForSpec
// (Phase 4 contract). Verify: the file appears on disk after the run
// even though we used dry-run.
// ---------------------------------------------------------------------------

describe('runOrchestrator — spec→intent materialization', () => {
  it('materializes intents/<id>.json for each spec arg', () => {
    const f = makeFixture();
    writeSpec(f.root, 'one');
    writeSpec(f.root, 'two');
    runOrchestrator({
      args: ['one', 'two'],
      config: f.config,
      projectRoot: f.root,
      artifactRoot: f.root,
      dryRun: true,
    });
    expect(existsSync(join(f.root, 'intents', 'one.json'))).toBe(true);
    expect(existsSync(join(f.root, 'intents', 'two.json'))).toBe(true);
    const oneJson = JSON.parse(readFileSync(join(f.root, 'intents', 'one.json'), 'utf-8'));
    expect(oneJson.id).toBe('one');
  });
});
