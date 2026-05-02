/**
 * CLI smoke tests for run.ts argument disambiguation (Phase 4).
 *
 * Phase 4 of specs/single-entry-pipeline.md teaches run.ts to accept a
 * spec id as its argument. The disambiguation rule (spec-first):
 *
 *   1. specs/<arg>.md exists -> spec mode (load + ensure intent)
 *   2. intents/<arg>.json exists -> legacy intent mode
 *   3. neither -> error with both paths in the message
 *
 * These tests drive run.ts via spawnSync into a tmpdir, in --dry-run mode
 * so the planner is not actually invoked. Dry-run still exercises the
 * argument-resolution path, the spec parsing, and the intent generation
 * (ensureIntentForSpec runs before the dry-run early-exit).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = resolve(fileURLToPath(import.meta.url), '..', '..');

interface Fixture {
  readonly root: string;
}

let fixtures: Fixture[] = [];
afterEach(() => {
  for (const f of fixtures) rmSync(f.root, { recursive: true, force: true });
  fixtures = [];
});

function makeBaseConfig(): Record<string, unknown> {
  return {
    project_name: 'run-spec-arg',
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
  };
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'run-spec-arg-'));
  writeFileSync(
    join(root, 'factory.config.json'),
    JSON.stringify(makeBaseConfig(), null, 2),
    'utf-8',
  );
  fixtures.push({ root });
  return { root };
}

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runRun(args: ReadonlyArray<string>, cwd: string): Run {
  const scriptPath = join(TOOLS_DIR, 'run.ts');
  const result = spawnSync('npx', ['tsx', scriptPath, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// ---------------------------------------------------------------------------
// Spec mode: spec exists, intent does not
// ---------------------------------------------------------------------------

describe('run.ts — spec mode (spec only, no intent)', () => {
  it('generates intents/<id>.json from the spec on first run', () => {
    const f = makeFixture();
    mkdirSync(join(f.root, 'specs'), { recursive: true });
    writeFileSync(
      join(f.root, 'specs', 'foo.md'),
      '---\nid: foo\ntitle: A title\n---\n\nbody\n',
      'utf-8',
    );
    expect(existsSync(join(f.root, 'intents', 'foo.json'))).toBe(false);

    const r = runRun(['foo', '--dry-run'], f.root);
    void r;

    // The dry-run path exits 0 (legacy single-arg preview contract).
    // What we verify HERE is that the intent file was materialized
    // BEFORE the dry-run early-exit at the planning step.
    expect(existsSync(join(f.root, 'intents', 'foo.json'))).toBe(true);

    const intent = JSON.parse(
      readFileSync(join(f.root, 'intents', 'foo.json'), 'utf-8'),
    );
    expect(intent.id).toBe('foo');
    expect(intent.title).toBe('A title');
    expect(intent.spec_path).toBe(join('specs', 'foo.md'));
    expect(intent.depends_on).toEqual([]);
    // Stderr (where fmt.log writes) carries the "Generated intent..." log.
    expect(r.stderr).toContain('Generated intent from spec');
  });

  it('errors when a single-spec arg has depends_on but the dep is not passed (Phase 5)', () => {
    // Phase 5 implements multi-spec sequencing. The user is required
    // to pass all transitive deps explicitly; a single-arg invocation
    // for a spec that declares deps is a missing-transitive-dep
    // error (no agent is invoked). Replaces the Phase 4 stale-
    // sequencing warning that this test used to assert.
    const f = makeFixture();
    mkdirSync(join(f.root, 'specs'), { recursive: true });
    writeFileSync(
      join(f.root, 'specs', 'a.md'),
      '---\nid: a\ntitle: A\ndepends_on: [b]\n---\n',
      'utf-8',
    );

    const r = runRun(['a', '--dry-run'], f.root);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Missing transitive dependency');
    expect(r.stderr).toContain("'a'");
    expect(r.stderr).toContain("'b'");
  });
});

// ---------------------------------------------------------------------------
// Legacy intent mode: only intent exists
// ---------------------------------------------------------------------------

describe('run.ts — legacy mode (intent only, no spec)', () => {
  it('uses intents/<id>.json directly when no spec exists', () => {
    const f = makeFixture();
    mkdirSync(join(f.root, 'intents'), { recursive: true });
    writeFileSync(
      join(f.root, 'intents', 'bar.json'),
      JSON.stringify(
        {
          id: 'bar',
          title: 'legacy intent',
          spec: 'inline spec body',
          status: 'proposed',
          created_by: { kind: 'cli', id: 'factory-run' },
          created_at: '2026-04-29T00:00:00.000Z',
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );

    const r = runRun(['bar', '--dry-run'], f.root);

    // Legacy: no spec file is created, no "Generated intent" log.
    expect(existsSync(join(f.root, 'specs'))).toBe(false);
    expect(r.stderr).not.toContain('Generated intent from spec');
    // The dry-run path still loads the intent and reaches PLANNING.
    expect(r.stderr).toContain('PLANNING');
    expect(r.stderr).toContain('legacy intent');
  });
});

// ---------------------------------------------------------------------------
// Both: ensure no regeneration when intent already matches the spec
// ---------------------------------------------------------------------------

describe('run.ts — both spec and intent present', () => {
  it('does NOT regenerate the intent file on subsequent runs', () => {
    const f = makeFixture();
    mkdirSync(join(f.root, 'specs'), { recursive: true });
    writeFileSync(
      join(f.root, 'specs', 'shared.md'),
      '---\nid: shared\ntitle: shared title\n---\n',
      'utf-8',
    );
    // First run materializes the intent.
    runRun(['shared', '--dry-run'], f.root);
    const intentPath = join(f.root, 'intents', 'shared.json');
    expect(existsSync(intentPath)).toBe(true);
    const before = readFileSync(intentPath, 'utf-8');
    const mtimeBefore = statSync(intentPath).mtimeMs;
    // Spin briefly so any unintended rewrite produces a distinct mtime.
    const start = Date.now();
    while (Date.now() - start < 20) { /* spin */ }

    const r = runRun(['shared', '--dry-run'], f.root);

    expect(readFileSync(intentPath, 'utf-8')).toBe(before);
    expect(statSync(intentPath).mtimeMs).toBe(mtimeBefore);
    expect(r.stderr).not.toContain('Generated intent from spec');
  });

  it('errors when the intent disagrees with the spec on id', () => {
    const f = makeFixture();
    mkdirSync(join(f.root, 'specs'), { recursive: true });
    writeFileSync(
      join(f.root, 'specs', 'foo.md'),
      '---\nid: foo\ntitle: t\n---\n',
      'utf-8',
    );
    mkdirSync(join(f.root, 'intents'), { recursive: true });
    writeFileSync(
      join(f.root, 'intents', 'foo.json'),
      JSON.stringify(
        {
          id: 'wrong',
          title: 't',
          spec_path: 'specs/foo.md',
          status: 'proposed',
          created_by: { kind: 'cli', id: 'x' },
          created_at: '2026-04-29T00:00:00.000Z',
        },
        null,
        2,
      ),
      'utf-8',
    );

    const r = runRun(['foo', '--dry-run'], f.root);
    expect(r.stderr).toContain("declares id 'wrong'");
  });
});

// ---------------------------------------------------------------------------
// Neither: clear error message naming both paths
// ---------------------------------------------------------------------------

describe('run.ts — neither spec nor intent', () => {
  it('errors with a message that names both checked paths', () => {
    const f = makeFixture();

    const r = runRun(['ghost', '--dry-run'], f.root);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('No spec or intent found');
    expect(r.stderr).toContain('specs/ghost.md');
    expect(r.stderr).toContain('intents/ghost.json');
  });
});

// ---------------------------------------------------------------------------
// Phase 5 — multi-spec dispatch through the CLI
//
// These tests drive the run.ts CLI with multiple positional args. They
// verify the end-to-end glue path (argv parse -> runOrchestrator ->
// renderSummary -> exit code) on top of the orchestrator unit tests in
// tools/test/orchestrator.test.ts.
// ---------------------------------------------------------------------------

describe('run.ts — Phase 5 multi-spec CLI dispatch', () => {
  it('accepts multiple positional args and processes them all', () => {
    const f = makeFixture();
    mkdirSync(join(f.root, 'specs'), { recursive: true });
    writeFileSync(
      join(f.root, 'specs', 'one.md'),
      '---\nid: one\ntitle: One\n---\n',
      'utf-8',
    );
    writeFileSync(
      join(f.root, 'specs', 'two.md'),
      '---\nid: two\ntitle: Two\n---\n',
      'utf-8',
    );

    const r = runRun(['one', 'two', '--dry-run'], f.root);

    // Both intents materialized in the spec→intent translation step.
    expect(existsSync(join(f.root, 'intents', 'one.json'))).toBe(true);
    expect(existsSync(join(f.root, 'intents', 'two.json'))).toBe(true);
    // Multi-spec banner appears in stderr.
    expect(r.stderr).toContain('Multi-spec run');
    // Both specs are listed in the final summary.
    expect(r.stderr).toContain('one');
    expect(r.stderr).toContain('two');
  });

  it('errors before invoking any agent when a 2-spec cycle is detected', () => {
    const f = makeFixture();
    mkdirSync(join(f.root, 'specs'), { recursive: true });
    writeFileSync(
      join(f.root, 'specs', 'a.md'),
      '---\nid: a\ntitle: A\ndepends_on: [b]\n---\n',
      'utf-8',
    );
    writeFileSync(
      join(f.root, 'specs', 'b.md'),
      '---\nid: b\ntitle: B\ndepends_on: [a]\n---\n',
      'utf-8',
    );

    const r = runRun(['a', 'b', '--dry-run'], f.root);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Cyclic spec dependency');
    // PLANNING never reached.
    expect(r.stderr).not.toContain('PLANNING');
  });

  it('errors before invoking any agent when transitive deps are missing', () => {
    const f = makeFixture();
    mkdirSync(join(f.root, 'specs'), { recursive: true });
    writeFileSync(
      join(f.root, 'specs', 'a.md'),
      '---\nid: a\ntitle: A\ndepends_on: [b]\n---\n',
      'utf-8',
    );
    writeFileSync(
      join(f.root, 'specs', 'b.md'),
      '---\nid: b\ntitle: B\n---\n',
      'utf-8',
    );

    // User passed only `a` — but `a` depends on `b`.
    const r = runRun(['a', '--dry-run'], f.root);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Missing transitive dependency');
    expect(r.stderr).not.toContain('PLANNING');
  });

  it('marks dependents as blocked when an upstream fails (multi-spec)', () => {
    // Failure vehicle: 'a' is a legacy intent file with malformed JSON.
    // _resolveAll only existsSync-checks the legacy intent path, so
    // resolution succeeds; runSingleSpec then fails at intent parse.
    // 'b' is a spec with depends_on: [a] — it must come out blocked.
    // (The old version of this test used `a` as a spec and relied on
    // dry-run-stops-at-planning being a `failed` outcome. Round 2
    // restored the legacy --dry-run preview contract, so dry-run is
    // now `completed`; we need a real failure vehicle here.)
    const f = makeFixture();
    mkdirSync(join(f.root, 'intents'), { recursive: true });
    writeFileSync(join(f.root, 'intents', 'a.json'), '{not valid json', 'utf-8');
    mkdirSync(join(f.root, 'specs'), { recursive: true });
    writeFileSync(
      join(f.root, 'specs', 'b.md'),
      '---\nid: b\ntitle: B\ndepends_on: [a]\n---\n',
      'utf-8',
    );

    const r = runRun(['a', 'b', '--dry-run', '--json'], f.root);

    expect(r.status).toBe(1);
    // Multi-arg JSON mode: new envelope shape (specs/success/message).
    const parsed = JSON.parse(r.stdout);
    expect(parsed.success).toBe(false);
    expect(parsed.specs).toHaveLength(2);
    const a = parsed.specs.find((s: { id: string }) => s.id === 'a');
    const b = parsed.specs.find((s: { id: string }) => s.id === 'b');
    expect(a.status).toBe('failed');
    expect(b.status).toBe('blocked');
    expect(b.blocked_by).toContain('a');
  });

  it('preserves legacy --dry-run preview contract for single-arg runs (exit 0)', () => {
    // Pre-Phase-5 tools/run.ts:183 mapped dry-run-stops-at-planning to
    // exit 0 (a non-failing PREVIEW). Phase 5 round 1 broke that;
    // round 2 restored it. This test pins that contract end-to-end.
    const f = makeFixture();
    mkdirSync(join(f.root, 'specs'), { recursive: true });
    writeFileSync(
      join(f.root, 'specs', 'preview.md'),
      '---\nid: preview\ntitle: Preview\n---\n',
      'utf-8',
    );

    const r = runRun(['preview', '--dry-run'], f.root);

    expect(r.status).toBe(0);
    // The dry-run path still REACHES planning (banner printed) — that's
    // the behavior we're previewing.
    expect(r.stderr).toContain('PLANNING');
  });

  it('preserves legacy --json single-arg shape (legacy keys present, no envelope)', () => {
    // Pre-Phase-5 --json emitted a flat RunResult shape:
    //   { intent_id, feature_id, packets_completed, packets_failed,
    //     success, message }
    // Phase 5 round 1 silently switched to the OrchestratorResult
    // envelope (`{ specs, success, message }`) for ALL runs. Round 2
    // adapts back to the legacy shape iff exactly one positional arg
    // was passed. This test pins that adaptation end-to-end via the
    // CLI subprocess so the run.ts wiring is exercised, not just the
    // formatJsonOutput helper.
    const f = makeFixture();
    mkdirSync(join(f.root, 'specs'), { recursive: true });
    writeFileSync(
      join(f.root, 'specs', 'shape.md'),
      '---\nid: shape\ntitle: Shape\n---\n',
      'utf-8',
    );

    const r = runRun(['shape', '--dry-run', '--json'], f.root);

    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    // Legacy keys MUST be present.
    expect(parsed['intent_id']).toBe('shape');
    expect(Object.prototype.hasOwnProperty.call(parsed, 'feature_id')).toBe(true);
    expect(parsed['packets_completed']).toEqual([]);
    expect(parsed['packets_failed']).toEqual([]);
    expect(parsed['success']).toBe(true);
    expect(typeof parsed['message']).toBe('string');
    // New envelope key MUST NOT be present (single-arg legacy mode).
    expect(parsed['specs']).toBeUndefined();
  });
});
