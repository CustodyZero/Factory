/**
 * Factory — Pipeline / Develop Phase
 *
 * Two layers in one file:
 *
 *   PURE — the dev-packet state machine decisions. Given a packet
 *   and an outcome, return the next resume point. Unit-testable
 *   without I/O. Authored in Phase 1.
 *
 *   IMPERATIVE — the loop that drives those decisions: reads packet
 *   state from disk, invokes agents, calls lifecycle library
 *   functions. Authored in Phase 4.5 by relocating the original
 *   `devPhase` function from tools/run.ts. Behavior is byte-
 *   identical to the pre-extraction loop.
 *
 * The PURE decisions remain unchanged. The IMPERATIVE wrapper
 * lives below them. They share a file because they're tightly
 * coupled — a change to the state machine is incomplete without
 * a matching update to the loop, and splitting the file would
 * obscure that.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Feature, RawPacket } from '../execute.js';
import type { FactoryConfig, ModelTier } from '../config.js';
import * as fmt from '../output.js';
import { topoSort } from './topo.js';
import { invokeAgent } from './agent_invoke.js';
import { computeCascade } from './cascade.js';
import { buildDevPrompt, buildReviewPrompt, buildReworkPrompt } from './prompts.js';
import { refreshCompletionId, safeCall } from './lifecycle_helpers.js';
import { startPacket } from '../lifecycle/start.js';
import { requestReview } from '../lifecycle/request_review.js';
import { recordReview } from '../lifecycle/review.js';
import { completePacket } from '../lifecycle/complete.js';
import {
  makePhaseStarted,
  makePhaseCompleted,
  makeCostCapCrossed,
  makePacketFailed,
} from './events.js';
import { appendEvent } from '../events.js';
import type { InvokeResult } from './agent_invoke.js';
import type { CostRecord } from './cost.js';
import { checkCap } from './cost.js';
import { recordCost, localDateString } from '../cost.js';
import {
  failureFromSubprocess,
  failureFromThrow,
  newPacketRecoveryBudget,
  runWithRecovery,
  type AttemptContext,
  type GitRunner,
  type OperationResult,
  type RecoveryResult,
} from './recovery_loop.js';
import { looksLikeStaleBranchMessage } from '../lifecycle/git_check.js';

// ---------------------------------------------------------------------------
// Resume points
// ---------------------------------------------------------------------------

/**
 * Where to (re)enter the dev-packet state machine.
 *
 *   completed       — has completion record; skip entirely
 *   implement       — not started, or implementing — (re)invoke developer
 *   request_review  — implementing done, needs review request
 *   review          — review_requested — invoke reviewer
 *   rework          — changes_requested — invoke developer for rework
 *   finalize        — review_approved — run completion
 */
export type DevResumePoint =
  | 'completed'
  | 'implement'
  | 'request_review'
  | 'review'
  | 'rework'
  | 'finalize';

// ---------------------------------------------------------------------------
// Resume-point derivation
// ---------------------------------------------------------------------------

/**
 * Derive the current lifecycle phase of a dev packet from its
 * artifact state.
 *
 * Contract preserved from run.ts:
 *   - Completion record exists  -> 'completed' (regardless of status)
 *   - status == 'review_requested'  -> 'review'
 *   - status == 'changes_requested' -> 'rework'
 *   - status == 'review_approved'   -> 'finalize'
 *   - everything else (null, 'draft', 'ready', 'implementing', or any
 *     unrecognized status string) -> 'implement'
 */
export function deriveDevResumePoint(
  packet: RawPacket,
  hasCompletion: boolean,
): DevResumePoint {
  if (hasCompletion) return 'completed';
  const status = packet.status ?? null;
  switch (status) {
    case 'review_requested': return 'review';
    case 'changes_requested': return 'rework';
    case 'review_approved': return 'finalize';
    default: return 'implement'; // null, 'draft', 'ready', 'implementing'
  }
}

// ---------------------------------------------------------------------------
// State transitions — pure decisions about where to go next
//
// Each function returns the NEXT resume point, or null to indicate
// the packet has failed and the loop should stop.
// ---------------------------------------------------------------------------

/**
 * After the developer agent runs in the `implement` step:
 *   - success -> request review
 *   - failure -> stop (null)
 */
export function nextPointAfterImplement(devSucceeded: boolean): DevResumePoint | null {
  return devSucceeded ? 'request_review' : null;
}

/**
 * After the reviewer agent runs in the `review` step:
 *   - reviewer exited non-zero -> stop (null)
 *   - reviewer succeeded; packet status was bumped to 'review_approved'   -> finalize
 *   - reviewer succeeded; packet status was bumped to 'changes_requested' -> rework
 *   - reviewer succeeded; status not transitioned -> finalize (the
 *     imperative loop force-approves on disk before falling through)
 *
 * The status-after-review value comes from re-reading the packet
 * artifact from disk after the reviewer agent terminates.
 */
export function nextPointAfterReview(
  reviewSucceeded: boolean,
  statusAfterReview: string | null,
): DevResumePoint | null {
  if (!reviewSucceeded) return null;
  if (statusAfterReview === 'review_approved') return 'finalize';
  if (statusAfterReview === 'changes_requested') return 'rework';
  // Reviewer didn't transition status — caller force-approves and
  // falls through to finalize. Same outcome here.
  return 'finalize';
}

/**
 * After the developer agent runs in the `rework` step:
 *   - success -> re-request review
 *   - failure -> stop (null)
 */
export function nextPointAfterRework(reworkSucceeded: boolean): DevResumePoint | null {
  return reworkSucceeded ? 'request_review' : null;
}

/**
 * After the completion script runs in the `finalize` step:
 *   - success -> completed
 *   - failure -> stop (null)
 */
export function nextPointAfterFinalize(completionSucceeded: boolean): DevResumePoint | null {
  return completionSucceeded ? 'completed' : null;
}

// ---------------------------------------------------------------------------
// Imperative loop — runDevelopPhase
//
// Relocated from tools/run.ts in Phase 4.5. Same I/O sequence as the
// original `devPhase` function: build the per-feature dev-packet list,
// topo-sort it, and walk each packet through the implement / review /
// rework / finalize state machine until it either reaches `completed`
// or fails. Per-iteration disk re-reads guard against external
// mutations from agents that invoke lifecycle CLIs directly.
// ---------------------------------------------------------------------------

export interface DevelopPhaseOptions {
  readonly feature: Feature;
  readonly config: FactoryConfig;
  readonly artifactRoot: string;
  readonly projectRoot: string;
  readonly dryRun: boolean;
  /**
   * Phase 5.5 — events plumbing. When present, the phase emits
   * `phase.started` / `phase.completed` events at its boundaries.
   * Optional so existing develop-phase unit tests don't have to
   * construct an events context. Lifecycle scripts called from
   * inside this phase pick up the run_id via process.env.FACTORY_RUN_ID
   * (set by the orchestrator), independent of these options.
   *
   * Provenance is NOT passed in — it is derived inside the events
   * envelope from `dryRun` via deriveProvenance. (Round-2 invariant
   * pin: callers cannot supply a free-form provenance value.)
   */
  readonly runId?: string;
  readonly specId?: string | null;
  /**
   * Phase 6 — injectable git runner for the StaleBranch recovery
   * action AND the lifecycle stale-branch detection. Production
   * callers omit it and the default `spawnSync('git', ...)` runner
   * is used. Tests inject a stub so they don't shell out.
   */
  readonly gitRunner?: GitRunner;
}

export interface DevelopPhaseResult {
  readonly completed: string[];
  readonly failed: string[];
}

// Module-private fs helpers (mirrors of the originals in run.ts).
// See plan_phase.ts for the same rationale: a shared fs module is
// out of scope for Phase 4.5.

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

// ---------------------------------------------------------------------------
// Cost recording + per-packet cap enforcement (Phase 5.7)
//
// recordInvocationCost writes one CostRecord JSONL row per invokeAgent
// call (best-effort) AND maintains a running per-packet dollar total.
// When the per-packet cap is configured and the running total crosses
// it (>= semantics), the helper emits cost.cap_crossed(per_packet) on
// the event stream and returns capCrossed: true. The caller stops
// invoking the packet's agents and marks the packet failed.
//
// Null-dollar invocations are NOT counted toward the cap (operator
// has no way to police what the provider didn't report); they ARE
// recorded as rows, and the run summary surfaces the unknown-cost
// invocation count separately.
//
// runId-undefined gate: develop_phase.test.ts drives the phase
// directly without an orchestrator and therefore has no runId. In
// that mode the helper is a no-op (cost recording AND cap checks
// require a run context).
// ---------------------------------------------------------------------------

interface PacketCostTracker {
  /** Dollars accumulated across this packet's invocations so far. */
  total: number;
  /**
   * True once the per-packet cap has been crossed and the
   * cost.cap_crossed event has been emitted. The caller branches on
   * this to stop the inner state machine. The flag is sticky to
   * prevent emitting the event twice if the loop re-enters.
   */
  crossed: boolean;
}

function newPacketCostTracker(): PacketCostTracker {
  return { total: 0, crossed: false };
}

function recordInvocationCost(
  invokeResult: InvokeResult,
  runId: string | undefined,
  packetId: string | null,
  specId: string | null,
  artifactRoot: string,
  perPacketCap: number | undefined,
  tracker: PacketCostTracker,
  dryRun: boolean,
): { capCrossed: boolean } {
  if (runId === undefined) return { capCrossed: false };
  const record: CostRecord = {
    run_id: runId,
    packet_id: packetId,
    spec_id: specId,
    provider: invokeResult.cost.provider,
    model: invokeResult.cost.model,
    tokens_in: invokeResult.cost.tokens_in,
    tokens_out: invokeResult.cost.tokens_out,
    dollars: invokeResult.cost.dollars,
    timestamp: new Date().toISOString(),
  };
  recordCost(record, artifactRoot);

  // Per-packet cap accounting. Null-dollar rows are tracked as
  // "unknown" (they never increment `total`); the cap is only
  // tested against the known-dollar running total.
  if (invokeResult.cost.dollars !== null) {
    tracker.total += invokeResult.cost.dollars;
  }
  if (!tracker.crossed && checkCap(tracker.total, perPacketCap)) {
    tracker.crossed = true;
    // Emit BEFORE returning so the events stream is well-formed
    // before the caller aborts the packet. Best-effort via appendEvent.
    appendEvent(
      makeCostCapCrossed(
        { run_id: runId, dry_run: dryRun },
        {
          scope: 'per_packet',
          cap_dollars: perPacketCap as number,
          running_total: tracker.total,
          packet_id: packetId,
          spec_id: specId,
        },
      ),
      artifactRoot,
    );
    return { capCrossed: true };
  }
  return { capCrossed: false };
}

// ---------------------------------------------------------------------------
// Packet escalation (Phase 6)
//
// markPacketFailed is the single point where the per-packet state
// machine surfaces a recovery escalation. It MUST:
//
//   1. Mutate `packets/<id>.json` to status='failed' and record the
//      escalation reason on the packet (best-effort; the on-disk
//      escalation file in `escalations/` is the authoritative record).
//   2. Emit a `packet.failed` event with the recovery escalation
//      reason in the payload.
//
// The caller's per-packet loop must then break and continue to the
// next packet. This is the load-bearing integration: the recovery
// layer's `kind: 'escalated'` discriminator is observable AND
// controlling — every wrap site that receives `kind: 'escalated'`
// calls this helper and then breaks the loop.
//
// The previous Phase 6 attempt logged the escalation event and
// unconditionally advanced. That's the bug we reverted for. The
// fix in this attempt is the type-level discriminator forcing every
// caller to make the decision visible.
// ---------------------------------------------------------------------------

interface MarkPacketFailedArgs {
  readonly packetId: string;
  readonly artifactRoot: string;
  readonly recovery: RecoveryResult<unknown> & { readonly kind: 'escalated' };
  readonly runId: string | undefined;
  readonly dryRun: boolean;
}

function markPacketFailed(args: MarkPacketFailedArgs): void {
  const { packetId, artifactRoot, recovery, runId, dryRun } = args;
  // (1) Mutate packet status to 'failed' (best-effort).
  try {
    const packetPath = join(artifactRoot, 'packets', `${packetId}.json`);
    if (existsSync(packetPath)) {
      const data = JSON.parse(readFileSync(packetPath, 'utf-8')) as Record<string, unknown>;
      data['status'] = 'failed';
      // Stamp the escalation onto the packet so a human reading
      // packets/<id>.json sees why; the canonical record lives in
      // escalations/.
      data['failure'] = {
        scenario: recovery.scenario,
        reason: recovery.reason,
        attempts: recovery.attempts,
        escalation_path: recovery.escalation_path,
      };
      writeFileSync(packetPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    }
  } catch { /* best-effort: the escalation record is the canonical one */ }

  // (2) Emit packet.failed with the recovery reason.
  if (runId !== undefined) {
    appendEvent(
      makePacketFailed(
        { run_id: runId, dry_run: dryRun },
        {
          packet_id: packetId,
          reason: `${recovery.scenario}: ${recovery.reason}`,
        },
      ),
      artifactRoot,
    );
  }
}

/**
 * Run the develop phase for a feature: implement / review / rework /
 * finalize each dev packet in topological order. Returns the lists
 * of completed and failed packet ids.
 *
 * Async since the convergence pass migrated `invokeAgent` to a
 * Promise-returning shape so long agent runs can yield to heartbeats.
 */
export async function runDevelopPhase(opts: DevelopPhaseOptions): Promise<DevelopPhaseResult> {
  const { feature, config, artifactRoot, projectRoot, dryRun } = opts;

  // Phase 5.5: emit phase.started at entry. The eventCtx is null when
  // the caller (e.g. a unit test) didn't pass run_id.
  //
  // Round-2 invariant: callers pass `dry_run` (a hint), never a
  // pre-derived provenance. The pure constructors call
  // deriveProvenance internally — VITEST > dryRun > live_run.
  const eventCtx = opts.runId !== undefined
    ? { run_id: opts.runId, dry_run: opts.dryRun }
    : null;
  if (eventCtx !== null) {
    appendEvent(
      makePhaseStarted(eventCtx, { phase: 'develop', spec_id: opts.specId ?? null }),
      artifactRoot,
    );
  }

  const result = await runDevelopPhaseInner(opts);

  if (eventCtx !== null) {
    // Outcome: 'failed' iff any packet failed; 'ok' otherwise. A
    // feature with zero dev packets reports 'ok' (no work to fail at).
    appendEvent(
      makePhaseCompleted(eventCtx, {
        phase: 'develop',
        spec_id: opts.specId ?? null,
        outcome: result.failed.length === 0 ? 'ok' : 'failed',
      }),
      artifactRoot,
    );
  }
  return result;
}

async function runDevelopPhaseInner(opts: DevelopPhaseOptions): Promise<DevelopPhaseResult> {
  const { feature, config, artifactRoot, projectRoot, dryRun } = opts;

  const packets = readJsonDir<RawPacket>(join(artifactRoot, 'packets'));
  const completions = readJsonDir<{ packet_id: string }>(join(artifactRoot, 'completions'));
  const completionIds = new Set(completions.map((c) => c.packet_id));

  const devPackets = packets.filter((p) => p.kind === 'dev' && feature.packets.includes(p.id));
  const sorted = topoSort<RawPacket>(devPackets, (p) => p.id, (p) => p.dependencies ?? []);
  const completed: string[] = [];
  const failed: string[] = [];

  fmt.log('develop', `${sorted.length} dev packet(s) to process`);

  const maxReviewIterations = config.pipeline?.max_review_iterations ?? 3;
  // Phase 7 — `persona_providers.<persona>` is an ordered list after
  // loader normalization. Index 0 is the PRIMARY CLI for the persona;
  // the rest form the cross-CLI failover order consumed by the
  // ProviderUnavailable cascade. We read [0] here so the initial
  // invocation targets the primary; the cascade is consulted only on
  // failure (via the recovery layer).
  const devProvider = config.pipeline?.persona_providers.developer[0] ?? 'codex';
  const devTier: ModelTier = config.personas.developer.model ?? 'high';
  const devIdentity = config.pipeline?.completion_identities.developer ?? 'codex-dev';
  const reviewProvider = config.pipeline?.persona_providers.code_reviewer[0] ?? 'claude';
  const reviewTier: ModelTier = config.personas.code_reviewer.model ?? 'medium';
  // Phase 7 — compute persona cascades once per phase invocation.
  // The closures attach these to every failure context so the
  // ProviderUnavailable recipe can walk the failover order. Pure
  // computation; no I/O.
  const devCascade = computeCascade('developer', devTier, config);
  const reviewerCascade = computeCascade('code_reviewer', reviewTier, config);
  // Phase 7 round-2 fix — the PRIMARY attempt is `cascade[0]`. When
  // the persona has `model_failover` configured, cascade[0].model is
  // the configured first model; using devProvider/reviewProvider
  // alone (with NO modelOverride) silently invokes the persona's
  // tier-mapped model and skips the operator-configured first model.
  // Recovery would then start at cascade[1] thinking cascade[0] had
  // been tried — observably wrong.
  //
  // The fallback (when cascade is empty, i.e. pipeline is absent)
  // preserves legacy behavior: tier-resolved model id with no
  // explicit override.
  const devPrimary = devCascade[0] ?? { provider: devProvider, model: undefined };
  const reviewerPrimary =
    reviewerCascade[0] ?? { provider: reviewProvider, model: undefined };

  for (const packet of sorted) {
    // Re-read packet from disk each iteration (a previous packet's agent
    // run may have invoked a lifecycle CLI that mutated this file).
    const freshPacket = readJson<RawPacket>(join(artifactRoot, 'packets', `${packet.id}.json`)) ?? packet;

    // Same external-mutation model applies to completions: a previous
    // packet's developer agent may have invoked complete.ts directly,
    // creating a completion file that wasn't in the phase-start scan.
    refreshCompletionId(completionIds, packet.id, artifactRoot);

    const resumePoint = deriveDevResumePoint(freshPacket, completionIds.has(packet.id));

    if (resumePoint === 'completed') {
      fmt.log('develop', `${fmt.sym.ok} ${packet.id} — already complete`);
      completed.push(packet.id);
      continue;
    }

    // Phase 6 — a packet already in terminal `failed` status (set by a
    // prior recovery escalation) is not retried in the same run. Surface
    // it in the failed list and continue to the next packet.
    if (freshPacket.status === 'failed') {
      fmt.log('develop', `${fmt.sym.fail} ${packet.id} — already failed (terminal)`);
      failed.push(packet.id);
      continue;
    }

    // Check dependencies are met before proceeding. Phase 6 — a
    // dep packet in terminal-failed status cascades the failure to
    // this packet rather than waiting indefinitely. Re-read from
    // disk because a prior packet in this loop may have had its
    // status mutated to 'failed' by markPacketFailed since the
    // phase-start scan.
    const deps = freshPacket.dependencies ?? [];
    const unmetDeps: string[] = [];
    let cascadeFailed = false;
    for (const dep of deps) {
      if (completionIds.has(dep)) continue;
      const depPacket = readJson<RawPacket>(join(artifactRoot, 'packets', `${dep}.json`));
      if (depPacket !== null && depPacket.status === 'failed') {
        cascadeFailed = true;
        break;
      }
      unmetDeps.push(dep);
    }
    if (cascadeFailed) {
      fmt.log('develop', `${fmt.sym.fail} ${packet.id} — cascaded from failed dependency`);
      failed.push(packet.id);
      continue;
    }
    if (unmetDeps.length > 0) {
      fmt.log('develop', `${fmt.sym.blocked} ${packet.id} — blocked by: ${unmetDeps.join(', ')}`);
      failed.push(packet.id);
      continue;
    }

    fmt.log('develop', `${fmt.sym.arrow} ${fmt.bold(packet.id)} — "${freshPacket.title}" (resume: ${resumePoint})`);

    if (dryRun) {
      fmt.log('develop', `  [dry-run] Would resume from '${resumePoint}'`);
      continue;
    }

    // Phase 5.7 — per-packet cost cap. Tracker is fresh per packet.
    // The recordInvocationCost helper accumulates dollars and emits
    // cost.cap_crossed(per_packet) the first time the running total
    // crosses (>=) the configured cap.
    const perPacketCap = config.pipeline?.cost_caps?.per_packet;
    const packetCostTracker = newPacketCostTracker();

    // Phase 6 — per-packet recovery budget. Tracks per-scenario
    // retries USED across this packet's full lifecycle. Each
    // scenario has its own counter bounded by SCENARIO_RETRY_BUDGET;
    // budgets do NOT carry across packets.
    //
    // Lifetime decision: this lives as a local in the per-packet
    // loop body so the lifetime exactly matches the packet's run.
    // Threading it through a wider context object would force the
    // budget to outlive the packet, which contradicts the brief's
    // "per-packet, per-scenario; no cross-scenario cap" rule.
    const recoveryBudget = newPacketRecoveryBudget();
    const recoveryOptions = {
      perRunCap: config.pipeline?.cost_caps?.per_run,
      perDayCap: config.pipeline?.cost_caps?.per_day,
      today: localDateString(),
      ...(opts.gitRunner !== undefined ? { gitRunner: opts.gitRunner } : {}),
    };
    // Stable run id for the recovery layer when the caller didn't
    // supply one (unit-test mode). The recovery layer's appendEvent
    // calls are no-ops without an events dir; run id only determines
    // the events file name.
    const recoveryRunId = opts.runId ?? 'no-run';

    // Phase 6 — state-machine integration.
    //
    // The previous attempt logged escalations and unconditionally
    // advanced. This attempt forces the state machine to dispatch on
    // RecoveryResult<T>'s `kind` discriminator. On `kind: 'escalated'`,
    // we mark the packet failed (markPacketFailed + packet.failed
    // event), break the per-packet loop, continue to the next packet.
    //
    // Escalation is TERMINAL for the packet's lifecycle. The packet
    // does NOT proceed to any further state regardless of which
    // case was running when escalation fired (per the brief's Q1/Q2).
    let currentPoint: DevResumePoint | null = resumePoint;
    let escalated = false;

    while (currentPoint !== null && currentPoint !== 'completed' && !escalated) {
      switch (currentPoint) {
        case 'implement': {
          safeCall(() => startPacket({ packetId: packet.id, projectRoot }));
          fmt.log('develop', `  Implementing via ${devProvider} (${devTier})...`);
          // Wrap the dev-agent invocation in runWithRecovery. The
          // closure builds the prompt fresh on each attempt — for a
          // BuildFailed retry the loop passes the guardrail prompt
          // via attempt.guardrailPrompt, which is appended to the
          // dev prompt. ProviderTransient retries see no
          // guardrailPrompt and re-issue the same prompt.
          const recovered = await runWithRecovery<InvokeResult>(
            async (attempt: AttemptContext): Promise<OperationResult<InvokeResult>> => {
              const basePrompt = buildDevPrompt(freshPacket, config);
              const finalPrompt = attempt.guardrailPrompt !== undefined
                ? `${basePrompt}\n\n---\n${attempt.guardrailPrompt}`
                : basePrompt;
              // Phase 7 round-2 — the PRIMARY (initial / retry_same)
              // invocation must come from cascade[0]. The recovery
              // layer's cascade index assumes cascade[0] is what the
              // call site already invoked; using devProvider+devTier
              // alone (with no modelOverride) would invoke the
              // tier-mapped model and SKIP cascade[0].model when the
              // persona has model_failover configured. The cascade[1]
              // hop would then re-try a model the operator never
              // intended as primary.
              const target = attempt.cascade ?? devPrimary;
              const r = await invokeAgent(
                target.provider, finalPrompt, config, devTier, target.model,
                {
                  message: `developer working on packet '${packet.id}'...`,
                  channel: 'develop',
                },
              );
              recordInvocationCost(
                r, opts.runId, packet.id, opts.specId ?? null, artifactRoot,
                perPacketCap, packetCostTracker, dryRun,
              );
              if (r.exit_code === 0) return { outcome: 'ok', value: r };
              // Phase 7 — attach cascade so ProviderUnavailable recipe
              // can walk the failover order.
              return {
                outcome: 'fail',
                failure: {
                  ...failureFromSubprocess({
                    exitCode: r.exit_code,
                    stdout: r.stdout,
                    stderr: r.stderr,
                    kind: 'agent_invocation',
                    specId: opts.specId ?? null,
                    packetId: packet.id,
                    operationLabel: 'develop_phase.implement',
                  }),
                  cascade: devCascade,
                },
              };
            },
            {
              runId: recoveryRunId,
              artifactRoot,
              dryRun,
              specId: opts.specId ?? null,
              packetId: packet.id,
              operationLabel: 'develop_phase.implement',
              budget: recoveryBudget,
            },
            recoveryOptions,
          );
          // Per-packet cost cap fires regardless of recovery outcome.
          if (packetCostTracker.crossed) {
            fmt.log('develop', `  ${fmt.sym.fail} ${fmt.error(`Per-packet cost cap crossed ($${packetCostTracker.total.toFixed(4)} >= $${perPacketCap})`)}`);
            currentPoint = null;
            break;
          }
          // Dispatch on the discriminator. The compiler enforces the
          // exhaustive switch — observable AND controlling.
          if (recovered.kind === 'escalated') {
            fmt.log('develop', `  ${fmt.sym.fail} ${fmt.error(`Escalated (${recovered.scenario}): ${recovered.reason}`)}`);
            markPacketFailed({
              packetId: packet.id,
              artifactRoot,
              recovery: recovered,
              runId: opts.runId,
              dryRun,
            });
            escalated = true;
            break;
          }
          // recovered.kind === 'ok'
          fmt.log('develop', `  ${fmt.sym.ok} Implementation done`);
          currentPoint = nextPointAfterImplement(true);
          break;
        }

        case 'request_review': {
          // request_review is best-effort observability today (the
          // CLI may have already been invoked by the agent). The
          // recovery wrapper still applies because a stale-branch
          // check at this boundary throws, and the wrapper routes
          // that through the StaleBranch recipe.
          const reviewSignal = await runWithRecovery<true>(
            (_attempt: AttemptContext): OperationResult<true> => {
              try {
                requestReview({
                  packetId: packet.id,
                  projectRoot,
                  // Phase 6 — opt in to lifecycle stale-branch
                  // detection. Off by default in the CLI; on for the
                  // pipeline so a behind-origin/main state surfaces
                  // through the StaleBranch recipe.
                  checkStaleBranch: true,
                  ...(opts.gitRunner !== undefined ? { gitRunner: opts.gitRunner } : {}),
                });
                return { outcome: 'ok', value: true };
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                // Already-recorded review-requested, wrong status, etc.
                // are normal idempotency or precondition outcomes; keep
                // the original lifecycle's permissive behavior. We
                // surface stale-branch errors through the recovery
                // layer; everything else stays best-effort.
                if (looksLikeStaleBranchMessage(msg)) {
                  return {
                    outcome: 'fail',
                    failure: failureFromThrow({
                      error: err,
                      kind: 'git',
                      specId: opts.specId ?? null,
                      packetId: packet.id,
                      operationLabel: 'develop_phase.request_review',
                    }),
                  };
                }
                // Other lifecycle errors — log and continue (keeps
                // legacy permissive behavior; the original loop logged
                // and proceeded to review unconditionally).
                fmt.log('develop', `  ${fmt.sym.warn} Could not request review: ${msg}`);
                return { outcome: 'ok', value: true };
              }
            },
            {
              runId: recoveryRunId,
              artifactRoot,
              dryRun,
              specId: opts.specId ?? null,
              packetId: packet.id,
              operationLabel: 'develop_phase.request_review',
              budget: recoveryBudget,
            },
            recoveryOptions,
          );
          if (reviewSignal.kind === 'escalated') {
            fmt.log('develop', `  ${fmt.sym.fail} ${fmt.error(`Escalated (${reviewSignal.scenario}): ${reviewSignal.reason}`)}`);
            markPacketFailed({
              packetId: packet.id,
              artifactRoot,
              recovery: reviewSignal,
              runId: opts.runId,
              dryRun,
            });
            escalated = true;
            break;
          }
          currentPoint = 'review';
          break;
        }

        case 'review': {
          const iterationPacket = readJson<RawPacket>(join(artifactRoot, 'packets', `${packet.id}.json`)) ?? freshPacket;
          const reviewIteration = iterationPacket.review_iteration ?? 0;
          if (reviewIteration >= maxReviewIterations) {
            fmt.log('develop', `  ${fmt.sym.fail} Review not approved after ${maxReviewIterations} iterations`);
            currentPoint = null;
            break;
          }
          fmt.log('review', `  Review iteration ${reviewIteration + 1} via ${reviewProvider} (${reviewTier})...`);
          const reviewerRecovered = await runWithRecovery<InvokeResult>(
            async (attempt: AttemptContext): Promise<OperationResult<InvokeResult>> => {
              // Phase 7 round-2 — primary derived from cascade[0]; see
              // implement closure for the rationale.
              const target = attempt.cascade ?? reviewerPrimary;
              const reviewPromptStr = buildReviewPrompt(freshPacket, config);
              const r = await invokeAgent(
                target.provider, reviewPromptStr, config, reviewTier, target.model,
                {
                  message: `review in progress for packet '${packet.id}'...`,
                  channel: 'review',
                },
              );
              recordInvocationCost(
                r, opts.runId, packet.id, opts.specId ?? null, artifactRoot,
                perPacketCap, packetCostTracker, dryRun,
              );
              if (r.exit_code === 0) return { outcome: 'ok', value: r };
              return {
                outcome: 'fail',
                failure: {
                  ...failureFromSubprocess({
                    exitCode: r.exit_code,
                    stdout: r.stdout,
                    stderr: r.stderr,
                    kind: 'agent_invocation',
                    specId: opts.specId ?? null,
                    packetId: packet.id,
                    operationLabel: 'develop_phase.review',
                  }),
                  cascade: reviewerCascade,
                },
              };
            },
            {
              runId: recoveryRunId,
              artifactRoot,
              dryRun,
              specId: opts.specId ?? null,
              packetId: packet.id,
              operationLabel: 'develop_phase.review',
              budget: recoveryBudget,
            },
            recoveryOptions,
          );
          if (packetCostTracker.crossed) {
            fmt.log('review', `  ${fmt.sym.fail} ${fmt.error(`Per-packet cost cap crossed ($${packetCostTracker.total.toFixed(4)} >= $${perPacketCap})`)}`);
            currentPoint = null;
            break;
          }
          if (reviewerRecovered.kind === 'escalated') {
            fmt.log('review', `  ${fmt.sym.fail} ${fmt.error(`Escalated (${reviewerRecovered.scenario}): ${reviewerRecovered.reason}`)}`);
            markPacketFailed({
              packetId: packet.id,
              artifactRoot,
              recovery: reviewerRecovered,
              runId: opts.runId,
              dryRun,
            });
            escalated = true;
            break;
          }
          // recovered.kind === 'ok' — reviewer ran cleanly; check status.
          const afterReview = readJson<RawPacket>(join(artifactRoot, 'packets', `${packet.id}.json`));
          const afterStatus = afterReview?.status ?? null;
          if (afterStatus === 'review_approved') {
            fmt.log('review', `  ${fmt.sym.ok} Review approved`);
          } else if (afterStatus === 'changes_requested') {
            fmt.log('review', `  ${fmt.sym.warn} Changes requested`);
          } else {
            safeCall(() => recordReview({ packetId: packet.id, decision: 'approve', projectRoot }));
            fmt.log('review', `  ${fmt.sym.ok} Review complete`);
          }
          currentPoint = nextPointAfterReview(true, afterStatus);
          break;
        }

        case 'rework': {
          fmt.log('develop', `  Reworking via ${devProvider} (${devTier})...`);
          const reworkRecovered = await runWithRecovery<InvokeResult>(
            async (attempt: AttemptContext): Promise<OperationResult<InvokeResult>> => {
              const basePrompt = buildReworkPrompt(freshPacket, config);
              const finalPrompt = attempt.guardrailPrompt !== undefined
                ? `${basePrompt}\n\n---\n${attempt.guardrailPrompt}`
                : basePrompt;
              // Phase 7 round-2 — primary derived from cascade[0]; see
              // implement closure for the rationale.
              const target = attempt.cascade ?? devPrimary;
              const r = await invokeAgent(
                target.provider, finalPrompt, config, devTier, target.model,
                {
                  message: `developer reworking packet '${packet.id}'...`,
                  channel: 'develop',
                },
              );
              recordInvocationCost(
                r, opts.runId, packet.id, opts.specId ?? null, artifactRoot,
                perPacketCap, packetCostTracker, dryRun,
              );
              if (r.exit_code === 0) return { outcome: 'ok', value: r };
              return {
                outcome: 'fail',
                failure: {
                  ...failureFromSubprocess({
                    exitCode: r.exit_code,
                    stdout: r.stdout,
                    stderr: r.stderr,
                    kind: 'agent_invocation',
                    specId: opts.specId ?? null,
                    packetId: packet.id,
                    operationLabel: 'develop_phase.rework',
                  }),
                  cascade: devCascade,
                },
              };
            },
            {
              runId: recoveryRunId,
              artifactRoot,
              dryRun,
              specId: opts.specId ?? null,
              packetId: packet.id,
              operationLabel: 'develop_phase.rework',
              budget: recoveryBudget,
            },
            recoveryOptions,
          );
          if (packetCostTracker.crossed) {
            fmt.log('develop', `  ${fmt.sym.fail} ${fmt.error(`Per-packet cost cap crossed ($${packetCostTracker.total.toFixed(4)} >= $${perPacketCap})`)}`);
            currentPoint = null;
            break;
          }
          if (reworkRecovered.kind === 'escalated') {
            fmt.log('develop', `  ${fmt.sym.fail} ${fmt.error(`Escalated (${reworkRecovered.scenario}): ${reworkRecovered.reason}`)}`);
            markPacketFailed({
              packetId: packet.id,
              artifactRoot,
              recovery: reworkRecovered,
              runId: opts.runId,
              dryRun,
            });
            escalated = true;
            break;
          }
          currentPoint = nextPointAfterRework(true);
          break;
        }

        case 'finalize': {
          fmt.log('develop', `  Running verification...`);
          // Wrap completePacket in runWithRecovery so BuildFailed,
          // LintFailed, TestFailed, CompletionGateBlocked, and
          // StaleBranch classify correctly at the phase boundary.
          //
          // The closure dispatches on TWO failure modes:
          //   (a) the lib throws (precondition, FI-1, FI-7 / pre-commit
          //       hook, OR stale-branch when checkStaleBranch is on).
          //       Stale-branch throws are routed via kind: 'git';
          //       everything else stays 'lifecycle'.
          //   (b) the lib returns CompleteResult with ci_pass=false.
          //       The closure builds the explicit failed_checks list
          //       so the classifier dispatches authoritatively.
          //
          // Phase 6 round-2 fix: BuildFailed remediation requires the
          // dev agent to run AGAIN with the guardrail prompt before the
          // retry of completePacket. Without that step, completePacket
          // would observe the same failure forever. This dispatch
          // mirrors the implement/rework closures above.
          //
          // Phase 6 round-2 idempotency fix: completePacket is now
          // atomic — it does NOT write a completion record on
          // ci_pass=false. So `already_complete` is reachable only on
          // success, and the prior `if (r.already_complete) ok`
          // short-circuit (which used to false-succeed a failed
          // completion) is gone.
          // Phase 7 round-2 fix — BuildFailed remediation has a
          // *compound* recovery action (run the dev agent, then re-
          // run completePacket). When the recovery layer dispatches
          // `cascade_provider` *during* a remediation cycle (i.e.
          // the dev-agent invocation just failed ProviderUnavailable),
          // the next closure invocation must STILL run the
          // remediation step against the new (provider, model)
          // before re-trying completePacket. Otherwise the
          // remediation prompt is lost across the cascade boundary
          // and completePacket re-runs against unchanged code.
          //
          // The fix: closure-scoped state.
          //   - `pendingRemediationPrompt`: set when
          //     `retry_with_guardrail_prompt` first fires; cleared
          //     after the remediation+completePacket pair succeeds.
          //     While it's non-null, every attempt re-issues the
          //     remediation step before falling through to
          //     completePacket.
          //   - `lastRemediationTarget`: the (provider, model) the
          //     last remediation invocation used. A retry_same after
          //     a transient remediation failure must re-issue against
          //     the SAME hop; a cascade_provider issues against the
          //     new hop.
          //
          // Lifetime: closure level (per-finalize-invocation), not
          // per-packet. The recovery loop returns on success; the
          // closure won't be re-entered after a clean ci_pass.
          let pendingRemediationPrompt: string | null = null;
          let lastRemediationTarget: typeof devPrimary | null = null;

          const runRemediation = async (
            target: typeof devPrimary,
            guardrail: string,
          ): Promise<OperationResult<true> | null> => {
            // Returns null on success (caller proceeds to
            // completePacket); returns OperationResult<true> with
            // outcome='fail' on agent failure.
            const basePrompt = buildDevPrompt(freshPacket, config);
            const remediationPrompt =
              `${basePrompt}\n\n---\n${guardrail}`;
            lastRemediationTarget = target;
            const r = await invokeAgent(
              target.provider, remediationPrompt, config, devTier, target.model,
              {
                message: `build remediation invoked for packet '${packet.id}'...`,
                channel: 'develop',
              },
            );
            recordInvocationCost(
              r, opts.runId, packet.id, opts.specId ?? null, artifactRoot,
              perPacketCap, packetCostTracker, dryRun,
            );
            if (r.exit_code !== 0) {
              return {
                outcome: 'fail',
                failure: {
                  ...failureFromSubprocess({
                    exitCode: r.exit_code,
                    stdout: r.stdout,
                    stderr: r.stderr,
                    kind: 'agent_invocation',
                    specId: opts.specId ?? null,
                    packetId: packet.id,
                    operationLabel: 'develop_phase.complete.remediation',
                  }),
                  // Attach the dev cascade so a remediation-step
                  // ProviderUnavailable failure can fail over.
                  cascade: devCascade,
                },
              };
            }
            return null;
          };

          const finalizeRecovered = await runWithRecovery<true>(
            async (attempt: AttemptContext): Promise<OperationResult<true>> => {
              // Step 1: handle the remediation half of the compound
              // action. Three cases keep state coherent across
              // recovery action boundaries:
              //
              //  (a) recipe just dispatched retry_with_guardrail_prompt:
              //      capture the prompt and run remediation against
              //      devPrimary.
              //  (b) recipe dispatched cascade_provider AND we have a
              //      pending remediation prompt: run remediation
              //      against the new cascade hop with the SAME
              //      guardrail prompt the BuildFailed recipe issued.
              //      Load-bearing fix: without this, a remediation-
              //      step ProviderUnavailable would silently lose the
              //      guardrail prompt and completePacket would
              //      re-fail forever.
              //  (c) recipe dispatched retry_same (ProviderTransient
              //      on the remediation agent) AND we have a pending
              //      remediation prompt: re-issue against the SAME
              //      target as the last remediation attempt.
              if (attempt.action === 'retry_with_guardrail_prompt'
                && attempt.guardrailPrompt !== undefined) {
                pendingRemediationPrompt = attempt.guardrailPrompt;
                const fail = await runRemediation(devPrimary, pendingRemediationPrompt);
                if (fail !== null) return fail;
              } else if (attempt.action === 'cascade_provider'
                && attempt.cascade !== undefined
                && pendingRemediationPrompt !== null) {
                const fail = await runRemediation(attempt.cascade, pendingRemediationPrompt);
                if (fail !== null) return fail;
              } else if (attempt.action === 'retry_same'
                && pendingRemediationPrompt !== null
                && lastRemediationTarget !== null) {
                const fail = await runRemediation(lastRemediationTarget, pendingRemediationPrompt);
                if (fail !== null) return fail;
              }
              // (No special-case for the very first attempt:
              // pendingRemediationPrompt remains null on first entry,
              // so we go straight to completePacket.)
              try {
                const r = completePacket({
                  packetId: packet.id,
                  identity: devIdentity,
                  projectRoot,
                  // Phase 6 — opt in to lifecycle stale-branch
                  // detection at the complete boundary as well.
                  checkStaleBranch: true,
                  ...(opts.gitRunner !== undefined ? { gitRunner: opts.gitRunner } : {}),
                });
                if (r.ci_pass) {
                  // Clear the pending remediation prompt: the
                  // recipe's promise (run dev agent + retry
                  // completePacket) has been kept. The loop returns
                  // ok and the closure isn't re-entered, so this is
                  // primarily a contract-clarity reset rather than a
                  // correctness one.
                  pendingRemediationPrompt = null;
                  lastRemediationTarget = null;
                  return { outcome: 'ok', value: true };
                }
                const failedChecks: Array<'build' | 'lint' | 'tests' | 'ci'> = [];
                if (!r.build_pass) failedChecks.push('build');
                if (!r.lint_pass) failedChecks.push('lint');
                if (!r.tests_pass) failedChecks.push('tests');
                if (failedChecks.length === 0) failedChecks.push('ci');
                return {
                  outcome: 'fail',
                  failure: failureFromSubprocess({
                    exitCode: 1,
                    stdout: '',
                    stderr: `Verification failed: ${failedChecks.join(', ')}`,
                    kind: 'verification',
                    failedChecks,
                    specId: opts.specId ?? null,
                    packetId: packet.id,
                    operationLabel: 'develop_phase.complete',
                  }),
                };
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                const kind: 'git' | 'lifecycle' = looksLikeStaleBranchMessage(msg)
                  ? 'git'
                  : 'lifecycle';
                return {
                  outcome: 'fail',
                  failure: failureFromThrow({
                    error: err,
                    kind,
                    specId: opts.specId ?? null,
                    packetId: packet.id,
                    operationLabel: 'develop_phase.complete',
                  }),
                };
              }
            },
            {
              runId: recoveryRunId,
              artifactRoot,
              dryRun,
              specId: opts.specId ?? null,
              packetId: packet.id,
              operationLabel: 'develop_phase.complete',
              budget: recoveryBudget,
            },
            recoveryOptions,
          );
          if (finalizeRecovered.kind === 'escalated') {
            fmt.log('develop', `  ${fmt.sym.fail} ${fmt.error(`Escalated (${finalizeRecovered.scenario}): ${finalizeRecovered.reason}`)}`);
            markPacketFailed({
              packetId: packet.id,
              artifactRoot,
              recovery: finalizeRecovered,
              runId: opts.runId,
              dryRun,
            });
            escalated = true;
            break;
          }
          fmt.log('develop', `  ${fmt.sym.ok} ${fmt.success('Completed')}`);
          completionIds.add(packet.id);
          currentPoint = nextPointAfterFinalize(true);
          break;
        }
      }
    }

    if (currentPoint === 'completed' && !escalated) {
      completed.push(packet.id);
    } else {
      // Escalation, cap-block, max-review-iterations exhaustion, OR
      // a recipe-level escalate all land here. The packet is in the
      // failed list; the per-packet state machine has stopped; the
      // outer for-loop continues to the next independent packet.
      failed.push(packet.id);
    }
  }

  return { completed, failed };
}
