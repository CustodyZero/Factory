/**
 * Factory — Lifecycle / Request Review
 *
 * Library function for transitioning a dev packet to review_requested.
 * The CLI wrapper at tools/request-review.ts re-exports from here.
 *
 * SCOPE FOR PHASE 3
 *
 * Phase 2 already extracted `requestReview()` and `RequestReviewError` as
 * exports of tools/request-review.ts. Phase 3 moves them into this
 * dedicated module so run.ts can import them by responsibility (lifecycle)
 * rather than by historical filename. The CLI wrapper continues to
 * re-export for backward compatibility — any pre-Phase-3 caller that
 * imported from `tools/request-review.js` keeps working unchanged.
 *
 * I/O: this file reads/writes packet JSON and shells out to git
 * (`git rev-parse --abbrev-ref HEAD`) when the caller did not specify a
 * branch override. Both are unavoidable for "transition a packet to
 * review_requested". What this file does NOT do is shell out to other
 * lifecycle scripts — that distinction is what Phase 3 is about.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { loadConfig, findProjectRoot, resolveArtifactRoot } from '../config.js';
import type { FactoryConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RequestReviewOptions {
  readonly packetId: string;
  readonly branchOverride?: string;
  readonly projectRoot?: string;
  readonly config?: FactoryConfig;
}

/**
 * Discriminated outcome. The CLI uses the discriminator to render
 * "review already requested" vs the standard success path; library
 * callers can pattern-match on it.
 */
export type RequestReviewOutcome =
  | {
      readonly kind: 'recorded';
      readonly packet_id: string;
      readonly branch: string;
      readonly review_iteration: number;
      readonly was_changes_requested: boolean;
      readonly already_requested: false;
    }
  | {
      readonly kind: 'already_requested';
      readonly packet_id: string;
      readonly branch: string | null;
      readonly review_iteration: number;
      readonly already_requested: true;
    };

/**
 * Result alias matching the StartPacketResult / CompleteResult shape.
 * Library callers that just want a flat record can read fields directly;
 * callers that want the discriminator can use RequestReviewOutcome.
 *
 * (Both shapes describe the same value — `kind` and `already_requested`
 * are kept in sync.)
 */
export type RequestReviewResult = RequestReviewOutcome;

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

// ---------------------------------------------------------------------------
// Library entry
// ---------------------------------------------------------------------------

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
      already_requested: true,
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
    already_requested: false,
  };
}
