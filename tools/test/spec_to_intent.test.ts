/**
 * Tests for the pure spec → intent translator.
 *
 * Per the spec_artifact_model decision, factory translates each spec
 * (the human authoring artifact) into exactly one intent (the locked
 * downstream contract). specToIntent does that translation as a pure
 * function: parsed spec + injected metadata in, intent JS object out.
 *
 * These tests pin:
 *   - all required intent fields are populated from the spec
 *   - depends_on round-trips (default empty, present-as-given)
 *   - the injected `now` and `creatorId` reach the output
 *   - the function is referentially transparent (same input -> same output)
 */

import { describe, it, expect } from 'vitest';
import { parseSpec, specToIntent } from '../pipeline/spec_parse.js';

const NOW = '2026-04-29T12:00:00.000Z';

function specOf(content: string) {
  return parseSpec(content);
}

describe('specToIntent', () => {
  it('produces all required intent fields from a minimal spec', () => {
    const spec = specOf('---\nid: foo\ntitle: A title\n---\nbody\n');
    const intent = specToIntent({
      spec,
      specPath: 'specs/foo.md',
      now: NOW,
      creatorId: 'factory-run',
    });

    expect(intent.id).toBe('foo');
    expect(intent.title).toBe('A title');
    expect(intent.spec_path).toBe('specs/foo.md');
    expect(intent.status).toBe('proposed');
    expect(intent.depends_on).toEqual([]);
    expect(intent.created_by).toEqual({ kind: 'cli', id: 'factory-run' });
    expect(intent.created_at).toBe(NOW);
  });

  it('defaults depends_on to an empty array when not specified in the spec', () => {
    const spec = specOf('---\nid: foo\ntitle: t\n---\n');
    const intent = specToIntent({
      spec,
      specPath: 'specs/foo.md',
      now: NOW,
      creatorId: 'factory-run',
    });
    expect(intent.depends_on).toEqual([]);
  });

  it('copies depends_on through verbatim when the spec declares it', () => {
    const spec = specOf('---\nid: foo\ntitle: t\ndepends_on: [a, b, c]\n---\n');
    const intent = specToIntent({
      spec,
      specPath: 'specs/foo.md',
      now: NOW,
      creatorId: 'factory-run',
    });
    expect(intent.depends_on).toEqual(['a', 'b', 'c']);
  });

  it('uses the injected creatorId rather than a hardcoded value', () => {
    const spec = specOf('---\nid: foo\ntitle: t\n---\n');
    const intent = specToIntent({
      spec,
      specPath: 'specs/foo.md',
      now: NOW,
      creatorId: 'host-project-cli',
    });
    expect(intent.created_by).toEqual({ kind: 'cli', id: 'host-project-cli' });
  });

  it('is deterministic: same inputs produce identical outputs', () => {
    const spec = specOf('---\nid: foo\ntitle: t\ndepends_on: [a]\n---\n');
    const a = specToIntent({ spec, specPath: 'specs/foo.md', now: NOW, creatorId: 'x' });
    const b = specToIntent({ spec, specPath: 'specs/foo.md', now: NOW, creatorId: 'x' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
