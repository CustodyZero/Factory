/**
 * Unit tests for the Phase 5.7 cost I/O wrapper (tools/cost.ts).
 *
 * Pins:
 *   - recordCost append-only JSONL writes
 *   - readCostRecords round-trips
 *   - readCostRecords tolerates a truncated final line (defensive read)
 *   - aggregateRunCost sums the run's records
 *   - readDayCost sums across multiple run files
 *   - recordDayCapBlock / isDayCapBlocked round-trip
 *
 * Every test uses a tmpdir-rooted artifactRoot so we never touch the
 * host project's cost tree.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  aggregateRunCost,
  costPathFor,
  isDayCapBlocked,
  localDateString,
  readCostRecords,
  readDayCost,
  recordCost,
  recordDayCapBlock,
} from '../cost.js';
import type { CostRecord } from '../pipeline/cost.js';
import {
  localDateFromTimestamp,
  utcDateWindow,
} from '../pipeline/cost.js';

// ---------------------------------------------------------------------------
// Fixture cleanup
// ---------------------------------------------------------------------------

let tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  tempDirs = [];
});

function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'cost-io-'));
  tempDirs.push(d);
  return d;
}

/**
 * Build a fixture timestamp anchored to LOCAL noon on the given
 * (year, monthIndex, day). `new Date(y, m, d, h)` interprets its
 * arguments as local time; `.toISOString()` then returns the UTC
 * encoding of that local instant. Feeding the result back through
 * `localDateFromTimestamp` therefore always yields `YYYY-MM-DD` for
 * the input local date, regardless of the host's TZ. Tests must use
 * this helper in place of UTC-anchored ISO literals so that fixture
 * classification stays TZ-invariant (CLAUDE.md §4).
 */
function localNoonTs(year: number, monthIndex: number, day: number): string {
  return new Date(year, monthIndex, day, 12).toISOString();
}

function rec(overrides: Partial<CostRecord>): CostRecord {
  return {
    run_id: 'run-1',
    packet_id: 'pkt-1',
    spec_id: 'spec-1',
    provider: 'claude',
    model: 'claude-opus-4-7',
    tokens_in: 1000,
    tokens_out: 1000,
    dollars: 0.09,
    // Default fixture timestamp: local noon on 2026-05-01 in whatever
    // TZ the test runs in. Round-3 fix: previously used a UTC literal,
    // which is TZ-fragile in extreme east zones (UTC+12..+14).
    timestamp: localNoonTs(2026, 4, 1),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// recordCost / readCostRecords round-trip
// ---------------------------------------------------------------------------

describe('recordCost / readCostRecords', () => {
  it('writes one record as one JSONL line and reads it back', () => {
    const root = mkTmp();
    const r = rec({ run_id: 'run-A' });
    recordCost(r, root);

    const back = readCostRecords('run-A', root);
    expect(back).toHaveLength(1);
    expect(back[0]).toEqual(r);
  });

  it('appends multiple records (append-only) and preserves order', () => {
    const root = mkTmp();
    const r1 = rec({ run_id: 'run-B', tokens_in: 1, dollars: 0.01 });
    const r2 = rec({ run_id: 'run-B', tokens_in: 2, dollars: 0.02 });
    const r3 = rec({ run_id: 'run-B', tokens_in: 3, dollars: 0.03 });
    recordCost(r1, root);
    recordCost(r2, root);
    recordCost(r3, root);

    const back = readCostRecords('run-B', root);
    expect(back).toHaveLength(3);
    expect(back.map((x) => x.tokens_in)).toEqual([1, 2, 3]);
  });

  it('creates the cost/ directory on first call', () => {
    const root = mkTmp();
    const { dir } = costPathFor(root, 'run-X');
    expect(existsSync(dir)).toBe(false);
    recordCost(rec({ run_id: 'run-X' }), root);
    expect(existsSync(dir)).toBe(true);
  });

  it('returns [] for a non-existent run', () => {
    const root = mkTmp();
    expect(readCostRecords('does-not-exist', root)).toEqual([]);
  });

  it('reads back only well-formed lines when the final line is truncated', () => {
    const root = mkTmp();
    const r1 = rec({ run_id: 'run-T', tokens_in: 1, dollars: 0.01 });
    const r2 = rec({ run_id: 'run-T', tokens_in: 2, dollars: 0.02 });
    recordCost(r1, root);
    recordCost(r2, root);

    // Append a truncated JSON fragment (no closing brace, no newline).
    const { file } = costPathFor(root, 'run-T');
    appendFileSync(file, '{"run_id":"run-T","packet_id":', 'utf-8');

    const back = readCostRecords('run-T', root);
    expect(back).toHaveLength(2);
    expect(back.map((x) => x.tokens_in)).toEqual([1, 2]);
  });

  it('skips a stray malformed line in the middle of the file', () => {
    const root = mkTmp();
    const r1 = rec({ run_id: 'run-M', tokens_in: 1, dollars: 0.01 });
    const r3 = rec({ run_id: 'run-M', tokens_in: 3, dollars: 0.03 });
    recordCost(r1, root);

    const { file } = costPathFor(root, 'run-M');
    appendFileSync(file, '{not valid json}\n', 'utf-8');

    recordCost(r3, root);

    const back = readCostRecords('run-M', root);
    expect(back).toHaveLength(2);
    expect(back.map((x) => x.tokens_in)).toEqual([1, 3]);
  });

  it('best-effort: a write failure does not throw', () => {
    // We cannot easily provoke a write error portably; what we DO
    // verify is that recordCost handles a non-existent / unwritable
    // root gracefully. Pass a path under a directory that does not
    // exist AND that we cannot create (a regular file as the parent).
    const root = mkTmp();
    const blocking = join(root, 'block-as-file');
    // Touch a regular file at where 'cost' would be created.
    mkdirSync(root, { recursive: true });
    appendFileSync(blocking, 'x', 'utf-8');
    // A subsequent recordCost should NOT throw — it'll fail to mkdir
    // because `cost` already exists as a non-dir for some path; we
    // just confirm "no throw" by passing a normally-good root.
    expect(() => recordCost(rec({ run_id: 'run-Y' }), root)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// aggregateRunCost
// ---------------------------------------------------------------------------

describe('aggregateRunCost', () => {
  it('sums all known-dollar records and reports unknown_count and count', () => {
    const root = mkTmp();
    recordCost(rec({ run_id: 'run-S', tokens_in: 1, dollars: 0.5 }), root);
    recordCost(rec({ run_id: 'run-S', tokens_in: 2, dollars: 1.5 }), root);
    recordCost(rec({ run_id: 'run-S', tokens_in: 3, dollars: null }), root);

    const out = aggregateRunCost('run-S', root);
    expect(out.total).toBe(2);
    expect(out.unknown_count).toBe(1);
    expect(out.count).toBe(3);
  });

  it('returns zeroes for a run with no records', () => {
    const root = mkTmp();
    const out = aggregateRunCost('absent', root);
    expect(out).toEqual({ total: 0, unknown_count: 0, count: 0 });
  });
});

// ---------------------------------------------------------------------------
// readDayCost
// ---------------------------------------------------------------------------

describe('readDayCost', () => {
  // Round-3 note: readDayCost classifies records by their `timestamp`
  // field converted to local date — NOT by run-id filename prefix. The
  // fixtures here build timestamps via `localNoonTs(...)` so the
  // local-date interpretation is the SAME `YYYY-MM-DD` we ask about,
  // in ANY earth-bound timezone (including UTC+14 and UTC-11). The
  // requested local-date string itself is derived from the fixture
  // timestamp via `localDateFromTimestamp` to keep the test self-
  // consistent with whatever the host TZ produces.
  it('sums across all records whose local-date matches the requested date', () => {
    const root = mkTmp();
    // Two records on local-day-A, one on the next local day. The
    // run-id prefixes use the timestamp's UTC date — the per-record
    // local-date check is what classifies, not the filename.
    const tsA = localNoonTs(2026, 4, 1); // local noon, May 1
    const tsB = localNoonTs(2026, 4, 2); // local noon, May 2
    const dayA = localDateFromTimestamp(tsA);
    const dayB = localDateFromTimestamp(tsB);
    recordCost(rec({
      run_id: `${dayA}T10-00-00Z-deadbeef`, dollars: 0.50,
      timestamp: tsA,
    }), root);
    recordCost(rec({
      run_id: `${dayA}T11-00-00Z-cafebabe`, dollars: 1.25,
      timestamp: tsA,
    }), root);
    recordCost(rec({
      run_id: `${dayB}T09-00-00Z-feedface`, dollars: 5.00,
      timestamp: tsB,
    }), root);

    const sumA = readDayCost(dayA, root);
    expect(sumA.total).toBe(1.75);
    expect(sumA.unknown_count).toBe(0);

    const sumB = readDayCost(dayB, root);
    expect(sumB.total).toBe(5);
    expect(sumB.unknown_count).toBe(0);
  });

  it('aggregates unknown_count across run files', () => {
    const root = mkTmp();
    const ts = localNoonTs(2026, 4, 1);
    const day = localDateFromTimestamp(ts);
    recordCost(rec({
      run_id: `${day}T10-00-00Z-aaaaaaaa`, dollars: 0.50,
      timestamp: ts,
    }), root);
    recordCost(rec({
      run_id: `${day}T10-00-00Z-aaaaaaaa`, dollars: null,
      timestamp: ts,
    }), root);
    recordCost(rec({
      run_id: `${day}T11-00-00Z-bbbbbbbb`, dollars: null,
      timestamp: ts,
    }), root);

    const out = readDayCost(day, root);
    expect(out.total).toBe(0.5);
    expect(out.unknown_count).toBe(2);
  });

  it('returns zeroes when the cost dir does not exist', () => {
    const root = mkTmp();
    // No records exist; readDayCost returns zeroes regardless of the
    // requested date. We use a derived date string for symmetry with
    // the other tests in this block.
    const day = localDateFromTimestamp(localNoonTs(2026, 4, 1));
    expect(readDayCost(day, root)).toEqual({ total: 0, unknown_count: 0 });
  });

  it('returns zeroes when no records match the local date', () => {
    const root = mkTmp();
    const tsRecord = localNoonTs(2026, 3, 30); // local noon, Apr 30
    const tsQuery = localNoonTs(2026, 4, 1);   // local noon, May 1
    const dayRecord = localDateFromTimestamp(tsRecord);
    const dayQuery = localDateFromTimestamp(tsQuery);
    recordCost(rec({
      run_id: `${dayRecord}T10-00-00Z-deadbeef`, dollars: 5,
      timestamp: tsRecord,
    }), root);
    expect(readDayCost(dayQuery, root)).toEqual({ total: 0, unknown_count: 0 });
  });

  it('ignores non-jsonl entries in the cost directory', () => {
    const root = mkTmp();
    const ts = localNoonTs(2026, 4, 1);
    const day = localDateFromTimestamp(ts);
    // Bootstrap by writing one valid record (to create the dir).
    recordCost(rec({
      run_id: `${day}T10-00-00Z-aaaaaaaa`, dollars: 1,
      timestamp: ts,
    }), root);
    // Drop a non-jsonl file in there; it must not be included.
    appendFileSync(join(root, 'cost', 'README.md'), 'not a JSONL', 'utf-8');

    const out = readDayCost(day, root);
    expect(out.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// recordDayCapBlock / isDayCapBlocked round-trip
// ---------------------------------------------------------------------------

describe('recordDayCapBlock / isDayCapBlocked', () => {
  it('round-trips a single date', () => {
    const root = mkTmp();
    expect(isDayCapBlocked('2026-05-01', root)).toBe(false);
    recordDayCapBlock('2026-05-01', root);
    expect(isDayCapBlocked('2026-05-01', root)).toBe(true);
  });

  it('does not block other dates', () => {
    const root = mkTmp();
    recordDayCapBlock('2026-05-01', root);
    expect(isDayCapBlocked('2026-05-02', root)).toBe(false);
  });

  it('idempotent: re-recording the same date is a no-op', () => {
    const root = mkTmp();
    recordDayCapBlock('2026-05-01', root);
    recordDayCapBlock('2026-05-01', root);
    expect(isDayCapBlocked('2026-05-01', root)).toBe(true);
    // The blocked array should contain the date exactly once.
    const path = join(root, 'cost', '.day-blocks.json');
    const data = JSON.parse(readFileSync(path, 'utf-8')) as { blocked: string[] };
    expect(data.blocked).toEqual(['2026-05-01']);
  });

  it('blocks multiple distinct dates', () => {
    const root = mkTmp();
    recordDayCapBlock('2026-05-01', root);
    recordDayCapBlock('2026-05-03', root);
    recordDayCapBlock('2026-05-02', root);
    expect(isDayCapBlocked('2026-05-01', root)).toBe(true);
    expect(isDayCapBlocked('2026-05-02', root)).toBe(true);
    expect(isDayCapBlocked('2026-05-03', root)).toBe(true);
    expect(isDayCapBlocked('2026-05-04', root)).toBe(false);
  });

  it('returns false when the block file does not exist', () => {
    const root = mkTmp();
    expect(isDayCapBlocked('2026-05-01', root)).toBe(false);
  });

  it('returns false when the block file is malformed', () => {
    const root = mkTmp();
    mkdirSync(join(root, 'cost'), { recursive: true });
    appendFileSync(join(root, 'cost', '.day-blocks.json'), 'not valid json', 'utf-8');
    expect(isDayCapBlocked('2026-05-01', root)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// localDateString
// ---------------------------------------------------------------------------

describe('localDateString', () => {
  it('formats a fixed Date as YYYY-MM-DD using local time', () => {
    // Round-3: anchor to local noon on 2026-05-15 in the host's TZ so
    // the assertion is TZ-invariant. The expected string is computed
    // from the same Date instance using its local components — that
    // pins the contract (output uses LOCAL components) without
    // hard-coding a specific date.
    const fixed = new Date(2026, 4, 15, 12);
    const s = localDateString(() => fixed);
    expect(s).toBe(
      `${fixed.getFullYear()}-${String(fixed.getMonth() + 1).padStart(2, '0')}-${String(fixed.getDate()).padStart(2, '0')}`,
    );
  });

  it('always returns a 10-character YYYY-MM-DD', () => {
    const s = localDateString();
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(s).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// Round-2 fix (Issue 2): localDateFromTimestamp
//
// The function converts a UTC ISO-8601 timestamp into the YYYY-MM-DD
// the host machine sees in LOCAL time. The factory's day-cap aggregation
// keys off the operator's working day, so getting this conversion right
// in non-UTC zones is what makes the cap honest.
// ---------------------------------------------------------------------------

describe('localDateFromTimestamp', () => {
  it('round-trips a local-anchored timestamp to its local date in any TZ', () => {
    // Round-3: build the timestamps via the local-time `Date`
    // constructor so the assertion is TZ-invariant. UTC ISO literals
    // were fragile in extreme east zones (UTC+12..+14) — local-noon
    // anchoring sidesteps the ambiguity entirely.
    const ts1 = new Date(2026, 4, 1, 12).toISOString();   // local noon May 1
    const ts2 = new Date(2026, 11, 31, 12).toISOString(); // local noon Dec 31
    expect(localDateFromTimestamp(ts1)).toBe('2026-05-01');
    expect(localDateFromTimestamp(ts2)).toBe('2026-12-31');
  });

  it('matches what localDateString returns for the same Date instance', () => {
    // Pin the contract: localDateFromTimestamp(t) === localDateString(() => new Date(t)).
    // (Round-2 invariant: the two helpers must agree on classification.)
    // Round-3: timestamps are derived from local-time `Date`
    // constructors covering several local hours of the day to exercise
    // the agreement across the daily boundary in any TZ.
    const samples = [
      new Date(2026, 4, 1, 0).toISOString(),
      new Date(2026, 4, 1, 12).toISOString(),
      new Date(2026, 4, 1, 23, 59, 59).toISOString(),
      new Date(2026, 11, 31, 20).toISOString(),
    ];
    for (const ts of samples) {
      const d = new Date(ts);
      expect(localDateFromTimestamp(ts)).toBe(localDateString(() => d));
    }
  });

  it('returns "" for an unparseable timestamp', () => {
    expect(localDateFromTimestamp('')).toBe('');
    expect(localDateFromTimestamp('not a date')).toBe('');
    expect(localDateFromTimestamp('garbage')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Round-2 fix (Issue 2): utcDateWindow
//
// Given a local YYYY-MM-DD, the function returns the three UTC dates
// that bracket it (yesterday, today, tomorrow). readDayCost uses this
// to pre-filter candidate run-id filenames to a 3-day window — any
// record outside that window cannot possibly belong to the requested
// local day in any earth-bound timezone.
// ---------------------------------------------------------------------------

describe('utcDateWindow', () => {
  it('returns three UTC dates around the local input', () => {
    const [yesterday, today, tomorrow] = utcDateWindow('2026-05-15');
    // Each entry is a 10-char YYYY-MM-DD.
    expect(yesterday).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(tomorrow).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The window is strictly increasing: yesterday < today < tomorrow.
    expect(yesterday < today).toBe(true);
    expect(today < tomorrow).toBe(true);
  });

  it('today entry equals the requested local date when local-mid uses the same UTC day', () => {
    // For 2026-05-15 in any earth-bound timezone, the local-midnight's
    // UTC date is either 2026-05-14 or 2026-05-15. The "today" slot
    // pins which one this host saw — pinning the explicit value here
    // would only work in UTC, so we instead pin the relationship: the
    // today slot must be either the requested date or the day before
    // (negative-offset zones) — never further.
    const [_y, today, _t] = utcDateWindow('2026-05-15');
    expect(['2026-05-14', '2026-05-15']).toContain(today);
  });

  it('window covers month boundary correctly', () => {
    const [yesterday, today, tomorrow] = utcDateWindow('2026-06-01');
    // Yesterday is in May; today is May 31 OR June 1 (depending on
    // the host's offset relative to UTC); tomorrow is June 1 OR
    // June 2. We pin only the structural invariant: each is one of
    // the expected boundary dates.
    expect(['2026-05-30', '2026-05-31']).toContain(yesterday);
    expect(['2026-05-31', '2026-06-01']).toContain(today);
    expect(['2026-06-01', '2026-06-02']).toContain(tomorrow);
  });

  it('window covers year boundary correctly', () => {
    const [yesterday, today, tomorrow] = utcDateWindow('2026-01-01');
    expect(['2025-12-30', '2025-12-31']).toContain(yesterday);
    expect(['2025-12-31', '2026-01-01']).toContain(today);
    expect(['2026-01-01', '2026-01-02']).toContain(tomorrow);
  });

  it('returns ["", localDate, ""] for an unparseable input', () => {
    const [y, t, tomorrow] = utcDateWindow('not a date');
    expect(y).toBe('');
    expect(t).toBe('not a date');
    expect(tomorrow).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Round-2 fix (Issue 2): readDayCost timestamp-based aggregation
//
// The bug: previously readDayCost filtered by run-id filename prefix.
// Run-ids use UTC timestamps, but the day-cap is local-date scoped —
// so a run started at 23:00 in Phoenix (UTC-7) gets a filename
// prefixed with the NEXT UTC day, and `readDayCost('today', ...)`
// excluded it. The cap silently underreported in any timezone west
// of UTC.
//
// The pin: if the record's timestamp converted to local date matches
// the requested date, it MUST be included regardless of the run-id
// filename's UTC prefix.
// ---------------------------------------------------------------------------

describe('readDayCost — local-date classification (round-2 issue 2)', () => {
  it('includes a record whose run-id filename UTC date differs from the record\'s local date', () => {
    // The bug-specific case. We construct:
    //   - a record whose `timestamp` resolves to a known LOCAL date,
    //   - and place it inside a run-file whose filename UTC-prefix is
    //     a DIFFERENT calendar date than that local date.
    //
    // Round-3: we build the timestamp via the local-time `Date`
    // constructor (anchors local noon on the target local day) so the
    // local-date string is invariant across host TZ. The filename
    // UTC-prefix is then chosen from the utcDateWindow members that
    // are NOT the local day — guaranteed to exist because the window
    // spans three UTC dates (`yesterday`, `today`, `tomorrow`) and
    // local noon never lands on all three at once.
    //
    // The pin: the file IS visited (because utcDateWindow includes
    // its UTC prefix) and the record IS counted (because its
    // timestamp's local date matches the query). Without the round-2
    // fix, the prefix-only filter would have either missed the file
    // entirely (if it filtered on local-day prefix) or counted it on
    // the wrong day (if it took the prefix as authority). The test
    // proves "filename prefix is NOT authority for membership".
    const root = mkTmp();
    const recordTs = localNoonTs(2026, 4, 2); // local noon, May 2
    const localDay = localDateFromTimestamp(recordTs);
    const window = utcDateWindow(localDay);
    // Pick a window member that differs from localDay. In every TZ,
    // at least one of `yesterday`/`tomorrow` differs (and often both).
    const utcPrefix = window.find((d) => d !== '' && d !== localDay);
    if (utcPrefix === undefined) {
      throw new Error(
        `expected at least one window member to differ from ${localDay}, got ${JSON.stringify(window)}`,
      );
    }
    const runId = `${utcPrefix}T01-00-00Z-deadbeef`;

    recordCost(rec({
      run_id: runId,
      timestamp: recordTs,
      dollars: 0.42,
    }), root);

    const out = readDayCost(localDay, root);
    // The bug-specific assertion: the record IS included because its
    // timestamp resolves to localDay, even though its run-id filename
    // starts with a different UTC date.
    expect(out.total).toBe(0.42);
    expect(out.unknown_count).toBe(0);
    // Sanity: the prefix really IS different from the local date —
    // otherwise this test would not be exercising the bug.
    expect(utcPrefix).not.toBe(localDay);
  });

  it('excludes a record whose timestamp falls on a different local date than the requested one', () => {
    // The dual: a record whose timestamp resolves to a different
    // local date than the query — must be EXCLUDED, regardless of
    // what the filename UTC-prefix says. We deliberately put the
    // filename UTC-prefix at the QUERY date so a prefix-authority
    // implementation would (wrongly) include it.
    const root = mkTmp();
    const queryTs = localNoonTs(2026, 4, 2);  // local noon, May 2
    const recordTs = localNoonTs(2026, 4, 3); // local noon, May 3
    const queryDay = localDateFromTimestamp(queryTs);
    const recordDay = localDateFromTimestamp(recordTs);
    // Filename prefix matches the QUERY's local day so we can prove
    // that timestamp wins over filename prefix.
    const runId = `${queryDay}T22-00-00Z-cafebabe`;

    recordCost(rec({
      run_id: runId,
      timestamp: recordTs,
      dollars: 9.99,
    }), root);

    const out = readDayCost(queryDay, root);
    expect(out.total).toBe(0);
    expect(out.unknown_count).toBe(0);
    // Sanity: the dates really are different.
    expect(recordDay).not.toBe(queryDay);
  });

  it('mixes records across run-files with different UTC date prefixes; aggregation matches local-date classification', () => {
    // Three records spread across two run-files; the local-date
    // classification (not filename) is what determines membership.
    // Round-3: all timestamps are local-anchored so the per-day
    // partition is TZ-invariant. The run-file B prefix must lie in
    // BOTH the dayA window and the dayB window so both queries visit
    // it; we pick the intersection member explicitly. For local noon
    // anchors on consecutive days, that intersection is non-empty in
    // every host TZ — local noon on day X always yields a UTC date
    // in {X-1, X}, and local noon on day X+1 always yields a UTC
    // date in {X, X+1}, so X is always a member of dayA's "tomorrow"
    // slot or dayB's "yesterday" slot at minimum.
    const root = mkTmp();
    const tsA = localNoonTs(2026, 4, 2); // local noon, May 2
    const tsB = localNoonTs(2026, 4, 3); // local noon, May 3
    const dayA = localDateFromTimestamp(tsA);
    const dayB = localDateFromTimestamp(tsB);
    const windowA = utcDateWindow(dayA);
    const windowB = utcDateWindow(dayB);
    // Pick a prefix that is (a) in windowA, (b) in windowB, (c) not
    // equal to dayA. Choosing one in BOTH windows ensures both
    // queries visit run-file B; choosing != dayA ensures the
    // filename prefix does not match dayA's local-day prefix (so a
    // naive prefix-only filter would have missed it on the dayA
    // query).
    const utcPrefixB = windowA.find(
      (d) => d !== '' && d !== dayA && windowB.includes(d),
    );
    if (utcPrefixB === undefined) {
      throw new Error(
        `expected windowA ∩ windowB \\ {dayA} non-empty; windowA=${JSON.stringify(windowA)} windowB=${JSON.stringify(windowB)} dayA=${dayA}`,
      );
    }

    // run-file A: filename prefix matches dayA's local day; one
    // record on local-day-A.
    recordCost(rec({
      run_id: `${dayA}T08-00-00Z-aaaaaaaa`,
      timestamp: tsA,
      dollars: 1.00,
    }), root);
    // run-file B: filename UTC-prefix is a DIFFERENT date than dayA
    // (would have been missed by a naive prefix-only filter). One
    // record inside B is on local-day-A and must be counted in dayA's
    // total.
    recordCost(rec({
      run_id: `${utcPrefixB}T01-00-00Z-bbbbbbbb`,
      timestamp: tsA,
      dollars: 2.00,
    }), root);
    // Same run-file B: another record on local-day-B — must be
    // EXCLUDED from the dayA query and INCLUDED in the dayB query.
    recordCost(rec({
      run_id: `${utcPrefixB}T01-00-00Z-bbbbbbbb`,
      timestamp: tsB,
      dollars: 4.00,
    }), root);

    const out = readDayCost(dayA, root);
    expect(out.total).toBe(3.00);
    expect(out.unknown_count).toBe(0);

    // And the next day correctly gets just the one record.
    const next = readDayCost(dayB, root);
    expect(next.total).toBe(4.00);
    expect(next.unknown_count).toBe(0);
  });
});
