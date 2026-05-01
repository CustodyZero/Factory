/**
 * Factory — Pipeline / Lifecycle Loop Helpers
 *
 * Two small helpers shared by the develop and verify phase loops.
 *
 * Both phases reach for the same pattern:
 *
 *   1. They build a `completionIds` set once at phase start by
 *      scanning <artifactRoot>/completions/.
 *   2. They iterate over packets. During the loop, an external
 *      agent may invoke complete.ts directly on a previous packet,
 *      writing a new completion file that the phase-start scan
 *      did not see. `refreshCompletionId` reconciles the in-memory
 *      set with disk for one packet at a time before each
 *      already-complete check.
 *
 *   3. They call lifecycle library functions (startPacket,
 *      requestReview, recordReview, completePacket) which throw on
 *      precondition failures. The phase loops translate that
 *      throws-on-error shape into a "log + advance" shape.
 *      `safeCall` wraps a callable and returns `{ ok, error }`
 *      without re-throwing.
 *
 * Both helpers are pulled out of tools/run.ts in Phase 4.5 so the
 * extracted phase modules don't have to import upward into the
 * orchestrator (a layering violation) or duplicate the logic
 * (a maintenance hazard).
 *
 * Behavior is byte-identical to the originals — these are
 * pure relocations.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// refreshCompletionId
// ---------------------------------------------------------------------------

/**
 * Per-iteration staleness refresh for the in-memory `completionIds` set.
 *
 * Both phase loops build `completionIds` once at phase start. During the
 * loop, an external agent may invoke `complete.ts` directly on a previous
 * packet (the same external-mutation model that justifies the per-iteration
 * packet re-reads in devPhase / qaPhase). Without this refresh, the next
 * iteration's resume-point derivation or already-complete check would use
 * a stale view of disk and reprocess an already-complete packet.
 *
 * Contract:
 *   - If `set` already contains `packetId`, no I/O, no mutation.
 *   - Else, if `<artifactRoot>/completions/<packetId>.json` exists on
 *     disk, add `packetId` to `set`.
 *   - Else, leave `set` unchanged.
 *   - Never throws (existsSync does not throw on missing parents).
 */
export function refreshCompletionId(
  set: Set<string>,
  packetId: string,
  artifactRoot: string,
): void {
  if (set.has(packetId)) return;
  if (existsSync(join(artifactRoot, 'completions', `${packetId}.json`))) {
    set.add(packetId);
  }
}

// ---------------------------------------------------------------------------
// safeCall
// ---------------------------------------------------------------------------

export interface SafeCallResult {
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * Adapter around a throwing callable: returns `{ ok: true }` on
 * success and `{ ok: false, error }` on a thrown error. Never
 * re-throws.
 *
 * The factory's lifecycle library functions (Phase 3) signal
 * precondition failures by throwing. The phase loops in run.ts
 * (now in pipeline/plan_phase.ts, develop_phase.ts, verify_phase.ts)
 * want a linear "log + advance" shape, not a catch-and-rethrow at
 * each call site. This helper converts the shape once.
 */
export function safeCall(fn: () => unknown): SafeCallResult {
  try {
    fn();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
