#!/usr/bin/env tsx
/**
 * Factory — Code Review Decision (CLI)
 *
 * Records a code review decision on a dev packet that is in
 * 'review_requested' status. Transitions the packet to either
 * 'review_approved' or 'changes_requested'.
 *
 * Usage:
 *   npx tsx tools/review.ts <packet-id> --approve
 *   npx tsx tools/review.ts <packet-id> --request-changes
 *
 * Phase 3 of specs/single-entry-pipeline.md moved the implementation to
 * tools/lifecycle/review.ts so run.ts can call it via import. This file
 * remains as the agent-facing CLI: argument parsing, output rendering,
 * exit codes.
 *
 * Re-exports recordReview, RecordReviewError, and the option/outcome
 * types for backward compat with any caller that imported them from
 * this path before Phase 3.
 *
 * After --approve:
 *   The developer calls complete.ts to create the completion record.
 *
 * After --request-changes:
 *   The developer addresses feedback, then calls request-review.ts again.
 *   This increments review_iteration for the next round.
 */

import { recordReview, RecordReviewError } from './lifecycle/review.js';
import type {
  RecordReviewOptions,
  RecordReviewOutcome,
  RecordReviewResult,
  ReviewDecision,
} from './lifecycle/review.js';
import * as fmt from './output.js';

export { recordReview, RecordReviewError };
export type { RecordReviewOptions, RecordReviewOutcome, RecordReviewResult, ReviewDecision };

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
