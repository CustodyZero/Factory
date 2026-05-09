/**
 * Factory — Recovery I/O wrapper
 *
 * The filesystem-touching half of the Phase 6 recovery layer. Pairs
 * with `tools/pipeline/recovery.ts` (pure logic) — see that file for
 * the FailureScenario enum, classifier, recipes, and EscalationRecord
 * shape.
 *
 * Why split: same pattern as `tools/events.ts` <-> `tools/pipeline/events.ts`
 * and `tools/cost.ts` <-> `tools/pipeline/cost.ts`. The pure recovery
 * module stays import-clean for any caller; this wrapper keeps Node
 * fs imports at the boundary.
 *
 * INVARIANTS
 *
 *   - One JSON file per escalation, never appended.
 *   - Filename: `<artifactRoot>/escalations/<spec-id>-<timestamp>.json`.
 *     `<spec-id>` is `_unknown` when the escalation has no spec
 *     context. The timestamp is ISO-8601 with `:` -> `-` to keep the
 *     filename filesystem-safe.
 *   - Best-effort emission: a failed write must NOT crash the
 *     pipeline. Recovery is a guardrail; losing one escalation file
 *     is preferable to taking down a real run. Mirrors `appendEvent`.
 *   - Creates the `<artifactRoot>/escalations/` directory on first
 *     call.
 *
 * The on-disk JSON shape is whatever `EscalationRecord` says it is
 * (defined in pipeline/recovery.ts). This wrapper does not interpret
 * the record — it just serializes and writes.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EscalationRecord } from './pipeline/recovery.js';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the directory and filename for an escalation under the
 * given artifact root. Exported for tests that want to assert on
 * the on-disk location.
 *
 * Filename format: `<spec-id>-<timestamp>.json`. `_unknown` when
 * `specId` is null. The timestamp is filesystem-safe (no colons).
 */
export function escalationPathFor(
  artifactRoot: string,
  specId: string | null,
  timestamp: string,
): { readonly dir: string; readonly file: string } {
  const dir = join(artifactRoot, 'escalations');
  const safeSpec = specId ?? '_unknown';
  // Replace ':' with '-' so the filename is portable across
  // Windows / macOS / Linux. Mirror newRunId's transform.
  const safeStamp = timestamp.replace(/:/g, '-');
  const file = join(dir, `${safeSpec}-${safeStamp}.json`);
  return { dir, file };
}

// ---------------------------------------------------------------------------
// writeEscalation — write one escalation record
// ---------------------------------------------------------------------------

/**
 * Write one escalation record as a JSON file under
 * `<artifactRoot>/escalations/`. Best-effort: any error is swallowed
 * (see file header).
 *
 * Returns the on-disk path on success, or `null` when the write
 * failed. Callers that need to report the path to operators should
 * branch on the return value; callers that only care about the
 * "we tried to escalate" signal can ignore it.
 */
export function writeEscalation(
  record: EscalationRecord,
  artifactRoot: string,
): string | null {
  try {
    const { dir, file } = escalationPathFor(
      artifactRoot,
      record.spec_id,
      record.timestamp,
    );
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // Pretty-print with 2-space indent so the file is human-readable
    // when an operator opens it in an editor. Trailing newline for
    // POSIX hygiene.
    writeFileSync(file, JSON.stringify(record, null, 2) + '\n', 'utf-8');
    return file;
  } catch {
    // Swallowed by design: see the file header. Recovery is a
    // guardrail, not a transaction layer; a write failure here
    // must not turn a recoverable run failure into a crash.
    return null;
  }
}

// ---------------------------------------------------------------------------
// readEscalation — defensive read (for tests and validation)
// ---------------------------------------------------------------------------

/**
 * Read an escalation record from a path. Returns null if the file
 * does not exist or fails to parse. Defensive (never throws) per the
 * same rationale as the writer: recovery files are observability,
 * not state.
 */
export function readEscalation(path: string): EscalationRecord | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as EscalationRecord;
  } catch {
    return null;
  }
}
