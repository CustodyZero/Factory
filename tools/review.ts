#!/usr/bin/env tsx
/**
 * Factory — Code Review Decision
 *
 * Records a code review decision on a dev packet that is in
 * 'review_requested' status. Transitions the packet to either
 * 'review_approved' or 'changes_requested'.
 *
 * Usage:
 *   npx tsx tools/review.ts <packet-id> --approve
 *   npx tsx tools/review.ts <packet-id> --request-changes
 *
 * Behavior:
 *   1. Validates the packet exists and is a dev packet
 *   2. Validates status is 'review_requested'
 *   3. Sets status to 'review_approved' or 'changes_requested'
 *
 * Idempotency:
 *   If the packet is already in the requested decision state, this script
 *   prints an informative message and exits 0 without modifying the packet
 *   file. Specifically:
 *     - --approve on an already-approved packet → no-op success
 *     - --request-changes on an already-changes_requested packet → no-op success
 *   Mismatched re-decisions (e.g., --approve after changes_requested) are
 *   rejected with a clear error; the user must run request-review.ts again
 *   to reset the lifecycle state before recording a different decision.
 *
 * Review feedback lives in git (branch diffs, git notes, etc.) — not
 * in factory artifacts. This tool only manages the lifecycle transition.
 *
 * After --approve:
 *   The developer calls complete.ts to create the completion record.
 *
 * After --request-changes:
 *   The developer addresses feedback, then calls request-review.ts again.
 *   This increments review_iteration for the next round.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, findProjectRoot, resolveArtifactRoot } from './config.js';
import * as fmt from './output.js';
import type { FactoryConfig } from './config.js';

// ---------------------------------------------------------------------------
// Exported function for programmatic use and unit testing
// ---------------------------------------------------------------------------

export type ReviewDecision = 'approve' | 'request_changes';

export interface RecordReviewOptions {
  readonly packetId: string;
  readonly decision: ReviewDecision;
  readonly projectRoot?: string;
  readonly config?: FactoryConfig;
}

export type RecordReviewOutcome =
  | {
      readonly kind: 'recorded';
      readonly packet_id: string;
      readonly status: 'review_approved' | 'changes_requested';
      readonly review_iteration: number;
    }
  | {
      readonly kind: 'already_recorded';
      readonly packet_id: string;
      readonly status: 'review_approved' | 'changes_requested';
      readonly review_iteration: number;
    };

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

  return {
    kind: 'recorded',
    packet_id: packetId,
    status: targetStatus,
    review_iteration: iteration,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith('--'));
  const packetId = positional[0];
  const approveFlag = args.includes('--approve');
  const changesFlag = args.includes('--request-changes');

  if (packetId == null || packetId === '' || packetId.startsWith('--')) {
    console.error('Usage: npx tsx tools/review.ts <packet-id> --approve|--request-changes');
    console.error('');
    console.error('Records a code review decision on a dev packet.');
    console.error('');
    console.error('Options:');
    console.error('  --approve           Mark the code review as approved');
    console.error('  --request-changes   Request changes from the developer');
    process.exit(1);
  }

  if (!approveFlag && !changesFlag) {
    console.error('ERROR: Must specify either --approve or --request-changes.');
    process.exit(1);
  }

  if (approveFlag && changesFlag) {
    console.error('ERROR: Cannot specify both --approve and --request-changes.');
    process.exit(1);
  }

  const decision: ReviewDecision = approveFlag ? 'approve' : 'request_changes';

  try {
    const outcome = recordReview({ packetId, decision });

    if (outcome.kind === 'already_recorded') {
      if (outcome.status === 'review_approved') {
        console.log(`Packet '${outcome.packet_id}' is already approved. No action taken.`);
      } else {
        console.log(`Packet '${outcome.packet_id}' already has changes requested. No action taken.`);
      }
      process.exit(0);
    }

    console.log(`${fmt.sym.ok} ${fmt.success('Review decision:')} ${fmt.bold(outcome.packet_id)}`);
    console.log(`  status: ${fmt.info(outcome.status)}`);
    console.log(`  review_iteration: ${outcome.review_iteration}`);
    if (outcome.status === 'review_approved') {
      console.log(`  Next step: npx tsx tools/complete.ts ${outcome.packet_id}`);
    } else {
      console.log(
        `  Next step: developer addresses feedback, then npx tsx tools/request-review.ts ${outcome.packet_id}`,
      );
    }
  } catch (e) {
    if (e instanceof RecordReviewError) {
      console.error(`ERROR: ${e.message}`);
      for (const detail of e.details) {
        console.error(`  ${detail}`);
      }
    } else {
      console.error(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
    }
    process.exit(1);
  }
}

// Anchor on the path separator so 'request-review.ts' invocations do not
// accidentally match 'review.ts' as a suffix.
const isDirectExecution =
  process.argv[1]?.endsWith('/review.ts') || process.argv[1]?.endsWith('/review.js');
if (isDirectExecution) {
  main();
}
