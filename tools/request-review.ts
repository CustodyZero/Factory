#!/usr/bin/env tsx
/**
 * Factory — Request Code Review (CLI)
 *
 * Transitions a dev packet from 'implementing' (or 'changes_requested')
 * to 'review_requested'. Captures the current git branch and increments
 * the review iteration counter.
 *
 * Usage:
 *   npx tsx tools/request-review.ts <packet-id>
 *   npx tsx tools/request-review.ts <packet-id> --branch <branch-name>
 *
 * Phase 3 of specs/single-entry-pipeline.md moved the implementation to
 * tools/lifecycle/request_review.ts so run.ts can call it via import.
 * This file remains as the agent-facing CLI: argument parsing, output
 * rendering, exit codes.
 *
 * Re-exports requestReview, RequestReviewError, and the option/outcome
 * types for backward compat with any caller that imported them from
 * this path before Phase 3.
 */

import {
  requestReview,
  RequestReviewError,
} from './lifecycle/request_review.js';
import type {
  RequestReviewOptions,
  RequestReviewOutcome,
  RequestReviewResult,
} from './lifecycle/request_review.js';
import * as fmt from './output.js';

export { requestReview, RequestReviewError };
export type { RequestReviewOptions, RequestReviewOutcome, RequestReviewResult };

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith('--'));
  const packetId = positional[0];
  const branchIdx = args.indexOf('--branch');
  const branchOverride = branchIdx !== -1 ? args[branchIdx + 1] : undefined;

  if (packetId == null || packetId === '' || packetId.startsWith('--')) {
    console.error('Usage: npx tsx tools/request-review.ts <packet-id> [--branch <branch-name>]');
    console.error('');
    console.error('Transitions a dev packet to review_requested status.');
    console.error('The code_reviewer persona is then dispatched to review the branch.');
    process.exit(1);
  }

  try {
    const outcome = requestReview({ packetId, branchOverride });

    if (outcome.kind === 'already_requested') {
      const branchLabel = outcome.branch ?? '<unknown>';
      console.log(
        `Review already requested for packet '${outcome.packet_id}' on branch '${branchLabel}' (iteration ${outcome.review_iteration}). No action taken.`,
      );
      process.exit(0);
    }

    console.log(`${fmt.sym.ok} ${fmt.success('Review requested:')} ${fmt.bold(outcome.packet_id)}`);
    console.log(`  status: ${fmt.info('review_requested')}`);
    console.log(`  branch: ${fmt.info(outcome.branch)}`);
    console.log(`  review_iteration: ${outcome.review_iteration}`);
    if (outcome.was_changes_requested) {
      console.log(`  (re-request after changes — iteration incremented)`);
    }
  } catch (e) {
    if (e instanceof RequestReviewError) {
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

const isDirectExecution =
  process.argv[1]?.endsWith('request-review.ts') || process.argv[1]?.endsWith('request-review.js');
if (isDirectExecution) {
  main();
}
