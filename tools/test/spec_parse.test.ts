/**
 * Tests for the pure spec frontmatter parser.
 *
 * Phase 4 of specs/single-entry-pipeline.md introduces specs as a new
 * artifact at the top of the pipeline. parseSpec is the pure-logic core
 * of that work: it takes the file contents and returns a ParsedSpec, or
 * throws SpecParseError. No I/O.
 *
 * These tests pin:
 *   - the accepted frontmatter shape (delimiters, key:value, flow-list)
 *   - the rejected shapes (missing delimiters, missing required fields,
 *     unknown keys, malformed depends_on)
 *   - that the body is preserved verbatim (whitespace, multi-line content)
 */

import { describe, it, expect } from 'vitest';
import { parseSpec, SpecParseError } from '../pipeline/spec_parse.js';

describe('parseSpec — happy paths', () => {
  it('parses minimal valid frontmatter (id + title only)', () => {
    const content = '---\nid: foo\ntitle: A title\n---\n\nbody text\n';
    const result = parseSpec(content);
    expect(result.frontmatter.id).toBe('foo');
    expect(result.frontmatter.title).toBe('A title');
    expect(result.frontmatter.depends_on).toBeUndefined();
    // Lines after the closing `---`: '', 'body text', ''. Joined with \n.
    expect(result.body).toBe('\nbody text\n');
  });

  it('parses frontmatter with empty depends_on flow list', () => {
    const content = '---\nid: foo\ntitle: t\ndepends_on: []\n---\n';
    const result = parseSpec(content);
    expect(result.frontmatter.depends_on).toEqual([]);
  });

  it('parses depends_on with a single element', () => {
    const content = '---\nid: foo\ntitle: t\ndepends_on: [bar]\n---\n';
    const result = parseSpec(content);
    expect(result.frontmatter.depends_on).toEqual(['bar']);
  });

  it('parses depends_on with multiple elements and trims whitespace', () => {
    const content = '---\nid: foo\ntitle: t\ndepends_on: [a,  b , c]\n---\n';
    const result = parseSpec(content);
    expect(result.frontmatter.depends_on).toEqual(['a', 'b', 'c']);
  });

  it('preserves the markdown body verbatim including blank lines', () => {
    // Body is everything after the line that contains the closing `---`.
    // The newline that terminates the `---` line itself is NOT part of
    // the body — it is the line delimiter of `---`. This is consistent
    // with how YAML frontmatter parsers normally handle the boundary.
    const expectedBody = '# Heading\n\nFirst paragraph.\n\nSecond paragraph.\n';
    const content = `---\nid: foo\ntitle: t\n---\n${expectedBody}`;
    const result = parseSpec(content);
    expect(result.body).toBe(expectedBody);
  });

  it('tolerates leading blank lines before the opening delimiter', () => {
    const content = '\n\n---\nid: foo\ntitle: t\n---\n\nbody\n';
    const result = parseSpec(content);
    expect(result.frontmatter.id).toBe('foo');
    expect(result.body).toBe('\nbody\n');
  });

  it('allows blank lines inside frontmatter', () => {
    const content = '---\nid: foo\n\ntitle: t\n\ndepends_on: [a]\n---\n';
    const result = parseSpec(content);
    expect(result.frontmatter.id).toBe('foo');
    expect(result.frontmatter.title).toBe('t');
    expect(result.frontmatter.depends_on).toEqual(['a']);
  });

  it('preserves complex titles with punctuation and colons after the first one', () => {
    // The split-on-first-colon rule means values may contain colons.
    const content = '---\nid: foo\ntitle: A: subtitle, with punctuation!\n---\n';
    const result = parseSpec(content);
    expect(result.frontmatter.title).toBe('A: subtitle, with punctuation!');
  });
});

describe('parseSpec — rejected inputs', () => {
  it('rejects content with no frontmatter delimiters at all', () => {
    expect(() => parseSpec('# Just a body, no frontmatter\n')).toThrow(SpecParseError);
  });

  it('rejects content where the opening delimiter is missing', () => {
    // No `---` line at the top — this is a body-only file.
    const content = 'id: foo\ntitle: t\n---\n\nbody';
    expect(() => parseSpec(content)).toThrow(/missing frontmatter/);
  });

  it('rejects unclosed frontmatter (no closing delimiter)', () => {
    const content = '---\nid: foo\ntitle: t\n\nbody never closed';
    expect(() => parseSpec(content)).toThrow(/not closed/);
  });

  it('rejects missing id', () => {
    const content = '---\ntitle: t\n---\n';
    expect(() => parseSpec(content)).toThrow(/non-empty 'id'/);
  });

  it('rejects empty id', () => {
    const content = '---\nid:\ntitle: t\n---\n';
    expect(() => parseSpec(content)).toThrow(/non-empty 'id'/);
  });

  it('rejects missing title', () => {
    const content = '---\nid: foo\n---\n';
    expect(() => parseSpec(content)).toThrow(/non-empty 'title'/);
  });

  it('rejects empty title', () => {
    const content = '---\nid: foo\ntitle:\n---\n';
    expect(() => parseSpec(content)).toThrow(/non-empty 'title'/);
  });

  it('rejects unknown frontmatter keys (typo defense)', () => {
    const content = '---\nid: foo\ntitle: t\ndepnds_on: [a]\n---\n';
    expect(() => parseSpec(content)).toThrow(/Unknown frontmatter key/);
  });

  it('rejects duplicate keys', () => {
    const content = '---\nid: foo\ntitle: t\nid: bar\n---\n';
    expect(() => parseSpec(content)).toThrow(/Duplicate frontmatter key/);
  });

  it('rejects depends_on that is not a flow list', () => {
    const content = '---\nid: foo\ntitle: t\ndepends_on: bar\n---\n';
    expect(() => parseSpec(content)).toThrow(/inline array/);
  });

  it('rejects depends_on with an empty element from trailing comma', () => {
    const content = '---\nid: foo\ntitle: t\ndepends_on: [a, b, ]\n---\n';
    expect(() => parseSpec(content)).toThrow(/empty element/);
  });

  it('rejects a frontmatter line without a colon', () => {
    const content = '---\nid: foo\ntitle just a string\n---\n';
    expect(() => parseSpec(content)).toThrow(/'key: value'/);
  });

  it('rejects depends_on with bracketed nested-structure syntax', () => {
    const content = '---\nid: foo\ntitle: t\ndepends_on: [[a]]\n---\n';
    expect(() => parseSpec(content)).toThrow(/unsupported syntax/);
  });
});

// ---------------------------------------------------------------------------
// Comment handling — YAML-style `#` comments (per docs/decisions/spec_artifact_model.md)
// ---------------------------------------------------------------------------
//
// The decision doc shows the documented frontmatter format includes inline
// `# optional` comments on the depends_on line. parseSpec must accept this
// shape, so these tests pin both inline and full-line comment handling, and
// the rule that `#` inside a quoted string is treated as data, not a comment
// delimiter.

describe('parseSpec — comments', () => {
  it('strips an inline comment from a scalar value', () => {
    const content = '---\nid: foo\ntitle: hello # an inline comment\n---\n';
    const result = parseSpec(content);
    expect(result.frontmatter.title).toBe('hello');
  });

  it('strips an inline comment from a flow-list value (decision-doc form)', () => {
    const content =
      '---\nid: foo\ntitle: t\ndepends_on: [a, b]   # optional; default empty\n---\n';
    const result = parseSpec(content);
    expect(result.frontmatter.depends_on).toEqual(['a', 'b']);
  });

  it('skips full-line comments between fields', () => {
    const content =
      '---\nid: foo\n# a full-line comment between fields\ntitle: t\n---\n';
    const result = parseSpec(content);
    expect(result.frontmatter.id).toBe('foo');
    expect(result.frontmatter.title).toBe('t');
  });

  it('preserves `#` inside a double-quoted scalar value', () => {
    const content = '---\nid: foo\ntitle: "a # in title"\n---\n';
    const result = parseSpec(content);
    expect(result.frontmatter.title).toBe('a # in title');
  });

  it('preserves `#` inside a single-quoted scalar value', () => {
    const content = "---\nid: foo\ntitle: 'a # in title'\n---\n";
    const result = parseSpec(content);
    expect(result.frontmatter.title).toBe('a # in title');
  });

  it('preserves `#` inside a quoted flow-list element', () => {
    const content =
      '---\nid: foo\ntitle: t\ndepends_on: ["a # b", c]\n---\n';
    const result = parseSpec(content);
    expect(result.frontmatter.depends_on).toEqual(['a # b', 'c']);
  });

  it('parses the exact decision-doc frontmatter form (regression pin)', () => {
    // Drawn directly from docs/decisions/spec_artifact_model.md so any future
    // drift between parser and docs surfaces here. See the "File format"
    // example block in the decision document.
    const content = [
      '---',
      'id: example-spec',
      'title: A one-line title',
      'depends_on: [other-spec, another-spec]   # optional; default empty',
      '---',
      '',
      '# Free-form markdown body',
      '',
    ].join('\n');
    const result = parseSpec(content);
    expect(result.frontmatter.id).toBe('example-spec');
    expect(result.frontmatter.title).toBe('A one-line title');
    expect(result.frontmatter.depends_on).toEqual(['other-spec', 'another-spec']);
  });
});

// ---------------------------------------------------------------------------
// Quoted scalar handling — Approach A (strip optional surrounding quotes)
// ---------------------------------------------------------------------------
//
// The parser accepts an optional pair of matching `"..."` or `'...'` quotes
// around scalar values and around flow-list elements. The unquoted content
// is what gets stored. Mismatched/unclosed quotes are rejected. Escape
// sequences inside quotes are NOT supported (documented at the top of
// spec_parse.ts).

describe('parseSpec — quoted scalars', () => {
  it('strips double quotes from a top-level scalar', () => {
    const content = '---\nid: foo\ntitle: "A title"\n---\n';
    const result = parseSpec(content);
    expect(result.frontmatter.title).toBe('A title');
  });

  it('strips single quotes from a top-level scalar', () => {
    const content = "---\nid: foo\ntitle: 'A title'\n---\n";
    const result = parseSpec(content);
    expect(result.frontmatter.title).toBe('A title');
  });

  it('strips quotes from a single flow-list element', () => {
    const content = '---\nid: foo\ntitle: t\ndepends_on: ["a"]\n---\n';
    const result = parseSpec(content);
    expect(result.frontmatter.depends_on).toEqual(['a']);
  });

  it('handles a flow list mixing bare, double-quoted, and single-quoted elements', () => {
    const content = "---\nid: foo\ntitle: t\ndepends_on: [a, \"b\", 'c']\n---\n";
    const result = parseSpec(content);
    expect(result.frontmatter.depends_on).toEqual(['a', 'b', 'c']);
  });

  it('rejects an unclosed quoted scalar', () => {
    const content = '---\nid: foo\ntitle: "unclosed\n---\n';
    expect(() => parseSpec(content)).toThrow(/unclosed quoted value/);
  });

  it('rejects a quoted scalar with trailing content (no escape support)', () => {
    // `"A title with \"quotes\" inside"` would require escape support to be
    // useful. The parser instead rejects cleanly: the first `"` opens a
    // quote, the next `"` closes it, and content after that is rejected.
    const content =
      '---\nid: foo\ntitle: "A title with \\"quotes\\" inside"\n---\n';
    expect(() => parseSpec(content)).toThrow(/trailing content after a closing quote/);
  });
});
