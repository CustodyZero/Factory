/**
 * Factory — Spec frontmatter parser and spec→intent translator.
 *
 * SCOPE FOR PHASE 4
 *
 * Phase 4 of specs/single-entry-pipeline.md introduces a new artifact type:
 * the spec. Specs are markdown files at `specs/<id>.md` with a small YAML-like
 * frontmatter block. They are the human authoring surface; factory translates
 * each spec into an intent (1:1) which downstream tooling already consumes.
 *
 * This module is the pure-logic layer for that work:
 *
 *   - parseSpec(content): split frontmatter + body, validate frontmatter
 *     fields against the locked spec schema, throw SpecParseError on any
 *     violation. NO I/O.
 *   - specToIntent(opts): take a parsed spec plus injected metadata
 *     (timestamp, creator id, spec_path) and return an intent JS object.
 *     NO I/O — the caller writes it.
 *
 * The id<->filename match is intentionally NOT enforced here: parseSpec
 * receives a string, not a path. The loader (tools/specs.ts) compares
 * the parsed id against the filename stem and raises a clear error.
 *
 * Frontmatter format (deliberately minimal — we explicitly do NOT take a
 * YAML dependency for this):
 *
 *   ---
 *   id: spec-id
 *   title: A title
 *   depends_on: [other-spec, another-spec]
 *   ---
 *
 *   (markdown body)
 *
 * Accepted shape:
 *   - Lines start with `key: value` where the key is an ASCII identifier
 *   - `depends_on` is the only array field; inline `[a, b, c]` flow-list only
 *   - No nested mappings, anchors/aliases, or multi-line strings
 *   - Optional surrounding quotes (`"..."` or `'...'`) on scalar values and
 *     flow-list elements are accepted and stripped. Escape sequences inside
 *     quoted strings are NOT supported — `title: "with \"escapes\""` errors.
 *   - YAML-style comments are accepted: a `#` outside of a quoted region
 *     starts an end-of-line comment, and full-line comments are skipped.
 *   - Unknown keys are rejected to catch typos (e.g. `depnds_on`)
 *
 * If a host project ever needs richer frontmatter, the right move is to
 * widen this parser deliberately — not to silently accept fields it then
 * drops on the floor.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SpecFrontmatter {
  readonly id: string;
  readonly title: string;
  readonly depends_on?: ReadonlyArray<string>;
}

export interface ParsedSpec {
  readonly frontmatter: SpecFrontmatter;
  readonly body: string;
}

export class SpecParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecParseError';
  }
}

const KNOWN_KEYS = new Set(['id', 'title', 'depends_on']);
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---------------------------------------------------------------------------
// Frontmatter split
// ---------------------------------------------------------------------------

interface FrontmatterSplit {
  readonly frontmatterLines: ReadonlyArray<string>;
  readonly body: string;
}

function splitFrontmatter(content: string): FrontmatterSplit {
  const lines = content.split('\n');
  let i = 0;
  // Skip leading blank lines.
  while (i < lines.length && lines[i]!.trim() === '') i += 1;
  if (i >= lines.length || lines[i]!.trim() !== '---') {
    throw new SpecParseError(
      "Spec is missing frontmatter: the file must start with a '---' delimiter line",
    );
  }
  const openIdx = i;
  i += 1;
  const frontmatterLines: string[] = [];
  let closed = false;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '---') {
      closed = true;
      break;
    }
    frontmatterLines.push(line);
    i += 1;
  }
  if (!closed) {
    throw new SpecParseError(
      `Spec frontmatter is not closed: expected '---' delimiter after line ${openIdx + 1}`,
    );
  }
  // Body is everything after the closing delimiter; preserve a single
  // leading newline relationship with the original file. We rejoin from
  // i+1 so the body is exactly what the author wrote after `---`.
  const body = lines.slice(i + 1).join('\n');
  return { frontmatterLines, body };
}

// ---------------------------------------------------------------------------
// Comment stripping (quote-aware)
// ---------------------------------------------------------------------------

/**
 * Remove a trailing `# ...` comment from `line`, but only if the `#` is
 * NOT inside a `"..."` or `'...'` quoted region. Returns the line with
 * any inline comment discarded; the result is NOT trimmed (callers
 * decide). This is intentionally a single pass over the string so that
 * `#` inside quotes is preserved (e.g. `title: "a # b"`).
 *
 * Escape sequences are not supported — a backslash is treated as a
 * literal character. This matches the parser's overall "no escapes"
 * stance documented at the top of the file.
 */
function stripInlineComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === '#' && !inSingle && !inDouble) {
      return line.slice(0, i);
    }
  }
  return line;
}

// ---------------------------------------------------------------------------
// Scalar unquoting
// ---------------------------------------------------------------------------

/**
 * If `value` is wrapped in matching quotes (`"..."` or `'...'`), return
 * the inner content. Otherwise return `value` unchanged. An unclosed or
 * mismatched leading quote throws SpecParseError.
 *
 * Escape sequences inside the quoted string are NOT supported: any
 * additional matching-quote character anywhere inside the string is
 * treated as the closing quote, so `"a\"b"` is rejected as having
 * trailing content after the closing quote. Document and accept the
 * limitation rather than silently corrupting the value.
 */
function unquoteScalar(value: string, key: string): string {
  if (value.length === 0) return value;
  const first = value[0]!;
  if (first !== '"' && first !== "'") return value;
  // Find the matching closing quote.
  const closeIdx = value.indexOf(first, 1);
  if (closeIdx === -1) {
    throw new SpecParseError(
      `'${key}' has an unclosed quoted value: ${value}`,
    );
  }
  if (closeIdx !== value.length - 1) {
    throw new SpecParseError(
      `'${key}' has trailing content after a closing quote (escape sequences are not supported): ${value}`,
    );
  }
  return value.slice(1, closeIdx);
}

// ---------------------------------------------------------------------------
// Inline flow-list parser ([a, b, c]) — depends_on only
// ---------------------------------------------------------------------------

function parseFlowList(raw: string, key: string): string[] {
  // The caller has already stripped inline comments at the line level.
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    throw new SpecParseError(
      `'${key}' must be an inline array like [a, b, c]; got: ${raw}`,
    );
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner === '') return [];
  // Quote-aware split on commas so quoted elements may legally contain
  // commas. Brackets/braces inside elements remain rejected below as a
  // structural-syntax guard.
  const parts: string[] = [];
  {
    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    let start = 0;
    for (let i = 0; i < inner.length; i += 1) {
      const ch = inner[i]!;
      if (ch === "'" && !inDouble) {
        inSingle = !inSingle;
      } else if (ch === '"' && !inSingle) {
        inDouble = !inDouble;
      } else if (!inSingle && !inDouble) {
        if (ch === ',' && depth === 0) {
          parts.push(inner.slice(start, i).trim());
          start = i + 1;
        } else if (ch === '[' || ch === '{') {
          depth += 1;
        } else if (ch === ']' || ch === '}') {
          depth -= 1;
        }
      }
    }
    parts.push(inner.slice(start).trim());
  }
  const result: string[] = [];
  for (const p of parts) {
    if (p === '') {
      throw new SpecParseError(`'${key}' contains an empty element`);
    }
    // Reject nested-structure syntax. Quoting is now allowed and handled
    // by unquoteScalar below; brackets/braces still indicate unsupported
    // nested structures.
    if (/[[\]{}]/.test(p)) {
      throw new SpecParseError(
        `'${key}' element '${p}' uses unsupported syntax; bare identifiers or quoted strings only`,
      );
    }
    const unquoted = unquoteScalar(p, key);
    if (unquoted === '') {
      throw new SpecParseError(`'${key}' contains an empty element`);
    }
    result.push(unquoted);
  }
  return result;
}

// ---------------------------------------------------------------------------
// parseSpec — public entry
// ---------------------------------------------------------------------------

export function parseSpec(content: string): ParsedSpec {
  const { frontmatterLines, body } = splitFrontmatter(content);

  const fields: Record<string, string | string[]> = {};
  for (let lineNum = 0; lineNum < frontmatterLines.length; lineNum += 1) {
    const raw = frontmatterLines[lineNum]!;
    // Strip any quote-aware inline comment first so that downstream
    // value parsing sees only the data portion of the line. Full-line
    // comments (and lines that become empty after comment stripping)
    // are skipped entirely.
    const decommented = stripInlineComment(raw);
    const line = decommented.replace(/\s+$/, ''); // rtrim
    if (line.trim() === '') continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      throw new SpecParseError(
        `Frontmatter line ${lineNum + 1} is not 'key: value': '${raw}'`,
      );
    }
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (!KEY_RE.test(key)) {
      throw new SpecParseError(
        `Frontmatter key '${key}' on line ${lineNum + 1} is not a valid identifier`,
      );
    }
    if (!KNOWN_KEYS.has(key)) {
      throw new SpecParseError(
        `Unknown frontmatter key '${key}' (allowed: ${[...KNOWN_KEYS].join(', ')})`,
      );
    }
    if (key in fields) {
      throw new SpecParseError(`Duplicate frontmatter key '${key}'`);
    }
    if (key === 'depends_on') {
      fields[key] = parseFlowList(value, key);
    } else {
      fields[key] = unquoteScalar(value, key);
    }
  }

  const id = fields['id'];
  if (typeof id !== 'string' || id.length === 0) {
    throw new SpecParseError("Frontmatter must include a non-empty 'id'");
  }
  const title = fields['title'];
  if (typeof title !== 'string' || title.length === 0) {
    throw new SpecParseError("Frontmatter must include a non-empty 'title'");
  }
  const dependsOn = fields['depends_on'];
  if (dependsOn !== undefined && !Array.isArray(dependsOn)) {
    // Defensive: parseFlowList always returns an array, but the field
    // type is union — pin the invariant.
    throw new SpecParseError("'depends_on' must be an array of spec ids");
  }

  const frontmatter: SpecFrontmatter = dependsOn === undefined
    ? { id, title }
    : { id, title, depends_on: dependsOn };

  return { frontmatter, body };
}

// ---------------------------------------------------------------------------
// specToIntent — pure translator
// ---------------------------------------------------------------------------

export interface Intent {
  readonly id: string;
  readonly title: string;
  readonly spec_path: string;
  readonly status: 'proposed';
  readonly depends_on: ReadonlyArray<string>;
  readonly created_by: { readonly kind: 'cli'; readonly id: string };
  readonly created_at: string;
}

export interface SpecToIntentOptions {
  readonly spec: ParsedSpec;
  readonly specPath: string;
  readonly now: string;
  readonly creatorId: string;
}

/**
 * Translate a parsed spec into the intent JS object factory writes to
 * `intents/<spec-id>.json`. Pure: no I/O, no Date.now(), no env reads —
 * the caller injects the timestamp and identity.
 *
 * The intent shape mirrors the existing locked schema (intent.schema.json)
 * with the additive `depends_on` field this phase introduces.
 */
export function specToIntent(opts: SpecToIntentOptions): Intent {
  const { spec, specPath, now, creatorId } = opts;
  const dependsOn: ReadonlyArray<string> = spec.frontmatter.depends_on ?? [];
  return {
    id: spec.frontmatter.id,
    title: spec.frontmatter.title,
    spec_path: specPath,
    status: 'proposed',
    depends_on: dependsOn,
    created_by: { kind: 'cli', id: creatorId },
    created_at: now,
  };
}
