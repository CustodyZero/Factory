/**
 * Factory — Lifecycle / Git Check
 *
 * Shared stale-branch detection helper for the request-review and
 * complete lifecycle boundaries. Phase 6 surface: introduced to make
 * `StaleBranch` reachable from real lifecycle flow rather than only
 * from synthetic test fixtures.
 *
 * Per docs/decisions/single_entry_pipeline.md (Recovery scope table):
 *
 *   StaleBranch | Detected branch is behind main at request-review or
 *               complete | git fetch && git rebase origin/main; ...
 *
 * The check runs at the natural boundaries (`requestReview` /
 * `completePacket`) so a real "branch behind main" condition surfaces
 * as a structured failure that the recovery layer classifies as
 * `StaleBranch` and dispatches to the rebase recipe.
 *
 * DESIGN NOTES
 *
 * - The check is BEST-EFFORT. Network failure (offline, no remote, no
 *   `origin/main` ref) is silently skipped — this is an environmental
 *   condition, not a packet-level failure. Returning `null` from the
 *   helper means "no stale-branch condition detected", regardless of
 *   whether the check itself was able to run.
 *
 * - The git runner is INJECTABLE so tests drive realistic stderr
 *   fixtures without shelling out. Default uses `spawnSync('git', ...)`
 *   in the project root.
 *
 * - The thrown-error message is constructed to MATCH the patterns in
 *   `pipeline/recovery.ts:STALE_BRANCH_PATTERNS`. The `branch is behind
 *   'origin/main'` substring is the load-bearing one — changing it
 *   without updating the classifier patterns silently breaks recovery.
 *   A cross-layer drift test pins the alignment.
 *
 * - The helper is a one-shot decision: detect-or-skip. It does NOT
 *   attempt to remediate (rebase). Remediation lives in
 *   `pipeline/recovery_loop.ts:runGitRebase`, invoked by the recovery
 *   layer when a `StaleBranch` retry is dispatched.
 */

import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of one git invocation. Mirrors the shape used by
 * `pipeline/recovery_loop.ts:GitRunResult` so a single runner instance
 * can be threaded through both layers.
 */
export interface GitCheckRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runner contract: receives argv (without the leading `git`) and an
 * optional working directory, returns the captured exit code + stdio.
 *
 * The cwd argument is optional so a single runner instance can be
 * threaded through both the lifecycle layer (which always passes
 * `projectRoot`) and the recovery layer (which uses `process.cwd()`
 * when invoked without an explicit cwd). Structurally compatible
 * with `pipeline/recovery_loop.ts:GitRunner` for the same reason.
 */
export type GitCheckRunner = (
  args: ReadonlyArray<string>,
  cwd?: string,
) => GitCheckRunResult;

/**
 * Outcome shape. `null` means "no stale-branch condition was detected"
 * (either the branch is current, or the check could not run). A
 * non-null result carries an error message that the lifecycle script
 * surfaces by throwing — the message text matches the recovery
 * classifier's STALE_BRANCH_PATTERNS so the failure is routed to the
 * `StaleBranch` recipe.
 */
export interface StaleBranchDetected {
  readonly behindCount: number;
  readonly stderr: string;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Run a stale-branch check against `origin/main`.
 *
 * Steps:
 *   1. `git fetch origin main` (best-effort; network failure -> null).
 *   2. `git rev-list --count HEAD..origin/main` to count commits the
 *      branch is BEHIND. Non-zero count means stale.
 *
 * On detection, returns `{ behindCount, stderr }` where `stderr`
 * contains the canonical message
 *   "Your branch is behind 'origin/main' by N commits, ..."
 * which matches `STALE_BRANCH_PATTERNS` in
 * `tools/pipeline/recovery.ts`.
 *
 * The function NEVER throws. Lifecycle callers translate a non-null
 * return into a thrown error so the calling phase's
 * `runWithRecovery` wrapper sees it, classifies it as StaleBranch,
 * and dispatches to the rebase recipe.
 */
export function checkBranchUpToDate(
  cwd: string,
  runner?: GitCheckRunner,
): StaleBranchDetected | null {
  const run = runner ?? defaultGitRunner;

  // Step 1: fetch. Best-effort; if this fails (offline, no remote)
  // we silently skip the staleness check.
  const fetchResult = run(['fetch', 'origin', 'main'], cwd);
  if (fetchResult.exitCode !== 0) {
    return null;
  }

  // Step 2: count commits HEAD is behind origin/main.
  const countResult = run(['rev-list', '--count', 'HEAD..origin/main'], cwd);
  if (countResult.exitCode !== 0) {
    // Could not compare (no origin/main, detached HEAD, etc.). Skip.
    return null;
  }
  const behindCount = parseInt(countResult.stdout.trim(), 10);
  if (!Number.isFinite(behindCount) || behindCount <= 0) {
    return null;
  }

  // Construct stderr text that matches STALE_BRANCH_PATTERNS in
  // pipeline/recovery.ts. The "branch is behind 'origin/main'"
  // substring is the load-bearing match.
  const stderr =
    `Your branch is behind 'origin/main' by ${behindCount} commit(s), ` +
    `and can be fast-forwarded.\n` +
    `(non-fast-forward — updates were rejected because the remote contains work that ` +
    `you do not have locally; the branch is behind.)`;

  return { behindCount, stderr };
}

// ---------------------------------------------------------------------------
// Default runner
// ---------------------------------------------------------------------------

/**
 * Default git runner: spawnSync('git', args, { cwd }) with stdio
 * piped so we can capture stderr. Does not throw; surfaces non-zero
 * exits via the result shape.
 *
 * Lives at the lifecycle boundary (this file) because lifecycle
 * scripts should not reach into pipeline modules. Tests inject a
 * custom runner and never call this code path.
 */
function defaultGitRunner(
  args: ReadonlyArray<string>,
  cwd?: string,
): GitCheckRunResult {
  const result = spawnSync('git', [...args], {
    cwd: cwd ?? process.cwd(),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// ---------------------------------------------------------------------------
// Re-exported pattern check
//
// Lifecycle callers that catch a thrown error from a downstream call
// (e.g. completePacket throws an Error whose .message contains the
// stale-branch markers) can use this predicate to decide whether to
// surface the failure as `kind: 'git'` for the recovery classifier.
// ---------------------------------------------------------------------------

/**
 * Subset of the classifier's STALE_BRANCH_PATTERNS that lifecycle
 * callers use to detect a stale-branch error in a thrown message.
 *
 * Duplicated here (rather than imported from pipeline/recovery.ts)
 * to keep the lifecycle layer free of upward imports. A test pins
 * that any pattern matched by this list is also matched by the
 * classifier, so they can never drift.
 */
export const STALE_BRANCH_LIFECYCLE_PATTERNS: ReadonlyArray<RegExp> = [
  /\byour branch is behind\b/i,
  /\bnon[- ]fast[- ]forward\b/i,
  /\b(updates were|hint:.+) rejected because.+behind\b/i,
  /\bbranch is behind ['"]?origin\/main['"]?\b/i,
  /\bfailed to push some refs\b/i,
];

/**
 * Returns true if the given text contains any stale-branch marker.
 * The patterns mirror `STALE_BRANCH_PATTERNS` in
 * `tools/pipeline/recovery.ts`. Kept in sync by tests.
 */
export function looksLikeStaleBranchMessage(text: string): boolean {
  if (text.length === 0) return false;
  return STALE_BRANCH_LIFECYCLE_PATTERNS.some((p) => p.test(text));
}
