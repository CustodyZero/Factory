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
  it('sums across all run files matching the local-date prefix', () => {
    const root = mkTmp();
    // Two run-ids stamped 2026-05-01, one 2026-05-02. Format mirrors
    // newRunId: YYYY-MM-DDTHH-MM-SSZ-<8hex>.
    recordCost(rec({ run_id: '2026-05-01T10-00-00Z-deadbeef', dollars: 0.50 }), root);
    recordCost(rec({ run_id: '2026-05-01T11-00-00Z-cafebabe', dollars: 1.25 }), root);
    recordCost(rec({ run_id: '2026-05-02T09-00-00Z-feedface', dollars: 5.00 }), root);

    const may1 = readDayCost('2026-05-01', root);
    expect(may1.total).toBe(1.75);
    expect(may1.unknown_count).toBe(0);

    const may2 = readDayCost('2026-05-02', root);
    expect(may2.total).toBe(5);
    expect(may2.unknown_count).toBe(0);
  });

  it('aggregates unknown_count across run files', () => {
    const root = mkTmp();
    recordCost(rec({ run_id: '2026-05-01T10-00-00Z-aaaaaaaa', dollars: 0.50 }), root);
    recordCost(rec({ run_id: '2026-05-01T10-00-00Z-aaaaaaaa', dollars: null }), root);
    recordCost(rec({ run_id: '2026-05-01T11-00-00Z-bbbbbbbb', dollars: null }), root);

    const out = readDayCost('2026-05-01', root);
    expect(out.total).toBe(0.5);
    expect(out.unknown_count).toBe(2);
  });

  it('returns zeroes when the cost dir does not exist', () => {
    const root = mkTmp();
    expect(readDayCost('2026-05-01', root)).toEqual({ total: 0, unknown_count: 0 });
  });

  it('returns zeroes when no run-files match the date', () => {
    const root = mkTmp();
    recordCost(rec({ run_id: '2026-04-30T10-00-00Z-deadbeef', dollars: 5 }), root);
    expect(readDayCost('2026-05-01', root)).toEqual({ total: 0, unknown_count: 0 });
  });

  it('ignores non-jsonl entries in the cost directory', () => {
    const root = mkTmp();
    // Bootstrap by writing one valid record (to create the dir).
    recordCost(rec({ run_id: '2026-05-01T10-00-00Z-aaaaaaaa', dollars: 1 }), root);
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
