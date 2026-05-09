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
import type { InvokeResult } from './agent_invoke.js';
import { computeCascade } from './cascade.js';
import type { CostRecord } from './cost.js';
import { recordCost, localDateString } from '../cost.js';
import {
  makePhaseStarted,
  makePhaseCompleted,
} from './events.js';
import { appendEvent } from '../events.js';
import {
  failureFromSubprocess,
  newPacketRecoveryBudget,
  runWithRecovery,
  type AttemptContext,
  type GitRunner,
  type OperationResult,
} from './recovery_loop.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PlanPhaseOptions {
  readonly intent: IntentArtifact;
  readonly config: FactoryConfig;
  readonly artifactRoot: string;
  readonly dryRun: boolean;
  /**
   * Phase 5.5 — events plumbing. When present, the phase emits
   * `phase.started` / `phase.completed` events at its boundaries.
   * Optional so that single-purpose unit tests of plan-phase logic
   * (which already exist) don't have to construct an events
   * context they don't care about.
   *
   * Provenance is NOT passed in — it is derived inside the events
   * envelope from `dryRun` via deriveProvenance. (Round-2 invariant
   * pin: callers cannot supply a free-form provenance value.)
   */
  readonly runId?: string;
  readonly specId?: string | null;
  /**
   * Phase 6 — injectable git runner for the StaleBranch recovery
   * action. The planner doesn't typically encounter stale-branch
   * conditions (it doesn't push), but the option is plumbed for
   * uniformity with develop_phase / verify_phase.
   */
  readonly gitRunner?: GitRunner;
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
// recordPlanCost — round-2 fix for the planner-not-in-cost-stream bug
//
// Per docs/decisions/cost_visibility.md, every agent invocation must
// produce a CostRecord. The planner is the most expensive single
// invocation in the pipeline; missing it would underreport per-run
// totals and break Phase 6's retry-budget assumptions.
//
// Why a separate helper from develop_phase / verify_phase: the planner
// has no per-packet cap to enforce (planner runs are spec-scoped, not
// packet-scoped) and no per-packet tracker. The shape is just "write
// a row when runId is supplied; otherwise no-op". The two phase
// helpers fold cap accounting into the same helper because they need
// it; the planner doesn't.
//
// runId-undefined gate: same convention as the other phases — when no
// orchestrator supplied a run id (unit-test invocations), recording
// is a no-op.
// ---------------------------------------------------------------------------

function recordPlanCost(
  invokeResult: InvokeResult,
  runId: string | undefined,
  specId: string | null,
  artifactRoot: string,
): void {
  if (runId === undefined) return;
  const record: CostRecord = {
    run_id: runId,
    packet_id: null,
    spec_id: specId,
    provider: invokeResult.cost.provider,
    model: invokeResult.cost.model,
    tokens_in: invokeResult.cost.tokens_in,
    tokens_out: invokeResult.cost.tokens_out,
    dollars: invokeResult.cost.dollars,
    timestamp: new Date().toISOString(),
  };
  recordCost(record, artifactRoot);
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

  // Phase 5.5: emit phase.started at entry. Best-effort; appendEvent
  // swallows errors. The eventCtx local short-circuits if no run_id
  // was passed (unit-test invocations).
  //
  // Round-2 invariant: callers pass `dry_run` (a hint), never a
  // pre-derived provenance. The pure constructors call
  // deriveProvenance internally — VITEST > dryRun > live_run.
  const eventCtx = opts.runId !== undefined
    ? { run_id: opts.runId, dry_run: dryRun }
    : null;
  if (eventCtx !== null) {
    appendEvent(
      makePhaseStarted(eventCtx, { phase: 'plan', spec_id: opts.specId ?? intent.id }),
      artifactRoot,
    );
  }

  const result = runPlanPhaseInner(opts);

  if (eventCtx !== null) {
    // Round-2 fix (Issue 3): the plan phase's outcome must NOT collapse
    // two distinct cases ("planner genuinely failed" vs "dry-run stopped
    // early before invoking the planner") into a single `failed` label.
    //
    //   - feature_id !== null  -> 'ok' (planner succeeded, or feature
    //     already existed)
    //   - feature_id === null && dryRun  -> 'ok' (successful preview,
    //     not a failure — the orchestrator emits spec.completed with
    //     status='completed' for this branch, so phase 'failed' here
    //     would contradict the rest of the stream)
    //   - feature_id === null && !dryRun  -> 'failed' (real planning
    //     failure, e.g. planner agent exited non-zero or did not
    //     produce a feature artifact)
    const phaseOutcome: 'ok' | 'failed' =
      result.feature_id !== null ? 'ok' :
      dryRun ? 'ok' :
      'failed';
    appendEvent(
      makePhaseCompleted(eventCtx, {
        phase: 'plan',
        spec_id: opts.specId ?? intent.id,
        outcome: phaseOutcome,
      }),
      artifactRoot,
    );
  }
  return result;
}

function runPlanPhaseInner(opts: PlanPhaseOptions): PlanPhaseResult {
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

  // Phase 7 — `persona_providers.<persona>` is an ordered list after
  // loader normalization. Index 0 is the PRIMARY CLI; the rest form
  // the cross-CLI failover order. Read [0] for the initial attempt;
  // the cascade (computed once below) is consulted on failure via
  // the recovery layer.
  const provider = config.pipeline?.persona_providers.planner[0] ?? 'claude';
  const plannerTier = config.personas.planner.model ?? 'high';
  // Phase 7 — compute the persona cascade once. The recovery layer
  // walks this list when ProviderUnavailable fires. Pure: same
  // inputs, same output.
  const plannerCascade = computeCascade('planner', plannerTier, config);
  // Phase 7 round-2 fix — the PRIMARY attempt is `cascade[0]`. See
  // develop_phase.ts for full rationale. The fallback (cascade
  // empty / pipeline absent) preserves legacy behavior.
  const plannerPrimary =
    plannerCascade[0] ?? { provider, model: undefined };
  fmt.log('plan', `Invoking ${provider} planner (${plannerTier})...`);

  // Phase 6 — wrap the planner invocation in runWithRecovery.
  // Per-spec budget (the planner runs once per spec, so the budget
  // is fresh per call by construction). ProviderTransient and
  // AgentNonResponsive failures retry; ProviderUnavailable consults
  // the cascade. Cost recording happens on every attempt via the
  // closure so retried planner runs still flow into the cost stream.
  const recoveryBudget = newPacketRecoveryBudget();
  const recoveryOptions = {
    perRunCap: config.pipeline?.cost_caps?.per_run,
    perDayCap: config.pipeline?.cost_caps?.per_day,
    today: localDateString(),
    ...(opts.gitRunner !== undefined ? { gitRunner: opts.gitRunner } : {}),
  };
  const recoveryRunId = opts.runId ?? 'no-run';

  const recovered = runWithRecovery<InvokeResult>(
    (attempt: AttemptContext): OperationResult<InvokeResult> => {
      // Phase 7 round-2 — primary derived from cascade[0]. Cascade
      // hops use attempt.cascade (set by the recovery layer); the
      // initial call and `retry_same` retries use cascade[0] so
      // recovery's cascade-walking index stays consistent with
      // what was actually invoked.
      const target = attempt.cascade ?? plannerPrimary;
      const r = invokeAgent(
        target.provider, prompt, config, plannerTier, target.model,
      );
      // Persist a CostRecord regardless of outcome — a failed planner
      // still consumed tokens. Done inside the closure so retried
      // calls record one row each.
      recordPlanCost(r, opts.runId, opts.specId ?? intent.id, artifactRoot);
      if (r.exit_code === 0) return { outcome: 'ok', value: r };
      // Phase 7 — attach the cascade to the failure context so the
      // ProviderUnavailable recipe can walk it. Recipes that don't
      // consult `cascade` (Build/Lint/Test/Stale/...) ignore it.
      return {
        outcome: 'fail',
        failure: {
          ...failureFromSubprocess({
            exitCode: r.exit_code,
            stdout: r.stdout,
            stderr: r.stderr,
            kind: 'agent_invocation',
            specId: opts.specId ?? intent.id,
            packetId: null,
            operationLabel: 'plan_phase.invoke_planner',
          }),
          cascade: plannerCascade,
        },
      };
    },
    {
      runId: recoveryRunId,
      artifactRoot,
      dryRun,
      specId: opts.specId ?? intent.id,
      packetId: null,
      operationLabel: 'plan_phase.invoke_planner',
      budget: recoveryBudget,
    },
    recoveryOptions,
  );

  // Dispatch on the discriminator. On escalation: emit no further
  // progress, log the reason, return feature_id: null. The plan
  // phase has no per-packet artifact to mark failed — the spec
  // itself fails when feature_id is null and the orchestrator
  // skips dependents.
  if (recovered.kind === 'escalated') {
    fmt.log('plan', fmt.error(`Planner escalated (${recovered.scenario}): ${recovered.reason}`));
    if (recovered.escalation_path !== null) {
      fmt.log('plan', fmt.muted(`Escalation written: ${recovered.escalation_path}`));
    }
    return { feature_id: null };
  }

  const result = recovered.value;
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
