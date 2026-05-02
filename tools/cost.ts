/**
 * Factory — Cost I/O wrapper
 *
 * The filesystem-touching half of the Phase 5.7 cost-visibility
 * backbone. Pairs with `tools/pipeline/cost.ts` (pure logic) — see
 * that file for the rate-card model, computeCost, extractTokens,
 * aggregateDollars, and checkCap.
 *
 * Why split: the same pattern as `tools/events.ts` ↔
 * `tools/pipeline/events.ts`. Pure cost computation stays
 * import-clean for any caller (orchestrator, phase modules, future
 * recovery layer); the I/O wrapper keeps Node fs imports isolated to
 * the boundary.
 *
 * INVARIANTS
 *
 *   - Append-only writes for per-run cost rows. No mid-run rewrites.
 *   - Best-effort emission: a failed write must NOT crash the
 *     pipeline. Cost is observability-class; losing one row is
 *     preferable to taking down a real run.
 *   - One JSONL file per pipeline invocation, named by run_id at
 *     `<artifactRoot>/cost/<run_id>.jsonl`.
 *   - Defensive read: a truncated final line (a process killed mid-
 *     write) must not throw on read; tolerant parsing skips bad
 *     lines and returns the rows that did parse cleanly.
 *   - `recordDayCapBlock` / `isDayCapBlocked` use LOCAL date
 *     (`YYYY-MM-DD` in the operator's wall clock), NOT UTC. The
 *     operator's working day is what matters for budget caps; UTC
 *     midnight cuts mid-day in many timezones. Documented here so
 *     future contributors do not silently switch to UTC.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { CostRecord } from './pipeline/cost.js';
import {
  aggregateDollars,
  localDateFromTimestamp,
  utcDateWindow,
} from './pipeline/cost.js';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the directory and file path that hold the JSONL cost stream
 * for a given run id under a given artifact root. Mirrors
 * `eventsPathFor` in `tools/events.ts`.
 *
 * Exported for tests that want to assert on the on-disk location.
 */
export function costPathFor(artifactRoot: string, runId: string): {
  readonly dir: string;
  readonly file: string;
} {
  const dir = join(artifactRoot, 'cost');
  const file = join(dir, `${runId}.jsonl`);
  return { dir, file };
}

function dayBlocksPath(artifactRoot: string): string {
  return join(artifactRoot, 'cost', '.day-blocks.json');
}

// ---------------------------------------------------------------------------
// recordCost — append one cost row
// ---------------------------------------------------------------------------

/**
 * Append one cost record as a single JSONL line to the run's stream
 * file at `<artifactRoot>/cost/<run_id>.jsonl`.
 *
 * Best-effort: any error is swallowed (see file header). Creates the
 * `<artifactRoot>/cost/` directory on first call.
 */
export function recordCost(record: CostRecord, artifactRoot: string): void {
  try {
    const { dir, file } = costPathFor(artifactRoot, record.run_id);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const line = JSON.stringify(record) + '\n';
    appendFileSync(file, line, 'utf-8');
  } catch {
    // Swallowed: see file header.
  }
}

// ---------------------------------------------------------------------------
// readCostRecords — defensive read
// ---------------------------------------------------------------------------

/**
 * Read all cost records for a run id back from disk in order.
 *
 * Defensive: a truncated final line (e.g. a process killed mid-write)
 * is skipped without throwing. Any line that fails JSON.parse is
 * dropped silently and the remaining records are returned. We choose
 * lenient reads over strict ones for the same reason the events I/O
 * does — losing the corrupt tail must not deny access to records that
 * did land cleanly.
 *
 * Returns an empty array if the file does not exist.
 */
export function readCostRecords(runId: string, artifactRoot: string): CostRecord[] {
  const { file } = costPathFor(artifactRoot, runId);
  if (!existsSync(file)) return [];
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const lines = raw.split('\n');
  const out: CostRecord[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line) as CostRecord);
    } catch {
      // Skip malformed (truncated final write, partial flush).
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// aggregateRunCost — sum the run's records
// ---------------------------------------------------------------------------

/**
 * Read the per-run cost JSONL and produce a summary `{ total,
 * unknown_count, count }`. Wraps `readCostRecords` and the pure
 * `aggregateDollars`. `count` is the total number of records (not
 * just the known-dollar ones) so callers can show "completed; total
 * cost: $X.YZ over N invocations".
 */
export function aggregateRunCost(
  runId: string,
  artifactRoot: string,
): { total: number; unknown_count: number; count: number } {
  const records = readCostRecords(runId, artifactRoot);
  const { total, unknown_count } = aggregateDollars(records);
  return { total, unknown_count, count: records.length };
}

// ---------------------------------------------------------------------------
// readDayCost — sum across every run-file for a given local date
// ---------------------------------------------------------------------------

/**
 * Sum cost across every CostRecord whose `timestamp` falls on the
 * given local YYYY-MM-DD date.
 *
 * Round-2 fix (Issue 2): the previous implementation filtered by
 * filename prefix (`f.startsWith(`${date}T`)`). Run-id filenames use
 * UTC timestamps (newRunId), but the day-cap is local-date scoped —
 * so a 23:00 Phoenix run (UTC-7) gets a filename prefixed with the
 * NEXT UTC day, and `readDayCost('today', ...)` excluded it. The day
 * cap silently underreported in any timezone west of UTC.
 *
 * Correct behaviour: classify records by their `timestamp` field
 * (UTC ISO-8601 stored on each row), converted to local date via the
 * pure `localDateFromTimestamp` helper. To keep the work bounded, we
 * pre-filter candidate filenames to the 3-day UTC window from
 * `utcDateWindow` — a record's local date is at most ±1 UTC day from
 * its run-id's UTC date, so files outside that window cannot contain
 * matching records. This keeps the scan O(few-files) instead of
 * O(all-cost-files).
 */
export function readDayCost(
  date: string,
  artifactRoot: string,
): { total: number; unknown_count: number } {
  const dir = join(artifactRoot, 'cost');
  if (!existsSync(dir)) return { total: 0, unknown_count: 0 };
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { total: 0, unknown_count: 0 };
  }
  // Bounded candidate scan: only filenames whose UTC-date prefix
  // falls in the ±1-day window around `date` can contain records
  // that belong to the local day. This is a pre-filter; the
  // authoritative classification still happens per-record below.
  const utcWindow = utcDateWindow(date);
  const candidates = entries.filter(
    (f) => f.endsWith('.jsonl') && utcWindow.some((d) => d !== '' && f.startsWith(`${d}T`)),
  );
  let total = 0;
  let unknown_count = 0;
  for (const f of candidates) {
    const runId = f.slice(0, f.length - '.jsonl'.length);
    const records = readCostRecords(runId, artifactRoot);
    for (const r of records) {
      // Per-record local-date check: the record's UTC timestamp
      // converted to local date must equal the requested local date.
      // Records that fall on a different local day (e.g. a run that
      // started at 23:30 local and produced records that crossed
      // local midnight) are correctly excluded.
      if (localDateFromTimestamp(r.timestamp) !== date) continue;
      if (r.dollars === null) {
        unknown_count += 1;
      } else {
        total += r.dollars;
      }
    }
  }
  return { total, unknown_count };
}

// ---------------------------------------------------------------------------
// Day-cap blocking
// ---------------------------------------------------------------------------

interface DayBlocksFile {
  readonly blocked: ReadonlyArray<string>;
}

function readDayBlocks(artifactRoot: string): Set<string> {
  const path = dayBlocksPath(artifactRoot);
  if (!existsSync(path)) return new Set<string>();
  try {
    const raw = readFileSync(path, 'utf-8');
    const data = JSON.parse(raw) as Partial<DayBlocksFile>;
    if (!Array.isArray(data.blocked)) return new Set<string>();
    return new Set<string>(data.blocked.filter((d): d is string => typeof d === 'string'));
  } catch {
    return new Set<string>();
  }
}

/**
 * Record that the given local date hit its per-day cap. Subsequent
 * runs on the same date are rejected at orchestrator entry by
 * `isDayCapBlocked`.
 *
 * Idempotent: re-recording the same date is a no-op. Best-effort:
 * any I/O error is swallowed, which means a failed write degrades
 * gracefully (subsequent runs won't be blocked). Documenting that
 * tradeoff: blocking is a guardrail, not a security boundary.
 */
export function recordDayCapBlock(date: string, artifactRoot: string): void {
  try {
    const dir = join(artifactRoot, 'cost');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const blocked = readDayBlocks(artifactRoot);
    blocked.add(date);
    const out: DayBlocksFile = { blocked: [...blocked].sort() };
    writeFileSync(dayBlocksPath(artifactRoot), JSON.stringify(out, null, 2) + '\n', 'utf-8');
  } catch {
    // Swallowed: see file header.
  }
}

/**
 * Return true if the given local date is recorded as cap-blocked.
 * Reads `<artifactRoot>/cost/.day-blocks.json`; returns false if the
 * file does not exist or is unreadable.
 */
export function isDayCapBlocked(date: string, artifactRoot: string): boolean {
  return readDayBlocks(artifactRoot).has(date);
}

// ---------------------------------------------------------------------------
// localDateString — helper for callers
// ---------------------------------------------------------------------------

/**
 * Format a Date into `YYYY-MM-DD` in LOCAL time. This is the key
 * format used by the day-cap helpers above.
 *
 * Exported so the orchestrator and tests share one canonical
 * implementation. Defaults to "now" when no clock is supplied.
 */
export function localDateString(clock: () => Date = () => new Date()): string {
  const d = clock();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
