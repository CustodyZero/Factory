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

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Feature, RawPacket } from '../execute.js';
import type { FactoryConfig, ModelTier } from '../config.js';
import * as fmt from '../output.js';
import { topoSort } from './topo.js';
import { invokeAgent } from './agent_invoke.js';
import { buildDevPrompt, buildReviewPrompt, buildReworkPrompt } from './prompts.js';
import { refreshCompletionId, safeCall } from './lifecycle_helpers.js';
import { startPacket } from '../lifecycle/start.js';
import { requestReview } from '../lifecycle/request_review.js';
import { recordReview } from '../lifecycle/review.js';
import { completePacket } from '../lifecycle/complete.js';
import {
  makePhaseStarted,
  makePhaseCompleted,
} from './events.js';
import { appendEvent } from '../events.js';

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

/**
 * Run the develop phase for a feature: implement / review / rework /
 * finalize each dev packet in topological order. Returns the lists
 * of completed and failed packet ids.
 */
export function runDevelopPhase(opts: DevelopPhaseOptions): DevelopPhaseResult {
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

  const result = runDevelopPhaseInner(opts);

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

function runDevelopPhaseInner(opts: DevelopPhaseOptions): DevelopPhaseResult {
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
  const devProvider = config.pipeline?.persona_providers.developer ?? 'codex';
  const devTier: ModelTier = config.personas.developer.model ?? 'high';
  const devIdentity = config.pipeline?.completion_identities.developer ?? 'codex-dev';
  const reviewProvider = config.pipeline?.persona_providers.code_reviewer ?? 'claude';
  const reviewTier: ModelTier = config.personas.code_reviewer.model ?? 'medium';

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

    // Check dependencies are met before proceeding.
    const deps = freshPacket.dependencies ?? [];
    const unmetDeps = deps.filter((d) => !completionIds.has(d));
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

    // State machine: I/O per step, then a pure transition function from
    // above decides where to go next. `null` = failed.
    let currentPoint: DevResumePoint | null = resumePoint;

    while (currentPoint !== null && currentPoint !== 'completed') {
      switch (currentPoint) {
        case 'implement': {
          safeCall(() => startPacket({ packetId: packet.id, projectRoot }));
          fmt.log('develop', `  Implementing via ${devProvider} (${devTier})...`);
          const devResult = invokeAgent(devProvider, buildDevPrompt(freshPacket, config), config, devTier);
          const devOk = devResult.exit_code === 0;
          fmt.log('develop', devOk
            ? `  ${fmt.sym.ok} Implementation done`
            : `  ${fmt.sym.fail} ${fmt.error('Developer agent failed')}`);
          currentPoint = nextPointAfterImplement(devOk);
          break;
        }

        case 'request_review': {
          const reviewSignal = safeCall(() => requestReview({ packetId: packet.id, projectRoot }));
          if (!reviewSignal.ok) {
            const detail = reviewSignal.error ? `: ${reviewSignal.error}` : '';
            fmt.log('develop', `  ${fmt.sym.warn} Could not request review${detail}`);
          }
          currentPoint = 'review'; // unconditional: best-effort above
          break;
        }

        case 'review': {
          // Re-read packet: the previous step (request_review) may have
          // bumped review_iteration, and the developer agent may have
          // changed status during implementation.
          const iterationPacket = readJson<RawPacket>(join(artifactRoot, 'packets', `${packet.id}.json`)) ?? freshPacket;
          const reviewIteration = iterationPacket.review_iteration ?? 0;
          if (reviewIteration >= maxReviewIterations) {
            fmt.log('develop', `  ${fmt.sym.fail} Review not approved after ${maxReviewIterations} iterations`);
            currentPoint = null;
            break;
          }
          fmt.log('review', `  Review iteration ${reviewIteration + 1} via ${reviewProvider} (${reviewTier})...`);
          const reviewResult = invokeAgent(reviewProvider, buildReviewPrompt(freshPacket, config), config, reviewTier);
          if (reviewResult.exit_code !== 0) {
            fmt.log('review', `  ${fmt.sym.fail} Reviewer agent failed`);
            currentPoint = nextPointAfterReview(false, null);
            break;
          }
          // The reviewer agent may have set status itself (via the review.ts
          // CLI). Re-read to find out.
          const afterReview = readJson<RawPacket>(join(artifactRoot, 'packets', `${packet.id}.json`));
          const afterStatus = afterReview?.status ?? null;
          if (afterStatus === 'review_approved') {
            fmt.log('review', `  ${fmt.sym.ok} Review approved`);
          } else if (afterStatus === 'changes_requested') {
            fmt.log('review', `  ${fmt.sym.warn} Changes requested`);
          } else {
            // Reviewer didn't transition status — force approve.
            safeCall(() => recordReview({ packetId: packet.id, decision: 'approve', projectRoot }));
            fmt.log('review', `  ${fmt.sym.ok} Review complete`);
          }
          currentPoint = nextPointAfterReview(true, afterStatus);
          break;
        }

        case 'rework': {
          fmt.log('develop', `  Reworking via ${devProvider} (${devTier})...`);
          const reworkResult = invokeAgent(devProvider, buildReworkPrompt(freshPacket, config), config, devTier);
          if (reworkResult.exit_code !== 0) fmt.log('develop', `  ${fmt.sym.fail} Rework failed`);
          currentPoint = nextPointAfterRework(reworkResult.exit_code === 0);
          break;
        }

        case 'finalize': {
          fmt.log('develop', `  Running verification...`);
          const completion = safeCall(() => completePacket({ packetId: packet.id, identity: devIdentity, projectRoot }));
          if (completion.ok) {
            fmt.log('develop', `  ${fmt.sym.ok} ${fmt.success('Completed')}`);
            completionIds.add(packet.id);
          } else {
            fmt.log('develop', `  ${fmt.sym.fail} Completion failed`);
          }
          currentPoint = nextPointAfterFinalize(completion.ok);
          break;
        }
      }
    }

    if (currentPoint === 'completed') {
      completed.push(packet.id);
    } else {
      failed.push(packet.id);
    }
  }

  return { completed, failed };
}
