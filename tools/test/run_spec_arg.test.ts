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

    // The dry-run path exits non-zero with the "Dry run — planning would
    // be invoked" message because no agent runs. That's expected; what
    // we verify is that the intent file was materialized BEFORE the
    // dry-run early-exit.
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

  it('warns about depends_on when present (Phase 5 sequencing not yet implemented)', () => {
    const f = makeFixture();
    mkdirSync(join(f.root, 'specs'), { recursive: true });
    writeFileSync(
      join(f.root, 'specs', 'a.md'),
      '---\nid: a\ntitle: A\ndepends_on: [b]\n---\n',
      'utf-8',
    );

    const r = runRun(['a', '--dry-run'], f.root);

    expect(r.stderr).toContain('depends_on');
    expect(r.stderr).toContain('not yet implemented');
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
