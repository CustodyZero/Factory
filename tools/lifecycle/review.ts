/**
 * Factory — Lifecycle / Record Review
 *
 * Library function for recording a code review decision (--approve or
 * --request-changes) on a dev packet. The CLI wrapper at tools/review.ts
 * re-exports from here.
 *
 * SCOPE FOR PHASE 3
 *
 * Phase 2 already extracted recordReview() and RecordReviewError as
 * exports of tools/review.ts. Phase 3 moves them into this dedicated
 * module so run.ts can import them by responsibility (lifecycle) rather
 * than by historical filename. The CLI wrapper continues to re-export
 * for backward compatibility.
 *
 * I/O: this file reads/writes packet JSON. It does NOT shell out to other
 * lifecycle scripts.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, findProjectRoot, resolveArtifactRoot } from '../config.js';
import type { FactoryConfig } from '../config.js';
import { appendLifecycleEvent } from '../events.js';
import {
  makePacketReviewApproved,
  makePacketChangesRequested,
} from '../pipeline/events.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ReviewDecision = 'approve' | 'request_changes';

export interface RecordReviewOptions {
  readonly packetId: string;
  readonly decision: ReviewDecision;
  readonly projectRoot?: string;
  readonly config?: FactoryConfig;
}

/**
 * Discriminated outcome. The CLI uses the discriminator to render the
 * "decision already recorded" path; library callers can pattern-match.
 *
 * `already_decided` is the boolean alias matching the
 * `already_started` / `already_complete` shape on the other lifecycle
 * results. Both fields describe the same value.
 */
export type RecordReviewOutcome =
  | {
      readonly kind: 'recorded';
      readonly packet_id: string;
      readonly status: 'review_approved' | 'changes_requested';
      readonly review_iteration: number;
      readonly already_decided: false;
    }
  | {
      readonly kind: 'already_recorded';
      readonly packet_id: string;
      readonly status: 'review_approved' | 'changes_requested';
      readonly review_iteration: number;
      readonly already_decided: true;
    };

export type RecordReviewResult = RecordReviewOutcome;

const DECISION_TO_STATUS: Record<ReviewDecision, 'review_approved' | 'changes_requested'> = {
  approve: 'review_approved',
  request_changes: 'changes_requested',
};

/**
 * Structured error so the CLI can render the original multi-line output
 * (`ERROR: <summary>` followed by indented detail lines) without losing
 * any guidance, while library callers still get a normal Error with a
 * single-line `.message` (the summary) for assertions.
 */
export class RecordReviewError extends Error {
  readonly details: ReadonlyArray<string>;
  constructor(summary: string, details: ReadonlyArray<string> = []) {
    super(summary);
    this.name = 'RecordReviewError';
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Library entry
// ---------------------------------------------------------------------------

/**
 * Programmatic entry to record a code-review decision.
 *
 * Throws on precondition failures (missing packet, wrong kind, mismatched
 * already-recorded decision, wrong status). Returns an outcome describing
 * whether the file was written or the decision was already recorded.
 */
export function recordReview(options: RecordReviewOptions): RecordReviewOutcome {
  const config = options.config ?? loadConfig(options.projectRoot);
  const projectRoot = options.projectRoot ?? findProjectRoot();
  const artifactRoot = resolveArtifactRoot(projectRoot, config);
  const { packetId, decision } = options;

  const packetPath = join(artifactRoot, 'packets', `${packetId}.json`);
  if (!existsSync(packetPath)) {
    throw new RecordReviewError(`Packet not found: packets/${packetId}.json`);
  }

  const packet = JSON.parse(readFileSync(packetPath, 'utf-8')) as Record<string, unknown>;

  if (packet['kind'] !== 'dev') {
    throw new RecordReviewError(
      'Only dev packets go through code review.',
      [`Packet '${packetId}' has kind '${String(packet['kind'])}'.`],
    );
  }

  const status = typeof packet['status'] === 'string' ? packet['status'] : null;
  const iteration = typeof packet['review_iteration'] === 'number' ? packet['review_iteration'] : 0;
  const targetStatus = DECISION_TO_STATUS[decision];

  // Idempotency: same decision already recorded → no-op success.
  // Detection happens BEFORE any state change.
  if (status === targetStatus) {
    return {
      kind: 'already_recorded',
      packet_id: packetId,
      status: targetStatus,
      review_iteration: iteration,
      already_decided: true,
    };
  }

  // Mismatched re-decision is still an error. The reviewer must explicitly
  // reset the lifecycle (request-review again) before flipping the decision.
  if (status === 'review_approved' || status === 'changes_requested') {
    throw new RecordReviewError(
      `Packet '${packetId}' already has decision '${status}'.`,
      [
        `Cannot change to '${targetStatus}' without resetting state.`,
        `Run: npx tsx tools/request-review.ts ${packetId} to re-open review, then record the new decision.`,
      ],
    );
  }

  if (status !== 'review_requested') {
    // Note: status === 'changes_requested' is handled by the earlier
    // mismatched-re-decision branch, so it cannot reach this hint. Only
    // 'implementing' produces the request-review hint here.
    const details: string[] = [
      `Only packets in 'review_requested' status can be reviewed.`,
    ];
    if (status === 'implementing') {
      details.push('The developer must call request-review.ts first.');
    }
    throw new RecordReviewError(
      `Packet '${packetId}' has status '${String(status)}'.`,
      details,
    );
  }

  packet['status'] = targetStatus;
  writeFileSync(packetPath, JSON.stringify(packet, null, 2) + '\n', 'utf-8');

  // Phase 5.5 — emit packet.review_approved or packet.changes_requested
  // based on the decision. No-op outside an orchestrator session.
  if (targetStatus === 'review_approved') {
    appendLifecycleEvent(
      (base) => makePacketReviewApproved(base, {
        packet_id: packetId,
        review_iteration: iteration,
      }),
      artifactRoot,
    );
  } else {
    appendLifecycleEvent(
      (base) => makePacketChangesRequested(base, {
        packet_id: packetId,
        review_iteration: iteration,
      }),
      artifactRoot,
    );
  }

  return {
    kind: 'recorded',
    packet_id: packetId,
    status: targetStatus,
    review_iteration: iteration,
    already_decided: false,
  };
}
