/**
 * Factory — Events I/O wrapper
 *
 * The filesystem-touching half of the Phase 5.5 events backbone. Pairs
 * with `tools/pipeline/events.ts` (pure logic) — see that file for the
 * event-type taxonomy and constructor helpers.
 *
 * Why split: the same pattern as `tools/pipeline/integrity.ts` (pure)
 * vs `tools/validate.ts` (CLI/I/O). Pure event construction stays
 * import-clean for any caller (orchestrator, lifecycle scripts,
 * future recovery layer); the I/O wrapper keeps Node fs imports
 * isolated to the boundary.
 *
 * INVARIANTS
 *
 *   - Append-only writes. No mid-run rewrites or compaction.
 *   - Best-effort emission: a failed write must NOT crash the
 *     pipeline. We swallow errors deliberately because the events
 *     stream is observability, not state. Losing a single event
 *     line is preferable to taking down a real pipeline run.
 *   - One JSONL file per pipeline invocation, named by run_id at
 *     `<artifactRoot>/events/<run_id>.jsonl`.
 *   - Defensive read: a truncated final line (a process killed mid-
 *     write) must not throw on read; tolerant parsing skips bad
 *     lines and returns the events that did parse cleanly.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Event } from './pipeline/events.js';

// Re-export newRunId from the pure module so callers can take a single
// dependency on `tools/events.ts` without also importing the pure side.
export { newRunId } from './pipeline/events.js';

/**
 * Resolve the directory and file path that hold the JSONL stream for
 * a given run id under a given artifact root.
 *
 * Exported for tests that want to assert on the on-disk location.
 */
export function eventsPathFor(artifactRoot: string, runId: string): {
  readonly dir: string;
  readonly file: string;
} {
  const dir = join(artifactRoot, 'events');
  const file = join(dir, `${runId}.jsonl`);
  return { dir, file };
}

/**
 * Append one event as a single JSONL line to the run's stream file.
 *
 * Best-effort: any error (missing parent dir, locked file, bad
 * permissions, disk full) is swallowed. The events stream is
 * observability — losing a single line never blocks the run.
 *
 * Creates the `<artifactRoot>/events/` directory on first call.
 * The line separator is `\n`. The line itself is the JSON.stringify
 * of the event with NO embedded newlines (consumers split on `\n`).
 */
export function appendEvent(event: Event, artifactRoot: string): void {
  try {
    const { dir, file } = eventsPathFor(artifactRoot, event.run_id);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // JSON.stringify with no replacer never emits embedded newlines for
    // any of our payload shapes (no string fields contain raw newlines
    // by construction). One stringify -> one line.
    const line = JSON.stringify(event) + '\n';
    appendFileSync(file, line, 'utf-8');
  } catch {
    // Swallowed by design: see the file header. If you find yourself
    // wanting to log here, the right answer is a separate diagnostic
    // path, not a thrown error from the events emitter.
  }
}

/**
 * Read all events for a run id back from disk in order.
 *
 * Defensive: a truncated final line (e.g. a process killed mid-write)
 * is skipped without throwing. Any line that fails JSON.parse is
 * dropped silently and the remaining events are returned. We choose
 * lenient reads over strict ones because the events stream is
 * observability — a corrupt tail must not deny access to the events
 * that did land cleanly.
 *
 * Returns an empty array if the file does not exist.
 */
export function readEvents(runId: string, artifactRoot: string): Event[] {
  const { file } = eventsPathFor(artifactRoot, runId);
  if (!existsSync(file)) return [];
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  // Splitting on '\n' yields a trailing '' for files ending with '\n';
  // we filter those out below. A truncated last line (no trailing
  // newline) shows up as a partial fragment which JSON.parse rejects
  // — that's where the defensive skip kicks in.
  const lines = raw.split('\n');
  const out: Event[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line) as Event);
    } catch {
      // Skip malformed lines (truncated final write, partial flush).
    }
  }
  return out;
}
