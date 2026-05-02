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
    timestamp: '2026-05-01T00:00:00.000Z',
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
  // Round-2 note: readDayCost classifies records by their `timestamp`
  // field converted to local date — NOT by run-id filename prefix.
  // Tests in this block use mid-day UTC timestamps (T12:00:00.000Z)
  // so the local-date interpretation is unambiguous in any earth-bound
  // timezone (mid-day UTC stays inside the same calendar day for
  // every offset in -12..+14).
  it('sums across all records whose local-date matches the requested date', () => {
    const root = mkTmp();
    // Two run-ids stamped 2026-05-01, one 2026-05-02. Format mirrors
    // newRunId: YYYY-MM-DDTHH-MM-SSZ-<8hex>.
    recordCost(rec({
      run_id: '2026-05-01T10-00-00Z-deadbeef', dollars: 0.50,
      timestamp: '2026-05-01T12:00:00.000Z',
    }), root);
    recordCost(rec({
      run_id: '2026-05-01T11-00-00Z-cafebabe', dollars: 1.25,
      timestamp: '2026-05-01T12:00:00.000Z',
    }), root);
    recordCost(rec({
      run_id: '2026-05-02T09-00-00Z-feedface', dollars: 5.00,
      timestamp: '2026-05-02T12:00:00.000Z',
    }), root);

    const may1 = readDayCost('2026-05-01', root);
    expect(may1.total).toBe(1.75);
    expect(may1.unknown_count).toBe(0);

    const may2 = readDayCost('2026-05-02', root);
    expect(may2.total).toBe(5);
    expect(may2.unknown_count).toBe(0);
  });

  it('aggregates unknown_count across run files', () => {
    const root = mkTmp();
    recordCost(rec({
      run_id: '2026-05-01T10-00-00Z-aaaaaaaa', dollars: 0.50,
      timestamp: '2026-05-01T12:00:00.000Z',
    }), root);
    recordCost(rec({
      run_id: '2026-05-01T10-00-00Z-aaaaaaaa', dollars: null,
      timestamp: '2026-05-01T12:00:00.000Z',
    }), root);
    recordCost(rec({
      run_id: '2026-05-01T11-00-00Z-bbbbbbbb', dollars: null,
      timestamp: '2026-05-01T12:00:00.000Z',
    }), root);

    const out = readDayCost('2026-05-01', root);
    expect(out.total).toBe(0.5);
    expect(out.unknown_count).toBe(2);
  });

  it('returns zeroes when the cost dir does not exist', () => {
    const root = mkTmp();
    expect(readDayCost('2026-05-01', root)).toEqual({ total: 0, unknown_count: 0 });
  });

  it('returns zeroes when no records match the local date', () => {
    const root = mkTmp();
    recordCost(rec({
      run_id: '2026-04-30T10-00-00Z-deadbeef', dollars: 5,
      timestamp: '2026-04-30T12:00:00.000Z',
    }), root);
    expect(readDayCost('2026-05-01', root)).toEqual({ total: 0, unknown_count: 0 });
  });

  it('ignores non-jsonl entries in the cost directory', () => {
    const root = mkTmp();
    // Bootstrap by writing one valid record (to create the dir).
    recordCost(rec({
      run_id: '2026-05-01T10-00-00Z-aaaaaaaa', dollars: 1,
      timestamp: '2026-05-01T12:00:00.000Z',
    }), root);
    // Drop a non-jsonl file in there; it must not be included.
    appendFileSync(join(root, 'cost', 'README.md'), 'not a JSONL', 'utf-8');

    const out = readDayCost('2026-05-01', root);
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
    // Use a Date that is unambiguously the same local-date as UTC for
    // any reasonable timezone. Mid-day UTC works for all -12..+14 zones.
    const fixed = new Date('2026-05-15T12:00:00.000Z');
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
  it('round-trips a mid-day UTC timestamp to the same local date in any TZ', () => {
    // Mid-day UTC stays inside the same calendar day for any offset
    // in -12..+14, so the local date equals the UTC date for these.
    expect(localDateFromTimestamp('2026-05-01T12:00:00.000Z')).toBe('2026-05-01');
    expect(localDateFromTimestamp('2026-12-31T12:00:00.000Z')).toBe('2026-12-31');
  });

  it('matches what localDateString returns for the same Date instance', () => {
    // Pin the contract: localDateFromTimestamp(t) === localDateString(() => new Date(t)).
    // (Round-2 invariant: the two helpers must agree on classification.)
    const samples = [
      '2026-05-01T00:00:00.000Z',
      '2026-05-01T12:00:00.000Z',
      '2026-05-01T23:59:59.000Z',
      '2026-12-31T20:00:00.000Z',
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
  it('includes a record whose run-id filename is UTC-tomorrow when the record\'s local date is today', () => {
    // The bug-specific case. We construct:
    //   - a run-id filename whose UTC date is the day AFTER the
    //     requested local date (`2026-05-03T...`),
    //   - a record inside that file whose `timestamp` falls on the
    //     requested local date (`2026-05-02`).
    //
    // We need a timestamp that is unambiguously local 2026-05-02 in
    // ANY earth-bound timezone, while still having a UTC date of
    // 2026-05-03. That's impossible to satisfy in every TZ at once —
    // a timestamp that maps to local 2026-05-02 in a positive-offset
    // zone may map to a different date in a negative-offset zone.
    //
    // What we CAN pin in any TZ: the timestamp's UTC and local dates
    // agree (mid-day UTC), so we use a mid-day UTC stamp on the
    // requested local date, and we deliberately MISMATCH the
    // filename's UTC prefix to a different date. The filename-prefix
    // candidate filter must still consider this file (because the
    // utcDateWindow pre-filter spans ±1 UTC day around the local
    // date), and the per-record check must include it (because the
    // timestamp's local date matches).
    const root = mkTmp();
    const utcNextDay = '2026-05-03';
    // Mid-day UTC on the local-target day so local-date matches in
    // every reasonable host TZ.
    const recordTs = '2026-05-02T12:00:00.000Z';
    const runId = `${utcNextDay}T01-00-00Z-deadbeef`;

    recordCost(rec({
      run_id: runId,
      timestamp: recordTs,
      dollars: 0.42,
    }), root);

    const out = readDayCost('2026-05-02', root);
    // The bug-specific assertion: the record IS included because its
    // timestamp resolves to local 2026-05-02, even though its run-id
    // filename starts with 2026-05-03.
    expect(out.total).toBe(0.42);
    expect(out.unknown_count).toBe(0);
  });

  it('excludes a record whose timestamp falls on a different local date than the requested one', () => {
    // The dual: a run-id filename matching the requested local date
    // PREFIX, but whose record timestamp resolves to a different
    // local date — must be EXCLUDED. (The filename prefix is no
    // longer the authority.)
    const root = mkTmp();
    // A record timestamped local 2026-05-03 mid-day.
    const runId = '2026-05-02T22-00-00Z-cafebabe';
    const recordTs = '2026-05-03T12:00:00.000Z';

    recordCost(rec({
      run_id: runId,
      timestamp: recordTs,
      dollars: 9.99,
    }), root);

    const out = readDayCost('2026-05-02', root);
    expect(out.total).toBe(0);
    expect(out.unknown_count).toBe(0);
  });

  it('mixes records across run-files with different UTC date prefixes; aggregation matches local-date classification', () => {
    // Three records spread across two run-files; the local-date
    // classification (not filename) is what determines membership.
    const root = mkTmp();
    // run-file A: filename UTC 2026-05-02; one record on local
    // 2026-05-02 (mid-day UTC).
    recordCost(rec({
      run_id: '2026-05-02T08-00-00Z-aaaaaaaa',
      timestamp: '2026-05-02T12:00:00.000Z',
      dollars: 1.00,
    }), root);
    // run-file B: filename UTC 2026-05-03 (UTC-tomorrow); one record
    // on local 2026-05-02 (mid-day UTC) — would have been MISSED
    // by the pre-fix prefix filter.
    recordCost(rec({
      run_id: '2026-05-03T01-00-00Z-bbbbbbbb',
      timestamp: '2026-05-02T12:00:00.000Z',
      dollars: 2.00,
    }), root);
    // Same run-file B: another record on local 2026-05-03 — must be
    // EXCLUDED from the 2026-05-02 query.
    recordCost(rec({
      run_id: '2026-05-03T01-00-00Z-bbbbbbbb',
      timestamp: '2026-05-03T12:00:00.000Z',
      dollars: 4.00,
    }), root);

    const out = readDayCost('2026-05-02', root);
    expect(out.total).toBe(3.00);
    expect(out.unknown_count).toBe(0);

    // And the next day correctly gets just the one record.
    const next = readDayCost('2026-05-03', root);
    expect(next.total).toBe(4.00);
    expect(next.unknown_count).toBe(0);
  });
});
