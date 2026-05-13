/**
 * Factory — Pipeline / Orchestrator / Spec Runner
 *
 * Phase 5 / 5.7 (post-checkpoint decomposition). The per-spec
 * executor: load and hydrate the intent, sequence the three phase
 * functions (plan -> develop -> verify), update feature status, and
 * return the per-spec outcome that the orchestrator's driver loop
 * aggregates.
 *
 * This module owns the spec-scoped logic that originally lived
 * inline in run.ts before Phase 5 and then in orchestrator.ts before
 * the post-Phase-5.7 split. It does NOT own multi-spec sequencing
 * (that's the driver in index.ts), nor cap enforcement (that's
 * cost_caps.ts), nor resolution gates (that's resolution.ts).
 *
 * The four local fs helpers (`readJson`, `readJsonDir`, `timestamp`,
 * `patchJson`) are duplicated here rather than centralised — see
 * `pipeline/plan_phase.ts` for the rationale.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FactoryConfig } from '../../config.js';
import type { Feature, RawPacket } from '../../execute.js';
import type { RawIntentArtifact } from '../../plan.js';
import { hydrateIntent } from '../../plan.js';
import * as fmt from '../../output.js';
import { runPlanPhase } from '../plan_phase.js';
import { runDevelopPhase } from '../develop_phase.js';
import { runVerifyPhase } from '../verify_phase.js';
import { writeMemorySuggestionReport } from '../memory.js';
import type { ResolvedSpec } from './resolution.js';

// ---------------------------------------------------------------------------
// Module-private fs helpers (mirror of the originals in run.ts and the
// phase modules; see plan_phase.ts for the rationale on why these are
// duplicated rather than centralised).
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
 * Best-effort JSON patch: applies the mutator to the parsed file
 * contents and writes back only when the mutator returns true (the
 * dirty-flag contract pinned by run.test.ts).
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
// Approval-gate helper
//
// The intent schema enumerates these statuses (see plan.ts and
// validate.ts):
//
//   proposed | approved | planned | superseded | delivered
//
// `approved`, `planned`, and `delivered` are all post-approval states
// — re-running them is supported (idempotency, replay, continue-after-
// failure). `proposed` is the only pre-approval state that an
// operator could plausibly run by accident; `superseded` is a
// terminal state that should not be run.
//
// Everything outside the enumeration falls through to "not approved"
// — defensive default for hand-authored intents that drift from the
// schema.
// ---------------------------------------------------------------------------

function isPostApprovalStatus(status: string | null | undefined): boolean {
  return status === 'approved' || status === 'planned' || status === 'delivered';
}

// ---------------------------------------------------------------------------
// Per-spec execution
// ---------------------------------------------------------------------------

export type RunSpecOutcome =
  | {
      readonly status: 'completed';
      readonly feature_id: string | null;
      readonly packets_completed: ReadonlyArray<string>;
      readonly packets_failed: ReadonlyArray<string>;
    }
  | {
      readonly status: 'failed';
      readonly feature_id: string | null;
      readonly packets_completed: ReadonlyArray<string>;
      readonly packets_failed: ReadonlyArray<string>;
      readonly reason: string;
    };

export interface RunSingleSpecContext {
  readonly runId: string;
  /**
   * Whether the surrounding pipeline invocation is a dry-run. Threaded
   * through to the phase modules as the BaseInputs hint that
   * deriveProvenance consumes. Provenance itself is NEVER carried by
   * this context — it is derived once, inside the envelope helper, on
   * every `make*` call. (Round-2 invariant pin.)
   */
  readonly dryRun: boolean;
}

export async function runSingleSpec(
  spec: ResolvedSpec,
  config: FactoryConfig,
  projectRoot: string,
  artifactRoot: string,
  dryRun: boolean,
  ctx: RunSingleSpecContext,
): Promise<RunSpecOutcome> {
  if (!existsSync(spec.intentPath)) {
    const msg = `Intent not found: ${spec.id}`;
    fmt.log('error', fmt.error(msg));
    return { status: 'failed', feature_id: null, packets_completed: [], packets_failed: [], reason: msg };
  }
  const rawIntent = readJson<RawIntentArtifact>(spec.intentPath);
  if (rawIntent === null) {
    const msg = `Failed to parse intent: ${spec.id}`;
    fmt.log('error', fmt.error(msg));
    return { status: 'failed', feature_id: null, packets_completed: [], packets_failed: [], reason: msg };
  }
  const hydrated = hydrateIntent(rawIntent, projectRoot, (p) => readFileSync(p, 'utf-8'));
  if (!hydrated.ok) {
    fmt.log('error', fmt.error(hydrated.error));
    return { status: 'failed', feature_id: null, packets_completed: [], packets_failed: [], reason: hydrated.error };
  }

  // Convergence pass — approval-semantics split.
  //
  // The factory's authoring surface differs between spec-driven and
  // hand-authored runs:
  //
  //   - spec.source === 'spec':   the human authored a spec at
  //     `specs/<id>.md`. The intent file is a derived artifact
  //     generated by `ensureIntentForSpec`. Its `status` reflects
  //     translator state (currently 'proposed') rather than human
  //     intent. Authoring the spec IS the gate; checking the derived
  //     intent's status here would force every spec author to also
  //     edit the generated intent JSON, which contradicts the
  //     spec_artifact_model decision.
  //
  //   - spec.source === 'intent': legacy back-compat. There is no
  //     spec; the human edited an `intents/<id>.json` directly. The
  //     intent's `status` IS the human-authored gate. We accept
  //     `approved` (first-run authority) and the post-approval
  //     statuses `planned` and `delivered` (idempotent rerun of an
  //     intent that already progressed past planning) — see
  //     `isPostApprovalStatus` above. `proposed`, `superseded`, and
  //     missing/unknown values are rejected with an actionable
  //     message that asks the operator to set `status: "approved"`.
  //
  // The previous attempt collapsed both paths into a single check;
  // this commit makes the split explicit so spec-driven runs don't
  // demand the human reach into derived state to "approve" their
  // own work.
  if (spec.source === 'intent' && !isPostApprovalStatus(hydrated.intent.status)) {
    const msg = `Intent '${spec.id}' has status '${hydrated.intent.status}'. Hand-authored intents must be set to 'approved' before running. Edit intents/${spec.id}.json and set "status": "approved".`;
    fmt.log('error', fmt.error(msg));
    return { status: 'failed', feature_id: null, packets_completed: [], packets_failed: [], reason: msg };
  }

  // Phase 1: Plan.
  process.stderr.write('\n');
  fmt.log('phase', fmt.bold('PLANNING'));
  const planResult = await runPlanPhase({
    intent: hydrated.intent,
    config,
    artifactRoot,
    dryRun,
    runId: ctx.runId,
    specId: spec.id,
  });
  if (planResult.feature_id === null) {
    // Pre-Phase-5 contract: --dry-run that stops at planning is a
    // non-failing preview (exit 0). Pre-Phase-5 tools/run.ts:183 set
    // success = dryRun for exactly this branch. We preserve that by
    // mapping dry-run-stops-at-planning to a `completed` outcome with
    // a null feature_id; non-dry-run is the real planning failure.
    if (dryRun) {
      return {
        status: 'completed',
        feature_id: null,
        packets_completed: [],
        packets_failed: [],
      };
    }
    return {
      status: 'failed',
      feature_id: null,
      packets_completed: [],
      packets_failed: [],
      reason: 'Planning failed',
    };
  }

  // Load the planned feature.
  const featurePath = join(artifactRoot, 'features', `${planResult.feature_id}.json`);
  const feature = readJson<Feature>(featurePath);
  if (feature === null) {
    const msg = `Failed to load feature: ${planResult.feature_id}`;
    fmt.log('error', fmt.error(msg));
    return {
      status: 'failed',
      feature_id: planResult.feature_id,
      packets_completed: [],
      packets_failed: [],
      reason: msg,
    };
  }

  // Early exit: feature already fully done.
  if (feature.status === 'completed' || feature.status === 'delivered') {
    const msg = `Feature '${feature.id}' is already ${feature.status}. Nothing to do.`;
    fmt.log('done', fmt.success(msg));
    return {
      status: 'completed',
      feature_id: feature.id,
      packets_completed: [...feature.packets],
      packets_failed: [],
    };
  }

  // Bump feature status to executing on first transition (best-effort).
  patchJson(featurePath, (d) => {
    if (d['status'] === 'planned') {
      d['status'] = 'executing';
      return true;
    }
    return false;
  });

  // Operator banner.
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
  const devResult = await runDevelopPhase({
    feature,
    config,
    artifactRoot,
    projectRoot,
    dryRun,
    runId: ctx.runId,
    specId: spec.id,
  });

  // Phase 3: Verify.
  process.stderr.write('\n');
  fmt.log('phase', fmt.bold('VERIFICATION'));
  const qaResult = await runVerifyPhase({
    feature,
    config,
    artifactRoot,
    projectRoot,
    dryRun,
    runId: ctx.runId,
    specId: spec.id,
  });

  // Update feature status if all packets completed.
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

  const success = allFailed.length === 0 && allSkipped.length === 0;
  const latestPackets = readJsonDir<RawPacket>(join(artifactRoot, 'packets'))
    .filter((packet) => feature.packets.includes(packet.id))
    .map((packet) => packet as RawPacket & { readonly failure?: { readonly scenario?: string; readonly reason?: string } | null });
  writeMemorySuggestionReport({
    projectRoot,
    config,
    specId: spec.id,
    featureId: feature.id,
    status: success ? 'completed' : 'failed',
    packets: latestPackets,
  });
  if (success) {
    return {
      status: 'completed',
      feature_id: feature.id,
      packets_completed: allCompleted,
      packets_failed: [],
    };
  }
  const reasonParts: string[] = [];
  if (allFailed.length > 0) reasonParts.push(`${allFailed.length} packet(s) failed: ${allFailed.join(', ')}`);
  if (allSkipped.length > 0) reasonParts.push(`${allSkipped.length} QA packet(s) skipped`);
  return {
    status: 'failed',
    feature_id: feature.id,
    packets_completed: allCompleted,
    packets_failed: allFailed,
    reason: reasonParts.join('; ') || 'Pipeline did not complete cleanly',
  };
}
