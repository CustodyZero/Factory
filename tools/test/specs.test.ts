/**
 * Tests for the spec loader (I/O wrapper around tools/pipeline/spec_parse).
 *
 * These tests use real tmpdir fixtures rather than mocks: the contract
 * being verified IS the disk-shaped one (filename<->id match, idempotent
 * intent generation, mismatch detection on re-run). Mocking the filesystem
 * here would erase the meaningful failure modes — see the no-facades rule
 * in CLAUDE.md.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpec, ensureIntentForSpec, SpecLoadError } from '../specs.js';

interface Fixture {
  readonly root: string;
}

let fixture: Fixture | null = null;
afterEach(() => {
  if (fixture !== null) {
    rmSync(fixture.root, { recursive: true, force: true });
    fixture = null;
  }
});

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'spec-loader-'));
  return { root };
}

function writeSpec(root: string, id: string, body: string): void {
  mkdirSync(join(root, 'specs'), { recursive: true });
  writeFileSync(join(root, 'specs', `${id}.md`), body, 'utf-8');
}

const NOW = '2026-04-29T12:00:00.000Z';

// ---------------------------------------------------------------------------
// loadSpec
// ---------------------------------------------------------------------------

describe('loadSpec', () => {
  it('parses a real spec file and returns absolute + relative paths', () => {
    fixture = makeFixture();
    const f = fixture;
    writeSpec(f.root, 'foo', '---\nid: foo\ntitle: My title\n---\n\nbody\n');

    const loaded = loadSpec('foo', f.root);

    expect(loaded.spec.frontmatter.id).toBe('foo');
    expect(loaded.spec.frontmatter.title).toBe('My title');
    expect(loaded.relativePath).toBe(join('specs', 'foo.md'));
    expect(loaded.path).toBe(join(f.root, 'specs', 'foo.md'));
  });

  it('throws SpecLoadError when the file does not exist', () => {
    fixture = makeFixture();
    const f = fixture;
    expect(() => loadSpec('missing', f.root)).toThrow(SpecLoadError);
    expect(() => loadSpec('missing', f.root)).toThrow(/Spec not found/);
  });

  it('throws SpecLoadError when the parsed id does not match the filename stem', () => {
    fixture = makeFixture();
    const f = fixture;
    // File is named foo.md but declares id: bar
    writeSpec(f.root, 'foo', '---\nid: bar\ntitle: t\n---\n');
    expect(() => loadSpec('foo', f.root)).toThrow(/id mismatch/);
  });

  it('propagates parser errors when the frontmatter is malformed', () => {
    fixture = makeFixture();
    const f = fixture;
    writeSpec(f.root, 'broken', 'no frontmatter at all\n');
    expect(() => loadSpec('broken', f.root)).toThrow(/missing frontmatter/);
  });
});

// ---------------------------------------------------------------------------
// ensureIntentForSpec
// ---------------------------------------------------------------------------

describe('ensureIntentForSpec', () => {
  it('creates intents/<id>.json on first run with all required fields', () => {
    fixture = makeFixture();
    const f = fixture;
    writeSpec(f.root, 'foo', '---\nid: foo\ntitle: A title\ndepends_on: [bar]\n---\n');
    const loaded = loadSpec('foo', f.root);

    const result = ensureIntentForSpec({
      spec: loaded,
      artifactRoot: f.root,
      creatorId: 'factory-run',
      now: NOW,
    });

    expect(result.created).toBe(true);
    expect(result.updated).toBe(false);
    expect(result.intentId).toBe('foo');
    expect(existsSync(join(f.root, 'intents', 'foo.json'))).toBe(true);

    const intent = JSON.parse(readFileSync(join(f.root, 'intents', 'foo.json'), 'utf-8'));
    expect(intent.id).toBe('foo');
    expect(intent.title).toBe('A title');
    expect(intent.spec_path).toBe(join('specs', 'foo.md'));
    expect(intent.status).toBe('proposed');
    expect(intent.depends_on).toEqual(['bar']);
    expect(intent.created_by).toEqual({ kind: 'cli', id: 'factory-run' });
    expect(intent.created_at).toBe(NOW);
  });

  it('is idempotent on second run: returns created: false and does NOT rewrite the file', () => {
    fixture = makeFixture();
    const f = fixture;
    writeSpec(f.root, 'foo', '---\nid: foo\ntitle: t\n---\n');
    const loaded = loadSpec('foo', f.root);

    const first = ensureIntentForSpec({
      spec: loaded,
      artifactRoot: f.root,
      creatorId: 'factory-run',
      now: NOW,
    });
    expect(first.created).toBe(true);

    const intentPath = first.intentPath;
    const before = readFileSync(intentPath, 'utf-8');
    const mtimeBefore = statSync(intentPath).mtimeMs;
    // Spin briefly so any unintended rewrite produces a distinct mtime.
    const start = Date.now();
    while (Date.now() - start < 20) { /* spin */ }

    const second = ensureIntentForSpec({
      spec: loaded,
      artifactRoot: f.root,
      creatorId: 'factory-run',
      now: '2099-01-01T00:00:00.000Z', // different timestamp, must be ignored
    });

    expect(second.created).toBe(false);
    expect(second.updated).toBe(false);
    expect(second.intentId).toBe('foo');
    expect(readFileSync(intentPath, 'utf-8')).toBe(before);
    expect(statSync(intentPath).mtimeMs).toBe(mtimeBefore);
  });

  it('reconciles spec-derived fields on re-run while preserving runtime state', () => {
    fixture = makeFixture();
    const f = fixture;
    writeSpec(f.root, 'foo', '---\nid: foo\ntitle: Old title\ndepends_on: [a]\n---\n');
    const loaded = loadSpec('foo', f.root);

    const first = ensureIntentForSpec({
      spec: loaded,
      artifactRoot: f.root,
      creatorId: 'factory-run',
      now: NOW,
    });
    expect(first.created).toBe(true);

    writeSpec(f.root, 'foo', '---\nid: foo\ntitle: New title\ndepends_on: [a, b]\n---\n');
    const loadedUpdated = loadSpec('foo', f.root);
    const intentPath = first.intentPath;
    const existing = JSON.parse(readFileSync(intentPath, 'utf-8')) as Record<string, unknown>;
    existing['status'] = 'planned';
    existing['feature_id'] = 'foo-feature';
    writeFileSync(intentPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');

    const second = ensureIntentForSpec({
      spec: loadedUpdated,
      artifactRoot: f.root,
      creatorId: 'factory-run',
      now: '2099-01-01T00:00:00.000Z',
    });

    expect(second.created).toBe(false);
    expect(second.updated).toBe(true);

    const reconciled = JSON.parse(readFileSync(intentPath, 'utf-8'));
    expect(reconciled.title).toBe('New title');
    expect(reconciled.depends_on).toEqual(['a', 'b']);
    expect(reconciled.status).toBe('planned');
    expect(reconciled.feature_id).toBe('foo-feature');
    expect(reconciled.created_at).toBe(NOW);
  });

  it('throws when an existing intent has a mismatched id', () => {
    fixture = makeFixture();
    const f = fixture;
    writeSpec(f.root, 'foo', '---\nid: foo\ntitle: t\n---\n');
    const loaded = loadSpec('foo', f.root);
    mkdirSync(join(f.root, 'intents'), { recursive: true });
    writeFileSync(
      join(f.root, 'intents', 'foo.json'),
      JSON.stringify({ id: 'baz', title: 't', spec_path: 'specs/foo.md' }, null, 2),
      'utf-8',
    );

    expect(() => ensureIntentForSpec({
      spec: loaded,
      artifactRoot: f.root,
      creatorId: 'factory-run',
      now: NOW,
    })).toThrow(/declares id 'baz'/);
  });

  it('throws when an existing intent has a mismatched spec_path', () => {
    fixture = makeFixture();
    const f = fixture;
    writeSpec(f.root, 'foo', '---\nid: foo\ntitle: t\n---\n');
    const loaded = loadSpec('foo', f.root);
    mkdirSync(join(f.root, 'intents'), { recursive: true });
    writeFileSync(
      join(f.root, 'intents', 'foo.json'),
      JSON.stringify({ id: 'foo', title: 't', spec_path: 'docs/specs/foo.md' }, null, 2),
      'utf-8',
    );

    expect(() => ensureIntentForSpec({
      spec: loaded,
      artifactRoot: f.root,
      creatorId: 'factory-run',
      now: NOW,
    })).toThrow(/spec_path 'docs\/specs\/foo\.md'/);
  });

  it('uses the current ISO timestamp when `now` is not injected', () => {
    fixture = makeFixture();
    const f = fixture;
    writeSpec(f.root, 'foo', '---\nid: foo\ntitle: t\n---\n');
    const loaded = loadSpec('foo', f.root);

    const before = Date.now();
    const result = ensureIntentForSpec({
      spec: loaded,
      artifactRoot: f.root,
      creatorId: 'factory-run',
    });
    const after = Date.now();

    expect(result.created).toBe(true);
    const intent = JSON.parse(readFileSync(result.intentPath, 'utf-8'));
    expect(typeof intent.created_at).toBe('string');
    const ts = new Date(intent.created_at).getTime();
    // Generated timestamp should fall inside the wall-clock window
    // bracketing the call. This pins that the function reads system
    // time, not some hardcoded value.
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('creates the intents/ directory if it does not yet exist', () => {
    fixture = makeFixture();
    const f = fixture;
    writeSpec(f.root, 'foo', '---\nid: foo\ntitle: t\n---\n');
    const loaded = loadSpec('foo', f.root);

    expect(existsSync(join(f.root, 'intents'))).toBe(false);
    const result = ensureIntentForSpec({
      spec: loaded,
      artifactRoot: f.root,
      creatorId: 'factory-run',
      now: NOW,
    });
    expect(result.created).toBe(true);
    expect(existsSync(join(f.root, 'intents'))).toBe(true);
  });
});
