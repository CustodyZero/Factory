#!/usr/bin/env tsx
/**
 * Factory — Request Code Review
 *
 * Transitions a dev packet from 'implementing' (or 'changes_requested')
 * to 'review_requested'. Captures the current git branch and increments
 * the review iteration counter.
 *
 * Usage:
 *   npx tsx tools/request-review.ts <packet-id>
 *   npx tsx tools/request-review.ts <packet-id> --branch <branch-name>
 *
 * Behavior:
 *   1. Validates the packet exists and is a dev packet
 *   2. Validates status is 'implementing' or 'changes_requested'
 *   3. Captures the current git branch (or uses --branch override)
 *   4. Sets status to 'review_requested'
 *   5. Sets the branch field on the packet
 *   6. Increments review_iteration (on re-requests after changes_requested)
 *
 * Idempotency:
 *   If the packet is already in 'review_requested' status, this script
 *   prints an informative message and exits 0 without modifying the
 *   packet file. This matches the start.ts idempotency pattern and
 *   makes the script safe to re-invoke.
 *
 * This is the developer's tool for signaling "my code is ready for review".
 * The pipeline runner (run.ts) then invokes a code_reviewer agent.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { loadConfig, findProjectRoot, resolveArtifactRoot } from './config.js';
import * as fmt from './output.js';
import type { FactoryConfig } from './config.js';

// ---------------------------------------------------------------------------
// Exported function for programmatic use and unit testing
// ---------------------------------------------------------------------------

export interface RequestReviewOptions {
  readonly packetId: string;
  readonly branchOverride?: string;
  readonly projectRoot?: string;
  readonly config?: FactoryConfig;
}

export type RequestReviewOutcome =
  | {
      readonly kind: 'recorded';
      readonly packet_id: string;
      readonly branch: string;
      readonly review_iteration: number;
      readonly was_changes_requested: boolean;
    }
  | {
      readonly kind: 'already_requested';
      readonly packet_id: string;
      readonly branch: string | null;
      readonly review_iteration: number;
    };

/**
 * Structured error so the CLI can render the original multi-line output
 * (`ERROR: <summary>` followed by indented detail lines) without losing
 * any guidance, while library callers still get a normal Error with a
 * single-line `.message` (the summary) for assertions.
 *
 * Library callers that want the structured detail can downcast and read
 * `.details`; everyone else gets the same shape Error has always had.
 */
export class RequestReviewError extends Error {
  readonly details: ReadonlyArray<string>;
  constructor(summary: string, details: ReadonlyArray<string> = []) {
    super(summary);
    this.name = 'RequestReviewError';
    this.details = details;
  }
}

/**
 * Programmatic entry to record a review request.
 *
 * Throws on precondition failures (missing packet, wrong kind, wrong status,
 * not started, missing branch). Returns an outcome describing whether work
 * was done or the request was already recorded.
 */
export function requestReview(options: RequestReviewOptions): RequestReviewOutcome {
  const config = options.config ?? loadConfig(options.projectRoot);
  const projectRoot = options.projectRoot ?? findProjectRoot();
  const artifactRoot = resolveArtifactRoot(projectRoot, config);
  const { packetId } = options;

  const packetPath = join(artifactRoot, 'packets', `${packetId}.json`);
  if (!existsSync(packetPath)) {
    throw new RequestReviewError(`Packet not found: packets/${packetId}.json`);
  }

  const packet = JSON.parse(readFileSync(packetPath, 'utf-8')) as Record<string, unknown>;

  if (packet['kind'] !== 'dev') {
    throw new RequestReviewError(
      'Only dev packets can request code review.',
      [
        `Packet '${packetId}' has kind '${String(packet['kind'])}'.`,
        'QA packets do not go through code review.',
      ],
    );
  }

  const status = typeof packet['status'] === 'string' ? packet['status'] : null;
  const currentIteration = typeof packet['review_iteration'] === 'number' ? packet['review_iteration'] : 0;
  const currentBranch = typeof packet['branch'] === 'string' ? packet['branch'] : null;

  // Idempotency: already in review_requested → no-op success.
  // Detection happens BEFORE any state change. We do not touch the packet file.
  if (status === 'review_requested') {
    return {
      kind: 'already_requested',
      packet_id: packetId,
      branch: currentBranch,
      review_iteration: currentIteration,
    };
  }

  const validStatuses = ['implementing', 'changes_requested'];
  if (!validStatuses.includes(status as string)) {
    const details: string[] = [
      `Only packets in 'implementing' or 'changes_requested' status can request review.`,
    ];
    if (status === 'review_approved') {
      details.push('This packet is already approved. Run complete.ts to finalize.');
    }
    throw new RequestReviewError(
      `Packet '${packetId}' has status '${String(status)}'.`,
      details,
    );
  }

  if (typeof packet['started_at'] !== 'string' || packet['started_at'].length === 0) {
    throw new RequestReviewError(
      `Packet '${packetId}' has not been started.`,
      [`Run: npx tsx tools/start.ts ${packetId}`],
    );
  }

  // Resolve branch
  let branch: string;
  if (options.branchOverride !== undefined && options.branchOverride.length > 0) {
    branch = options.branchOverride;
  } else {
    try {
      branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: projectRoot,
        encoding: 'utf-8',
        timeout: 10_000,
      }).trim();
    } catch {
      throw new RequestReviewError(
        'Could not determine current git branch.',
        ['Use --branch <branch-name> to specify manually.'],
      );
    }
  }

  if (branch === 'HEAD') {
    throw new RequestReviewError(
      'Detached HEAD state. Cannot determine branch name.',
      ['Use --branch <branch-name> to specify manually.'],
    );
  }

  const wasChangesRequested = status === 'changes_requested';

  packet['status'] = 'review_requested';
  packet['branch'] = branch;
  if (wasChangesRequested) {
    packet['review_iteration'] = currentIteration + 1;
  } else if (packet['review_iteration'] === undefined) {
    packet['review_iteration'] = 0;
  }

  writeFileSync(packetPath, JSON.stringify(packet, null, 2) + '\n', 'utf-8');

  const newIteration = typeof packet['review_iteration'] === 'number' ? packet['review_iteration'] : 0;

  return {
    kind: 'recorded',
    packet_id: packetId,
    branch,
    review_iteration: newIteration,
    was_changes_requested: wasChangesRequested,
  };
}

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
