/**
 * Factory — Pipeline / Develop-Phase State Machine
 *
 * Pure functions that drive the dev-packet lifecycle decisions.
 *
 * The imperative loop in `tools/run.ts` reads packet state from disk,
 * invokes agents, and reacts to results. Those side effects stay
 * imperative. The DECISIONS — "given this state, what's the next
 * resume point?" — are pulled out here so they can be unit-tested
 * without spawning provider CLIs or touching the filesystem.
 *
 * Each pure function below maps an outcome of an I/O step to the
 * next resume point. `null` means "this packet failed; stop the
 * loop." `'completed'` means "this packet is done; advance to the
 * next packet."
 *
 * These mirrors the existing run.ts loop verbatim. No behavior
 * change in this phase.
 */

import type { RawPacket } from '../execute.js';

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
