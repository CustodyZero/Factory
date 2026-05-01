/**
 * Factory — Pipeline / Plan Phase
 *
 * Imperative orchestration of the planner agent: load (or detect)
 * the feature for an intent, build the planner prompt, invoke the
 * provider, re-read the resulting feature artifact, update the
 * intent's status.
 *
 * EXTRACTED FROM run.ts IN PHASE 4.5.
 *
 * Behavior is byte-identical to the original `planPhase` function in
 * tools/run.ts. This is a pure relocation — same I/O sequence, same
 * agent invocation, same intent-status update on success, same
 * dry-run early return.
 *
 * The phase remains imperative (filesystem reads, agent invocation,
 * intent-file patch). The pure decisions (e.g. prompt construction)
 * already live in pipeline/prompts.ts; the I/O wrapper for agent
 * invocation already lives in pipeline/agent_invoke.ts.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FactoryConfig } from '../config.js';
import type { IntentArtifact, RawIntentArtifact } from '../plan.js';
import * as fmt from '../output.js';
import { buildPlannerPrompt } from './prompts.js';
import { invokeAgent } from './agent_invoke.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PlanPhaseOptions {
  readonly intent: IntentArtifact;
  readonly config: FactoryConfig;
  readonly artifactRoot: string;
  readonly dryRun: boolean;
}

export interface PlanPhaseResult {
  /**
   * The feature id that was either pre-existing or freshly created
   * by the planner. `null` indicates the planner failed or returned
   * early in dry-run mode (the caller treats both as "do not advance
   * to develop/verify"; the original run.ts behavior is preserved).
   */
  readonly feature_id: string | null;
}

// ---------------------------------------------------------------------------
// Private helpers (mirrors of the originals in run.ts)
//
// run.ts also has readJson / readJsonDir / timestamp private helpers.
// We duplicate the small ones here rather than introduce a shared
// fs module — that broader cleanup is outside the Phase 4.5 brief
// (run.ts, plan.ts, execute.ts, and status.ts each have their own
// copies today; consolidating them is a separate change).
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
 * Best-effort intent-file patch: applies the mutator and writes back
 * only when the mutator returns true (matches run.ts's patchJson
 * dirty-flag contract). Errors are swallowed.
 */
function patchJson(
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
// runPlanPhase
// ---------------------------------------------------------------------------

/**
 * Run the plan phase for a single intent. Returns the feature id
 * the develop/verify phases will operate on, or null when there is
 * nothing for them to do (dry-run, planner failed, planner did not
 * produce a feature artifact).
 */
export function runPlanPhase(opts: PlanPhaseOptions): PlanPhaseResult {
  const { intent, config, artifactRoot, dryRun } = opts;

  fmt.log('plan', `Intent: ${fmt.bold(intent.id)} — "${intent.title}"`);

  // Check if already planned.
  const features = readJsonDir<{ id: string; intent_id?: string; status: string }>(join(artifactRoot, 'features'));
  const existing = features.find((f) => f.intent_id === intent.id);
  if (existing !== undefined) {
    fmt.log('plan', `Feature already exists: ${fmt.bold(existing.id)} (${existing.status})`);
    return { feature_id: existing.id };
  }

  // Build planner prompt — reference spec_path so the agent reads the file itself.
  // Do NOT inline spec contents here: it bloats the CLI invocation beyond OS limits
  // and defeats the purpose of spec_path (the agent should read the authoritative
  // source directly, not a snapshot embedded in the prompt).
  const rawIntent = readJson<RawIntentArtifact>(join(artifactRoot, 'intents', `${intent.id}.json`));
  const prompt = buildPlannerPrompt({
    intent,
    plannerInstructions: config.personas.planner.instructions,
    artifactDir: config.artifact_dir,
    specPath: rawIntent?.spec_path ?? null,
  });

  if (dryRun) {
    fmt.log('plan', `[dry-run] Would invoke planner with ${prompt.length} char prompt`);
    return { feature_id: null };
  }

  const provider = config.pipeline?.persona_providers.planner ?? 'claude';
  const plannerTier = config.personas.planner.model ?? 'high';
  fmt.log('plan', `Invoking ${provider} planner (${plannerTier})...`);

  const result = invokeAgent(provider, prompt, config, plannerTier);
  if (result.exit_code !== 0) {
    fmt.log('plan', fmt.error(`Planner failed (exit ${result.exit_code})`));
    if (result.stderr) fmt.log('plan', fmt.muted(result.stderr.slice(0, 500)));
    return { feature_id: null };
  }

  fmt.log('plan', fmt.success('Planner completed'));

  // Re-read features to find what was created.
  const newFeatures = readJsonDir<{ id: string; intent_id?: string; status: string }>(join(artifactRoot, 'features'));
  const created = newFeatures.find((f) => f.intent_id === intent.id);
  if (created === undefined) {
    fmt.log('plan', fmt.error('Planner did not create a feature artifact'));
    return { feature_id: null };
  }

  // Update intent status (best-effort).
  patchJson(join(artifactRoot, 'intents', `${intent.id}.json`), (d) => {
    d['status'] = 'planned';
    d['feature_id'] = created.id;
    d['planned_at'] = timestamp();
    return true;
  });

  fmt.log('plan', `Feature created: ${fmt.bold(created.id)}`);
  return { feature_id: created.id };
}
