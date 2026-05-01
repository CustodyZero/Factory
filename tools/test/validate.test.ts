/**
 * CLI smoke tests for tools/validate.ts.
 *
 * validate.ts walks the project root discovered at module load time, so
 * the cleanest way to drive it under fixtures is via spawnSync into a
 * tmpdir that contains its own factory.config.json. This is the same
 * pattern lifecycle_cli.test.ts already uses for the lifecycle scripts.
 *
 * Phase 4 of specs/single-entry-pipeline.md teaches validate.ts to walk
 * `specs/` and to report cycles in `depends_on`. These tests pin:
 *   - A valid spec passes validation
 *   - Malformed spec frontmatter is reported with the file path
 *   - Filename / id mismatch is reported
 *   - Cyclic spec dependencies (A -> B -> A) are reported
 *   - Intent depends_on validation: bad type is rejected
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = resolve(fileURLToPath(import.meta.url), '..', '..');

interface Fixture {
  readonly root: string;
}

function makeBaseConfig(): Record<string, unknown> {
  return {
    project_name: 'validate-test',
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

let fixtures: Fixture[] = [];
afterEach(() => {
  for (const f of fixtures) rmSync(f.root, { recursive: true, force: true });
  fixtures = [];
});

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'validate-test-'));
  writeFileSync(
    join(root, 'factory.config.json'),
    JSON.stringify(makeBaseConfig(), null, 2),
    'utf-8',
  );
  fixtures.push({ root });
  return { root };
}

function writeSpec(root: string, filename: string, body: string): void {
  mkdirSync(join(root, 'specs'), { recursive: true });
  writeFileSync(join(root, 'specs', filename), body, 'utf-8');
}

function writeIntent(root: string, intent: Record<string, unknown>): void {
  mkdirSync(join(root, 'intents'), { recursive: true });
  writeFileSync(
    join(root, 'intents', `${String(intent['id'])}.json`),
    JSON.stringify(intent, null, 2) + '\n',
    'utf-8',
  );
}

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runValidate(cwd: string): Run {
  const scriptPath = join(TOOLS_DIR, 'validate.ts');
  const result = spawnSync('npx', ['tsx', scriptPath], {
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
// Spec validation
// ---------------------------------------------------------------------------

describe('validate.ts — spec frontmatter', () => {
  it('passes when a single valid spec is present and there are no other artifacts', () => {
    const f = makeFixture();
    writeSpec(f.root, 'foo.md', '---\nid: foo\ntitle: A title\n---\n\nbody\n');

    const r = runValidate(f.root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS');
    expect(r.stdout).toContain('1 specs');
  });

  it('reports malformed frontmatter with the spec file path', () => {
    const f = makeFixture();
    writeSpec(f.root, 'broken.md', 'no frontmatter here\n');

    const r = runValidate(f.root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FAIL');
    expect(r.stdout).toContain('specs/broken.md');
    expect(r.stdout).toContain('missing frontmatter');
  });

  it('reports filename / id mismatch', () => {
    const f = makeFixture();
    // File is foo.md but declares id: bar
    writeSpec(f.root, 'foo.md', '---\nid: bar\ntitle: t\n---\n');

    const r = runValidate(f.root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('specs/foo.md');
    expect(r.stdout).toContain('filename must match id');
  });

  it('reports cyclic spec dependencies (A -> B -> A)', () => {
    const f = makeFixture();
    writeSpec(f.root, 'a.md', '---\nid: a\ntitle: A\ndepends_on: [b]\n---\n');
    writeSpec(f.root, 'b.md', '---\nid: b\ntitle: B\ndepends_on: [a]\n---\n');

    const r = runValidate(f.root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Cyclic spec dependency');
    // Each member is reported once; both files mentioned.
    expect(r.stdout).toContain('specs/a.md');
    expect(r.stdout).toContain('specs/b.md');
  });

  it('reports a spec depending on a missing target', () => {
    const f = makeFixture();
    writeSpec(f.root, 'a.md', '---\nid: a\ntitle: A\ndepends_on: [ghost]\n---\n');

    const r = runValidate(f.root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("Spec 'a' depends_on 'ghost'");
  });

  it('passes a chain dependency (A -> B, no cycle)', () => {
    const f = makeFixture();
    writeSpec(f.root, 'a.md', '---\nid: a\ntitle: A\ndepends_on: [b]\n---\n');
    writeSpec(f.root, 'b.md', '---\nid: b\ntitle: B\n---\n');

    const r = runValidate(f.root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS');
  });
});

// ---------------------------------------------------------------------------
// Intent depends_on additive field
// ---------------------------------------------------------------------------

describe('validate.ts — intent depends_on field', () => {
  it('accepts an intent with depends_on as an array of kebab-case ids', () => {
    const f = makeFixture();
    writeIntent(f.root, {
      id: 'foo',
      title: 'foo',
      spec_path: 'specs/foo.md',
      status: 'proposed',
      depends_on: ['bar', 'baz'],
      created_by: { kind: 'cli', id: 'factory-run' },
      created_at: '2026-04-29T00:00:00.000Z',
    });
    // Spec file referenced by spec_path must exist or validate.ts errors.
    writeSpec(f.root, 'foo.md', '---\nid: foo\ntitle: foo\n---\n');

    const r = runValidate(f.root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS');
  });

  it('rejects an intent with depends_on that is not a string array', () => {
    const f = makeFixture();
    writeIntent(f.root, {
      id: 'foo',
      title: 'foo',
      spec_path: 'specs/foo.md',
      status: 'proposed',
      depends_on: 'bar',
      created_by: { kind: 'cli', id: 'factory-run' },
      created_at: '2026-04-29T00:00:00.000Z',
    });
    writeSpec(f.root, 'foo.md', '---\nid: foo\ntitle: foo\n---\n');

    const r = runValidate(f.root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("'depends_on' must be an array");
  });

  it('rejects an intent with depends_on entry that is not kebab-case', () => {
    const f = makeFixture();
    writeIntent(f.root, {
      id: 'foo',
      title: 'foo',
      spec_path: 'specs/foo.md',
      status: 'proposed',
      depends_on: ['Not_KebabCase'],
      created_by: { kind: 'cli', id: 'factory-run' },
      created_at: '2026-04-29T00:00:00.000Z',
    });
    writeSpec(f.root, 'foo.md', '---\nid: foo\ntitle: foo\n---\n');

    const r = runValidate(f.root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Not_KebabCase');
  });
});

// ---------------------------------------------------------------------------
// Backward-compatibility — pre-Phase-4 layouts must keep validating
// ---------------------------------------------------------------------------
//
// These pin compatibility with two flavors of pre-spec layouts that the
// decision doc commits to keep working:
//
//   1. No specs/ directory at all (a brand-new project that has not yet
//      authored any specs).
//   2. A legacy intent that exists with no corresponding spec — running
//      `run.ts <intent-id>` was always allowed for spec-less intents
//      (docs/decisions/spec_artifact_model.md, "What this does NOT decide").
//
// Both must validate cleanly so that adding spec support never silently
// breaks an existing host project.

describe('validate.ts — legacy / spec-less compatibility', () => {
  it('passes when there is no specs/ directory at all', () => {
    const f = makeFixture();
    // No specs/, no intents/, no other artifacts. Just factory.config.json.
    const r = runValidate(f.root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS');
  });

  it('passes a legacy intent-only fixture (no specs/ directory)', () => {
    const f = makeFixture();
    // Legacy intent shape: inline `spec` field, no spec_path, no specs/ dir.
    // This is the pre-Phase-4 layout that must continue to work.
    writeIntent(f.root, {
      id: 'legacy-intent',
      title: 'A legacy intent',
      spec: 'inline body for the planner',
      status: 'proposed',
      created_by: { kind: 'cli', id: 'factory-run' },
      created_at: '2026-04-29T00:00:00.000Z',
    });

    const r = runValidate(f.root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS');
  });
});
