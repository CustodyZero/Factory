/**
 * Factory — Spec loader (I/O wrapper around tools/pipeline/spec_parse.ts).
 *
 * SCOPE FOR PHASE 4
 *
 * The pure parser in tools/pipeline/spec_parse.ts handles the format and
 * the field-level contract. This module sits one layer up: it does the
 * filesystem reads and writes, owns the filename<->id invariant, and
 * implements the idempotent intent-generation contract that run.ts
 * relies on.
 *
 * What this module DOES:
 *   - loadSpec(specId, projectRoot): read specs/<spec-id>.md, parse,
 *     verify the parsed id matches the filename stem, return a LoadedSpec.
 *   - ensureIntentForSpec(opts): generate intents/<spec-id>.json from the
 *     loaded spec if it does not exist; if it does, validate that the
 *     existing intent's id and spec_path match. Idempotent on second call.
 *
 * What this module does NOT do:
 *   - Run the pipeline. That's run.ts.
 *   - Validate cyclic spec dependencies. That's validate.ts.
 *   - Modify or delete an existing intent that diverges from the spec.
 *     A mismatch surfaces as an error and the human resolves it.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseSpec, specToIntent } from './pipeline/spec_parse.js';
import type { ParsedSpec, Intent } from './pipeline/spec_parse.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LoadedSpec {
  readonly spec: ParsedSpec;
  /** Absolute path on disk (for diagnostics and the filename<->id check). */
  readonly path: string;
  /** Path relative to project root, for the intent's `spec_path` field. */
  readonly relativePath: string;
}

export interface EnsureIntentResult {
  readonly intentId: string;
  readonly intentPath: string;
  /** True if generated this call; false if a matching intent already existed. */
  readonly created: boolean;
}

export class SpecLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecLoadError';
  }
}

// ---------------------------------------------------------------------------
// loadSpec
// ---------------------------------------------------------------------------

/**
 * Load and parse `specs/<specId>.md` under `projectRoot`. Returns a
 * LoadedSpec with both absolute and relative paths populated; throws
 * SpecLoadError if the file is missing, the parser rejects the content,
 * or the parsed id does not match the filename stem.
 */
export function loadSpec(specId: string, projectRoot: string): LoadedSpec {
  if (specId === '') {
    throw new SpecLoadError("loadSpec requires a non-empty specId");
  }
  const relativePath = join('specs', `${specId}.md`);
  const absolutePath = join(projectRoot, relativePath);
  if (!existsSync(absolutePath)) {
    throw new SpecLoadError(`Spec not found: ${relativePath}`);
  }
  const raw = readFileSync(absolutePath, 'utf-8');
  // parseSpec throws SpecParseError; let it propagate. Callers that
  // need to render it (validate.ts, run.ts) catch on Error.
  const parsed = parseSpec(raw);
  if (parsed.frontmatter.id !== specId) {
    throw new SpecLoadError(
      `Spec id mismatch: file ${relativePath} declares id '${parsed.frontmatter.id}' but the filename stem is '${specId}'`,
    );
  }
  return {
    spec: parsed,
    path: absolutePath,
    relativePath,
  };
}

// ---------------------------------------------------------------------------
// ensureIntentForSpec
// ---------------------------------------------------------------------------

interface EnsureIntentOptions {
  readonly spec: LoadedSpec;
  readonly artifactRoot: string;
  readonly creatorId: string;
  readonly now?: string;
}

/**
 * Idempotently materialize the intent that corresponds to a loaded spec.
 *
 *   - If `intents/<spec-id>.json` does not exist, generate it from the spec
 *     (using specToIntent) and write it.
 *   - If it exists, validate that the existing intent's id and spec_path
 *     match the spec; throw SpecLoadError on mismatch. Returns
 *     `created: false` when a matching intent is found.
 *
 * The function does not validate the spec's depends_on cycle property —
 * that's validate.ts's job. It only checks the local 1:1 invariant
 * defined by the spec_artifact_model decision.
 */
export function ensureIntentForSpec(opts: EnsureIntentOptions): EnsureIntentResult {
  const { spec, artifactRoot, creatorId } = opts;
  const intentId = spec.spec.frontmatter.id;
  const intentDir = join(artifactRoot, 'intents');
  const intentPath = join(intentDir, `${intentId}.json`);

  if (existsSync(intentPath)) {
    const existing = readExistingIntent(intentPath);
    if (existing.id !== intentId) {
      throw new SpecLoadError(
        `Intent at ${relative(artifactRoot, intentPath)} declares id '${existing.id}' but the spec id is '${intentId}'`,
      );
    }
    if (existing.spec_path !== spec.relativePath) {
      throw new SpecLoadError(
        `Intent at ${relative(artifactRoot, intentPath)} has spec_path '${existing.spec_path ?? '<unset>'}' but the spec is at '${spec.relativePath}'`,
      );
    }
    return { intentId, intentPath, created: false };
  }

  const now = opts.now ?? new Date().toISOString();
  const intent: Intent = specToIntent({
    spec: spec.spec,
    specPath: spec.relativePath,
    now,
    creatorId,
  });

  if (!existsSync(intentDir)) {
    mkdirSync(intentDir, { recursive: true });
  }
  writeFileSync(intentPath, JSON.stringify(intent, null, 2) + '\n', 'utf-8');
  return { intentId, intentPath, created: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ExistingIntent {
  readonly id: string;
  readonly spec_path: string | null;
}

function readExistingIntent(intentPath: string): ExistingIntent {
  let raw: string;
  try {
    raw = readFileSync(intentPath, 'utf-8');
  } catch (err) {
    throw new SpecLoadError(
      `Failed to read intent at ${intentPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new SpecLoadError(
      `Existing intent at ${intentPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new SpecLoadError(`Existing intent at ${intentPath} is not a JSON object`);
  }
  const obj = data as Record<string, unknown>;
  const id = obj['id'];
  if (typeof id !== 'string' || id.length === 0) {
    throw new SpecLoadError(`Existing intent at ${intentPath} is missing 'id'`);
  }
  const specPathRaw = obj['spec_path'];
  const specPath = typeof specPathRaw === 'string' ? specPathRaw : null;
  return { id, spec_path: specPath };
}

