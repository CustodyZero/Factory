#!/usr/bin/env tsx
/**
 * Factory — Pipeline Runner (entry point + thin coordinator)
 *
 * Single entry point: takes a spec or intent id and runs the full
 * pipeline to completion.
 *
 *   npx tsx tools/run.ts <spec-or-intent-id> [--dry-run] [--json]
 *
 * Pipeline:
 *   1. Plan   — decompose intent/spec into a feature + dev/qa packet pairs
 *   2. Develop — for each dev packet: implement, code review, complete
 *   3. Verify  — for each qa packet: verify, complete
 *   4. Done    — summary of what happened
 *
 * No human gates after intent approval. Progress streams to terminal.
 * If something fails, the pipeline stops and reports what failed.
 *
 * THIS FILE'S RESPONSIBILITIES (POST-PHASE-4.5)
 *
 * Phase 1 of specs/single-entry-pipeline.md extracted the pure logic
 * out of this file into tools/pipeline/ (topo, prompts, dev-state-
 * machine decisions, agent-arg builders). Phase 3 library-ized the
 * lifecycle scripts. Phase 4 added spec→intent translation. Phase
 * 4.5 then extracted the imperative phase loops themselves into:
 *
 *   - tools/pipeline/plan_phase.ts     — runPlanPhase
 *   - tools/pipeline/develop_phase.ts  — runDevelopPhase (alongside
 *                                        the Phase 1 pure decisions)
 *   - tools/pipeline/verify_phase.ts   — runVerifyPhase
 *
 * What's left here is exactly the entry/coordinator layer described
 * in docs/decisions/single_entry_pipeline.md: parse args, resolve
 * the spec/intent, hydrate, call the three phase functions in order,
 * patch feature status, render the summary.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  findProjectRoot,
  loadConfig,
  resolveArtifactRoot,
} from './config.js';
import { hydrateIntent } from './plan.js';
import type { RawIntentArtifact } from './plan.js';
import type { Feature, RawPacket } from './execute.js';
import * as fmt from './output.js';
import { runPlanPhase } from './pipeline/plan_phase.js';
import { runDevelopPhase } from './pipeline/develop_phase.js';
import { runVerifyPhase } from './pipeline/verify_phase.js';
import { resolveRunArg } from './pipeline/resolve_arg.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RunResult {
  readonly intent_id: string;
  readonly feature_id: string | null;
  readonly packets_completed: string[];
  readonly packets_failed: string[];
  readonly success: boolean;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Coordinator-local helpers
//
// These three small fs helpers and patchJson are used only by the
// run() coordinator (not by the phases — those are self-contained
// after Phase 4.5). Keeping them inline avoids a shared "fs utility"
// module that would not improve clarity at this scale.
//
// patchJson stays exported for unit testing — pinning the dirty-flag
// contract is the entire point of the existing run.test.ts suite.
// ---------------------------------------------------------------------------

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, 'utf-8')) as T; }
  catch { return null; }
}

function readJsonDir<T>(dir: string): T[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson<T>(join(dir, f)))
    .filter((x): x is T => x !== null);
}

function timestamp(): string {
  return new Date().toISOString();
}

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
// Coordinator
// ---------------------------------------------------------------------------

function failResult(intentId: string, featureId: string | null, message: string, success = false): RunResult {
  return { intent_id: intentId, feature_id: featureId, packets_completed: [], packets_failed: [], success, message };
}

function run(intentId: string, dryRun: boolean, _jsonMode: boolean): RunResult {
  const config = loadConfig();
  const projectRoot = findProjectRoot();
  const artifactRoot = resolveArtifactRoot(projectRoot, config);

  fmt.resetTimer();
  process.stderr.write(fmt.header('RUN', `[${config.project_name}]`) + '\n\n');

  // Resolve the CLI argument: spec first, then intent (legacy).
  const resolved = resolveRunArg(intentId, artifactRoot, projectRoot);
  if (!resolved.ok) {
    fmt.log('error', fmt.error(resolved.error));
    return failResult(intentId, null, resolved.error);
  }

  // Spec-level dependency-aware execution arrives in Phase 5. If the
  // resolved spec already declares depends_on, surface it as a warning
  // so the operator knows it is not yet acted on.
  if (resolved.source === 'spec' && resolved.dependsOn !== null && resolved.dependsOn.length > 0) {
    fmt.log(
      'plan',
      fmt.warn(
        `Spec '${intentId}' declares depends_on [${resolved.dependsOn.join(', ')}]; ` +
        `dependency-aware sequencing is not yet implemented (Phase 5). Proceeding without it.`,
      ),
    );
  }

  // Load and hydrate the intent.
  const intentPath = resolved.intentPath;
  if (!existsSync(intentPath)) {
    const msg = `Intent not found: ${intentId}`;
    fmt.log('error', fmt.error(msg));
    return failResult(intentId, null, msg);
  }
  const rawIntent = readJson<RawIntentArtifact>(intentPath);
  if (rawIntent === null) {
    const msg = `Failed to parse intent: ${intentId}`;
    fmt.log('error', fmt.error(msg));
    return failResult(intentId, null, msg);
  }
  const hydrated = hydrateIntent(rawIntent, projectRoot, (p) => readFileSync(p, 'utf-8'));
  if (!hydrated.ok) {
    fmt.log('error', fmt.error(hydrated.error));
    return failResult(intentId, null, hydrated.error);
  }

  // Phase 1: Plan.
  process.stderr.write('\n');
  fmt.log('phase', fmt.bold('PLANNING'));
  const planResult = runPlanPhase({
    intent: hydrated.intent,
    config,
    artifactRoot,
    dryRun,
  });
  if (planResult.feature_id === null) {
    const msg = dryRun ? 'Dry run — planning would be invoked' : 'Planning failed';
    return failResult(intentId, null, msg, dryRun);
  }

  // Load the freshly-planned feature.
  const featurePath = join(artifactRoot, 'features', `${planResult.feature_id}.json`);
  const feature = readJson<Feature>(featurePath);
  if (feature === null) {
    const msg = `Failed to load feature: ${planResult.feature_id}`;
    fmt.log('error', fmt.error(msg));
    return failResult(intentId, planResult.feature_id, msg);
  }

  // Early exit: feature already fully done.
  if (feature.status === 'completed' || feature.status === 'delivered') {
    const msg = `Feature '${feature.id}' is already ${feature.status}. Nothing to do.`;
    fmt.log('done', fmt.success(msg));
    return {
      intent_id: intentId,
      feature_id: feature.id,
      packets_completed: [...feature.packets],
      packets_failed: [],
      success: true,
      message: msg,
    };
  }

  // Update feature status to executing (best-effort). Only writes the
  // file if status was 'planned' — preserves the original semantics
  // (don't rewrite files when there's nothing to change).
  patchJson(featurePath, (d) => {
    if (d['status'] === 'planned') {
      d['status'] = 'executing';
      return true;
    }
    return false;
  });

  // Counts for the operator banner.
  const packets = readJsonDir<RawPacket>(join(artifactRoot, 'packets'));
  const featurePackets = packets.filter((p) => feature.packets.includes(p.id));
  const devCount = featurePackets.filter((p) => p.kind === 'dev').length;
  const qaCount = featurePackets.filter((p) => p.kind === 'qa').length;
  const existingCompletions = readJsonDir<{ packet_id: string }>(join(artifactRoot, 'completions'));
  const existingCompletionIds = new Set(existingCompletions.map((c) => c.packet_id));
  const alreadyDone = featurePackets.filter((p) => existingCompletionIds.has(p.id)).length;
  fmt.log('plan', `Feature ${fmt.bold(feature.id)}: ${devCount} dev + ${qaCount} qa packets (${alreadyDone} already complete)`);

  // Phase 2: Develop.
  process.stderr.write('\n');
  fmt.log('phase', fmt.bold('DEVELOPMENT'));
  const devResult = runDevelopPhase({ feature, config, artifactRoot, projectRoot, dryRun });

  // Phase 3: Verify.
  process.stderr.write('\n');
  fmt.log('phase', fmt.bold('VERIFICATION'));
  const qaResult = runVerifyPhase({ feature, config, artifactRoot, projectRoot, dryRun });

  // Update feature status.
  const allCompleted = [...devResult.completed, ...qaResult.completed];
  const allFailed = [...devResult.failed, ...qaResult.failed];
  const allSkipped = qaResult.skipped;
  if (allFailed.length === 0 && allSkipped.length === 0 && !dryRun && allCompleted.length === feature.packets.length) {
    patchJson(featurePath, (d) => {
      d['status'] = 'completed';
      d['completed_at'] = timestamp();
      return true;
    });
  }

  // Summary.
  process.stderr.write('\n');
  process.stderr.write(fmt.divider() + '\n');
  const success = allFailed.length === 0 && allSkipped.length === 0;
  if (success) {
    fmt.log('done', fmt.success(`All ${allCompleted.length} packet(s) completed successfully`));
  } else {
    if (allFailed.length > 0) {
      fmt.log('done', fmt.error(`${allFailed.length} packet(s) failed: ${allFailed.join(', ')}`));
    }
    if (allSkipped.length > 0) {
      fmt.log('done', fmt.warn(`${allSkipped.length} QA packet(s) skipped (dev not complete): ${allSkipped.join(', ')}`));
    }
    fmt.log('done', `${allCompleted.length} packet(s) completed`);
    fmt.log('done', fmt.info('Fix the failures and re-run to continue.'));
  }
  process.stderr.write(fmt.divider() + '\n');

  return {
    intent_id: intentId,
    feature_id: feature.id,
    packets_completed: allCompleted,
    packets_failed: allFailed,
    success,
    message: success ? `Feature '${feature.id}' completed` : `${allFailed.length} failed, ${allSkipped.length} skipped — re-run to continue`,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const positional = args.filter((a) => !a.startsWith('-'));
  const intentId = positional[0];
  const dryRun = args.includes('--dry-run');
  const jsonMode = args.includes('--json');

  if (intentId === undefined) {
    console.error('Usage: npx tsx tools/run.ts <spec-or-intent-id> [--dry-run] [--json]');
    console.error('');
    console.error('Runs the full factory pipeline for a spec or intent:');
    console.error('  plan -> develop -> review -> verify -> done');
    console.error('');
    console.error('If specs/<id>.md exists it is loaded and translated into an');
    console.error('intent (generated on first run, reused on subsequent runs).');
    console.error('If only intents/<id>.json exists, that is used directly.');
    process.exit(1);
  }

  const result = run(intentId, dryRun, jsonMode);

  if (jsonMode) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }

  process.exit(result.success ? 0 : 1);
}

const isDirectExecution = process.argv[1]?.endsWith('run.ts') || process.argv[1]?.endsWith('run.js');
if (isDirectExecution) {
  main();
}
