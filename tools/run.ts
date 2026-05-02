#!/usr/bin/env tsx
/**
 * Factory — Pipeline Runner (entry point + thin dispatcher)
 *
 * Single entry point: takes one or more spec or intent ids and runs the
 * full pipeline to completion for each, in dependency order.
 *
 *   npx tsx tools/run.ts <spec-or-intent-id> [<spec-or-intent-id>...] [--dry-run] [--json]
 *
 * Per-spec pipeline:
 *   1. Plan   — decompose intent/spec into a feature + dev/qa packet pairs
 *   2. Develop — for each dev packet: implement, code review, complete
 *   3. Verify  — for each qa packet: verify, complete
 *   4. Done    — summary of what happened
 *
 * Multi-spec sequencing (Phase 5):
 *   - Specs declare dependencies via `depends_on` in their frontmatter.
 *   - The orchestrator topologically sorts the resolved spec set.
 *   - Cycles and missing transitive deps fail the run upfront with a
 *     clear error before any agent is invoked.
 *   - If a spec fails, its dependents are marked `blocked` and skipped;
 *     independent specs still run.
 *
 * THIS FILE'S RESPONSIBILITIES (POST-PHASE-5)
 *
 * Phase 1 of specs/single-entry-pipeline.md extracted pure logic out
 * of this file. Phase 3 library-ized the lifecycle scripts. Phase 4
 * added spec→intent translation. Phase 4.5 extracted the imperative
 * phase loops into pipeline/{plan,develop,verify}_phase.ts. Phase 5
 * extracted the multi-spec sequencing into pipeline/orchestrator.ts.
 *
 * What's left here is the entry layer described in
 * docs/decisions/single_entry_pipeline.md: parse argv, build the
 * orchestrator options, dispatch, render the result, exit.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import {
  findProjectRoot,
  loadConfig,
  resolveArtifactRoot,
} from './config.js';
import * as fmt from './output.js';
import { runOrchestrator, type OrchestratorResult, type SpecOutcome } from './pipeline/orchestrator.js';
import { aggregateRunCost } from './cost.js';

// ---------------------------------------------------------------------------
// patchJson — kept exported here for the run.test.ts contract.
//
// patchJson is the dirty-flag JSON patch helper. It is no longer used by
// run.ts itself (the orchestrator owns the file mutations now). It stays
// exported because run.test.ts pins the dirty-flag contract — that test
// is a structural anchor for any future refactor that touches feature/
// intent file mutation patterns.
// ---------------------------------------------------------------------------

/**
 * Best-effort JSON patch: applies mutator to the parsed file contents and
 * writes the result back, but ONLY if the mutator returns `true` (dirty).
 * If the mutator returns `false`, the file is left untouched (no rewrite,
 * no mtime change). Errors are swallowed (best-effort).
 *
 * Exported for unit testing.
 */
export function patchJson(
  path: string,
  mutator: (data: Record<string, unknown>) => boolean,
): void {
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    const dirty = mutator(data);
    if (dirty) {
      writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    }
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Result rendering
// ---------------------------------------------------------------------------

/**
 * Render the orchestrator result to stderr as a human-readable summary.
 * The summary lists each spec's outcome (completed / failed / blocked)
 * so the operator can see the full picture in a single block.
 *
 * Phase 5.7 — also reads the per-run cost stream and reports total
 * dollars + unknown-cost invocation count. The cost line is omitted
 * entirely when there were no invocations (e.g. dry-run, top-level
 * failure before any agent ran).
 */
function renderSummary(result: OrchestratorResult, artifactRoot: string): void {
  process.stderr.write('\n');
  process.stderr.write(fmt.divider() + '\n');
  if (result.specs.length === 0) {
    // Top-level failure (resolution error, cycle, missing transitive dep).
    fmt.log('done', fmt.error(result.message));
  } else if (result.specs.length === 1) {
    // Single-spec run: a one-line summary keeps the legacy operator
    // experience close to what it was before Phase 5.
    const o = result.specs[0]!;
    renderOutcomeLine(o);
  } else {
    fmt.log('done', fmt.bold(`${result.specs.length} spec(s) processed`));
    for (const o of result.specs) {
      renderOutcomeLine(o);
    }
    fmt.log('done', result.success ? fmt.success(result.message) : fmt.warn(result.message));
  }
  // Phase 5.7 — cost summary line. Read the per-run cost JSONL and
  // surface total dollars + unknown-cost count. Three branches:
  //   - count == 0          → omit the line (no invocations happened)
  //   - all unknown         → just report the count (no $ figure)
  //   - mixed / all known   → "$X.YZ" plus "(N unknown-cost ...)"
  // The line is informational; the exit code is unchanged.
  const cost = aggregateRunCost(result.run_id, artifactRoot);
  if (cost.count > 0) {
    const knownCount = cost.count - cost.unknown_count;
    if (knownCount === 0) {
      fmt.log('done', fmt.info(`Cost: ${cost.unknown_count} unknown-cost invocation(s) (provider did not report tokens)`));
    } else if (cost.unknown_count === 0) {
      fmt.log('done', fmt.info(`Total cost: $${cost.total.toFixed(4)} over ${cost.count} invocation(s)`));
    } else {
      fmt.log('done', fmt.info(`Total cost: $${cost.total.toFixed(4)} (${cost.unknown_count} unknown-cost invocation(s))`));
    }
  }
  if (!result.success && result.specs.some((o) => o.status === 'failed')) {
    fmt.log('done', fmt.info('Fix the failures and re-run to continue.'));
  }
  process.stderr.write(fmt.divider() + '\n');
}

function renderOutcomeLine(o: SpecOutcome): void {
  if (o.status === 'completed') {
    fmt.log('done', `${fmt.sym.ok} ${fmt.bold(o.id)} ${fmt.success('completed')} (${o.packets_completed.length} packet(s))`);
  } else if (o.status === 'failed') {
    fmt.log('done', `${fmt.sym.fail} ${fmt.bold(o.id)} ${fmt.error('failed')} — ${o.reason}`);
  } else {
    fmt.log('done', `${fmt.sym.blocked} ${fmt.bold(o.id)} ${fmt.warn('blocked')} — ${o.reason}`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const positional = args.filter((a) => !a.startsWith('-'));
  const dryRun = args.includes('--dry-run');
  const jsonMode = args.includes('--json');

  if (positional.length === 0) {
    console.error('Usage: npx tsx tools/run.ts <spec-or-intent-id> [<spec-or-intent-id>...] [--dry-run] [--json]');
    console.error('');
    console.error('Runs the full factory pipeline for one or more specs/intents:');
    console.error('  plan -> develop -> review -> verify -> done');
    console.error('');
    console.error('Multi-spec runs are sequenced by `depends_on` in spec frontmatter.');
    console.error('All transitive deps must be passed explicitly.');
    console.error('');
    console.error('If specs/<id>.md exists it is loaded and translated into an');
    console.error('intent (generated on first run, reused on subsequent runs).');
    console.error('If only intents/<id>.json exists, that is used directly.');
    process.exit(1);
  }

  const config = loadConfig();
  const projectRoot = findProjectRoot();
  const artifactRoot = resolveArtifactRoot(projectRoot, config);

  // Phase 5.5 round 2: the orchestrator now rethrows on unexpected
  // exceptions (after emitting a closing pipeline.failed event). Catch
  // here to translate the exception into a non-zero exit code with a
  // user-facing summary line, instead of letting Node print a raw
  // stack trace. The orchestrator already restored FACTORY_RUN_ID via
  // its finally block before the throw reached us.
  let result: OrchestratorResult;
  try {
    result = runOrchestrator({
      args: positional,
      config,
      projectRoot,
      artifactRoot,
      dryRun,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\n${fmt.divider()}\n`);
    fmt.log('done', fmt.error(`Pipeline crashed: ${msg}`));
    process.stderr.write(`${fmt.divider()}\n`);
    process.exit(1);
  }

  renderSummary(result, artifactRoot);

  if (jsonMode) {
    process.stdout.write(formatJsonOutput(positional, result) + '\n');
  }

  process.exit(result.success ? 0 : 1);
}

// ---------------------------------------------------------------------------
// JSON output shaping
//
// Pre-Phase-5 emitted a flat `RunResult` shape:
//   { intent_id, feature_id, packets_completed, packets_failed, success, message }
//
// Phase 5 introduced the `OrchestratorResult` envelope:
//   { specs: [...], success, message }
//
// To preserve the legacy single-arg contract while enabling the new
// multi-spec shape, we emit the legacy flat shape iff exactly one
// positional arg was passed AND we have a per-spec outcome to derive
// it from (or no outcome at all, in which case empty arrays). For
// multi-arg runs we emit the new envelope unchanged.
//
// Exported for unit testing.
// ---------------------------------------------------------------------------

export function formatJsonOutput(positional: ReadonlyArray<string>, result: OrchestratorResult): string {
  if (positional.length === 1) {
    const o = result.specs[0];
    const legacy = {
      intent_id: positional[0],
      feature_id: o && o.status !== 'blocked' ? o.feature_id : null,
      packets_completed: o && o.status !== 'blocked' ? o.packets_completed : [],
      packets_failed: o && o.status !== 'blocked' ? o.packets_failed : [],
      success: result.success,
      message: result.message,
    };
    return JSON.stringify(legacy, null, 2);
  }
  return JSON.stringify(result, null, 2);
}

const isDirectExecution = process.argv[1]?.endsWith('run.ts') || process.argv[1]?.endsWith('run.js');
if (isDirectExecution) {
  main();
}
