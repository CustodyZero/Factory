/**
 * Factory — Pipeline / CLI Argument Resolution
 *
 * Phase 4 of specs/single-entry-pipeline.md teaches run.ts that specs
 * are the canonical input. The resolver disambiguates a single CLI
 * arg between the spec layer and the legacy intent layer.
 *
 * Disambiguation rule (spec-first):
 *
 *   1. If `specs/<arg>.md` exists, treat <arg> as a spec id. Load
 *      it, ensure the intent file exists (generate from the spec
 *      if not), and continue with the existing pipeline.
 *   2. Else if `intents/<arg>.json` exists, fall back to legacy
 *      compatibility mode: the arg is an intent id and the intent
 *      file is used directly. Existing intent-only flows continue
 *      to work with no behavior change.
 *   3. Else: error with a message that names both paths checked.
 *
 * RELOCATED FROM run.ts IN PHASE 4.5
 *
 * This logic was originally inline inside run.ts. It moves here in
 * Phase 4.5 so the coordinator (run.ts) can stay under its size
 * discipline target. Behavior is byte-identical.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as fmt from '../output.js';
import { loadSpec, ensureIntentForSpec, SpecLoadError } from '../specs.js';
import { SpecParseError } from './spec_parse.js';

export type ResolveArgResult =
  | {
      readonly ok: true;
      readonly intentPath: string;
      /**
       * The spec's depends_on list when the path was via specs, or
       * null in legacy mode (so the caller can warn about
       * unimplemented sequencing without conflating the two cases).
       */
      readonly dependsOn: ReadonlyArray<string> | null;
      readonly source: 'spec' | 'intent';
    }
  | { readonly ok: false; readonly error: string };

export function resolveRunArg(
  arg: string,
  artifactRoot: string,
  projectRoot: string,
): ResolveArgResult {
  const specPath = join(projectRoot, 'specs', `${arg}.md`);
  const intentPath = join(artifactRoot, 'intents', `${arg}.json`);

  if (existsSync(specPath)) {
    let loaded;
    try {
      loaded = loadSpec(arg, projectRoot);
    } catch (err) {
      if (err instanceof SpecParseError || err instanceof SpecLoadError) {
        return { ok: false, error: `Spec error: ${err.message}` };
      }
      throw err;
    }
    let ensure;
    try {
      ensure = ensureIntentForSpec({
        spec: loaded,
        artifactRoot,
        creatorId: 'factory-run',
      });
    } catch (err) {
      if (err instanceof SpecLoadError) {
        return { ok: false, error: err.message };
      }
      throw err;
    }
    if (ensure.created) {
      fmt.log('plan', `Generated intent from spec: ${fmt.bold(ensure.intentPath)}`);
    }
    return {
      ok: true,
      intentPath: ensure.intentPath,
      dependsOn: loaded.spec.frontmatter.depends_on ?? [],
      source: 'spec',
    };
  }

  if (existsSync(intentPath)) {
    return { ok: true, intentPath, dependsOn: null, source: 'intent' };
  }

  return {
    ok: false,
    error: `No spec or intent found for '${arg}' (checked: specs/${arg}.md and intents/${arg}.json)`,
  };
}
