/**
 * Unit tests for the Phase 5.5 events backbone.
 *
 * Covers two layers:
 *
 *   1. Pure logic in tools/pipeline/events.ts — provenance derivation,
 *      every constructor helper, and the run-id generator. No fs.
 *
 *   2. I/O wrapper in tools/events.ts — appendEvent / readEvents
 *      round-trip under tmpdir, defensive read against a truncated
 *      final line, directory creation on first append.
 *
 * The split mirrors the file split itself; tests in the first block
 * never touch disk, tests in the second block use tmpdir-rooted
 * artifactRoots so they never touch the host project's events tree.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  deriveProvenance,
  newRunId,
  makePipelineStarted,
  makePipelineSpecResolved,
  makePipelineFinished,
  makePipelineFailed,
  makeSpecStarted,
  makeSpecBlocked,
  makeSpecCompleted,
  makePhaseStarted,
  makePhaseCompleted,
  makePacketStarted,
  makePacketReviewRequested,
  makePacketReviewApproved,
  makePacketChangesRequested,
  makePacketCompleted,
  makePacketFailed,
  makeVerificationPassed,
  makeVerificationFailed,
  type Event,
} from '../pipeline/events.js';
import { appendEvent, readEvents, eventsPathFor } from '../events.js';

// ---------------------------------------------------------------------------
// Fixture cleanup
// ---------------------------------------------------------------------------

let tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  tempDirs = [];
});

function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'events-'));
  tempDirs.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// deriveProvenance — order matters: VITEST > dryRun > live_run.
//
// Under vitest the env var is always set, so we MUST be able to test
// the dryRun and live_run branches by temporarily unsetting it. Save
// and restore around each branch test.
// ---------------------------------------------------------------------------

describe('deriveProvenance', () => {
  it("returns 'test' when running under vitest (VITEST set)", () => {
    // Vitest sets process.env.VITEST automatically; rely on that.
    expect(process.env['VITEST']).toBeDefined();
    expect(deriveProvenance({ dryRun: false })).toBe('test');
    expect(deriveProvenance({ dryRun: true })).toBe('test');
  });

  it("returns 'dry_run' when VITEST is unset and dryRun is true", () => {
    const saved = process.env['VITEST'];
    delete process.env['VITEST'];
    try {
      expect(deriveProvenance({ dryRun: true })).toBe('dry_run');
    } finally {
      if (saved !== undefined) process.env['VITEST'] = saved;
    }
  });

  it("returns 'live_run' when VITEST is unset and dryRun is false", () => {
    const saved = process.env['VITEST'];
    delete process.env['VITEST'];
    try {
      expect(deriveProvenance({ dryRun: false })).toBe('live_run');
    } finally {
      if (saved !== undefined) process.env['VITEST'] = saved;
    }
  });

  it("'test' beats 'dry_run' when both branches would otherwise apply (order invariant)", () => {
    // VITEST is set under vitest by definition; pass dryRun=true to confirm
    // the test branch still wins. This pins the precedence rule against a
    // future refactor that might swap the order.
    expect(deriveProvenance({ dryRun: true })).toBe('test');
  });
});

// ---------------------------------------------------------------------------
// newRunId — uniqueness against an equal clock + format
// ---------------------------------------------------------------------------

describe('newRunId', () => {
  it('produces a filesystem-safe id (no colons)', () => {
    const id = newRunId();
    expect(id).not.toContain(':');
  });

  it('produces unique ids when the clock returns the SAME instant twice', () => {
    // The whole point of the random suffix is to disambiguate runs that
    // start in the same millisecond. We force the clock to return an
    // identical timestamp; uniqueness must come from the suffix alone.
    const fixed = new Date('2026-05-02T07:52:06.000Z');
    const a = newRunId(() => fixed);
    const b = newRunId(() => fixed);
    expect(a).not.toBe(b);
  });

  it("matches the expected timestamp + suffix shape", () => {
    const fixed = new Date('2026-05-02T07:52:06.123Z');
    const id = newRunId(() => fixed);
    // 2026-05-02T07-52-06Z is the stripped/sanitised stamp; suffix is 8 hex chars.
    expect(id).toMatch(/^2026-05-02T07-52-06Z-[0-9a-f]{8}$/);
  });
});

// ---------------------------------------------------------------------------
// Constructor helpers — each builds an Event with the right discriminator
// and the expected payload fields.
//
// We keep these terse: one assertion per test would explode the file
// without adding signal. Instead, each test builds one event and pins
// the shape that consumers (recovery, memory, replay) will rely on.
// ---------------------------------------------------------------------------

// Round-2: BaseInputs no longer accepts a `provenance` field. Tests run
// under VITEST so deriveProvenance returns 'test' regardless of the
// dry_run hint; that's pinned in event_provenance.test.ts.
const base = { run_id: 'run-x', dry_run: false, timestamp: '2026-05-02T07:52:06.000Z' };

describe('event constructors', () => {
  it('makePipelineStarted', () => {
    const e = makePipelineStarted(base, { args: ['a', 'b'], dry_run: false });
    expect(e.event_type).toBe('pipeline.started');
    expect(e.timestamp).toBe('2026-05-02T07:52:06.000Z');
    expect(e.provenance).toBe('test');
    expect(e.run_id).toBe('run-x');
    expect(e.payload.event_type).toBe('pipeline.started');
    expect(e.payload.args).toEqual(['a', 'b']);
    expect(e.payload.dry_run).toBe(false);
  });

  it('makePipelineSpecResolved', () => {
    const e = makePipelineSpecResolved(base, { spec_ids: ['a', 'b'], order: ['a', 'b'] });
    expect(e.event_type).toBe('pipeline.spec_resolved');
    expect(e.payload.spec_ids).toEqual(['a', 'b']);
    expect(e.payload.order).toEqual(['a', 'b']);
  });

  it('makePipelineFinished', () => {
    const e = makePipelineFinished(base, { message: 'ok', specs_completed: 2 });
    expect(e.event_type).toBe('pipeline.finished');
    expect(e.payload.success).toBe(true);
    expect(e.payload.specs_completed).toBe(2);
  });

  it('makePipelineFailed', () => {
    const e = makePipelineFailed(base, {
      message: 'bad',
      specs_completed: 1,
      specs_failed: 1,
      specs_blocked: 0,
    });
    expect(e.event_type).toBe('pipeline.failed');
    expect(e.payload.success).toBe(false);
    expect(e.payload.specs_failed).toBe(1);
    expect(e.payload.specs_blocked).toBe(0);
  });

  it('makeSpecStarted', () => {
    const e = makeSpecStarted(base, { spec_id: 's1' });
    expect(e.event_type).toBe('spec.started');
    expect(e.payload.spec_id).toBe('s1');
  });

  it('makeSpecBlocked', () => {
    const e = makeSpecBlocked(base, { spec_id: 'b', blocked_by: ['a'], reason: 'a failed' });
    expect(e.event_type).toBe('spec.blocked');
    expect(e.payload.blocked_by).toEqual(['a']);
    expect(e.payload.reason).toBe('a failed');
  });

  it('makeSpecCompleted (success)', () => {
    const e = makeSpecCompleted(base, {
      spec_id: 's',
      status: 'completed',
      feature_id: 'f1',
      packets_completed: ['p1'],
      packets_failed: [],
    });
    expect(e.event_type).toBe('spec.completed');
    expect(e.payload.status).toBe('completed');
    expect(e.payload.feature_id).toBe('f1');
    expect(e.payload.reason).toBeUndefined();
  });

  it('makeSpecCompleted (failure with reason)', () => {
    const e = makeSpecCompleted(base, {
      spec_id: 's',
      status: 'failed',
      feature_id: null,
      packets_completed: [],
      packets_failed: ['p1'],
      reason: 'p1 failed',
    });
    expect(e.payload.status).toBe('failed');
    expect(e.payload.reason).toBe('p1 failed');
  });

  it('makePhaseStarted / makePhaseCompleted', () => {
    const s = makePhaseStarted(base, { phase: 'plan', spec_id: 's' });
    const c = makePhaseCompleted(base, { phase: 'plan', spec_id: 's', outcome: 'ok' });
    expect(s.event_type).toBe('phase.started');
    expect(s.payload.phase).toBe('plan');
    expect(c.event_type).toBe('phase.completed');
    expect(c.payload.outcome).toBe('ok');
  });

  it('packet lifecycle constructors', () => {
    const ps = makePacketStarted(base, { packet_id: 'p1' });
    const pr = makePacketReviewRequested(base, { packet_id: 'p1', review_iteration: 1 });
    const pa = makePacketReviewApproved(base, { packet_id: 'p1', review_iteration: 2 });
    const pc = makePacketChangesRequested(base, { packet_id: 'p1', review_iteration: 1 });
    const pd = makePacketCompleted(base, { packet_id: 'p1' });
    const pf = makePacketFailed(base, { packet_id: 'p1', reason: 'timeout' });
    expect(ps.event_type).toBe('packet.started');
    expect(pr.event_type).toBe('packet.review_requested');
    expect(pr.payload.review_iteration).toBe(1);
    expect(pa.event_type).toBe('packet.review_approved');
    expect(pc.event_type).toBe('packet.changes_requested');
    expect(pd.event_type).toBe('packet.completed');
    expect(pf.event_type).toBe('packet.failed');
    expect(pf.payload.reason).toBe('timeout');
  });

  it('verification constructors', () => {
    const ok = makeVerificationPassed(base, { packet_id: 'p1', checks: ['build', 'lint', 'tests', 'ci'] });
    const bad = makeVerificationFailed(base, { packet_id: 'p1', failed_checks: ['lint'] });
    expect(ok.event_type).toBe('verification.passed');
    expect(ok.payload.checks).toEqual(['build', 'lint', 'tests', 'ci']);
    expect(bad.event_type).toBe('verification.failed');
    expect(bad.payload.failed_checks).toEqual(['lint']);
  });

  it('uses Date.now() when timestamp is omitted', () => {
    // Without a timestamp, the constructor stamps the event itself —
    // we just need to confirm a non-empty ISO string lands on the
    // envelope. The `with-timestamp` tests above pin format equality.
    const e = makePipelineStarted(
      { run_id: 'r' },
      { args: [], dry_run: false },
    );
    expect(e.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// I/O wrapper — appendEvent / readEvents / eventsPathFor
// ---------------------------------------------------------------------------

describe('appendEvent / readEvents (tmpdir)', () => {
  it('writes a single JSONL line per call separated by \\n', () => {
    const root = mkTmp();
    const e1 = makeSpecStarted(
      { run_id: 'run-1' },
      { spec_id: 'a' },
    );
    const e2 = makeSpecCompleted(
      { run_id: 'run-1' },
      {
        spec_id: 'a',
        status: 'completed',
        feature_id: 'f',
        packets_completed: [],
        packets_failed: [],
      },
    );
    appendEvent(e1, root);
    appendEvent(e2, root);
    const { file } = eventsPathFor(root, 'run-1');
    const raw = readFileSync(file, 'utf-8');
    expect(raw.split('\n').filter((s) => s.length > 0)).toHaveLength(2);
  });

  it('creates the events directory on first call (best-effort, no throw)', () => {
    const root = mkTmp();
    expect(existsSync(join(root, 'events'))).toBe(false);
    const e = makeSpecStarted(
      { run_id: 'run-mkdir' },
      { spec_id: 'a' },
    );
    appendEvent(e, root);
    expect(existsSync(join(root, 'events'))).toBe(true);
  });

  it('readEvents round-trips written events in order', () => {
    const root = mkTmp();
    const e1 = makeSpecStarted({ run_id: 'rt' }, { spec_id: 'a' });
    const e2 = makePhaseStarted(
      { run_id: 'rt' },
      { phase: 'plan', spec_id: 'a' },
    );
    appendEvent(e1, root);
    appendEvent(e2, root);
    const got = readEvents('rt', root);
    expect(got).toHaveLength(2);
    expect(got[0]!.event_type).toBe('spec.started');
    expect(got[1]!.event_type).toBe('phase.started');
  });

  it('readEvents tolerates a truncated final line (defensive)', () => {
    const root = mkTmp();
    const e = makeSpecStarted(
      { run_id: 'trunc' },
      { spec_id: 'a' },
    );
    appendEvent(e, root);
    // Append a partial line to simulate a process killed mid-write.
    // Note no trailing '\n' — that's the truncation signature.
    const { file } = eventsPathFor(root, 'trunc');
    appendFileSync(file, '{"event_type":"spec.started","timestamp":"2026', 'utf-8');
    const got = readEvents('trunc', root);
    expect(got).toHaveLength(1);
    expect(got[0]!.event_type).toBe('spec.started');
  });

  it('readEvents returns an empty array when the file does not exist', () => {
    const root = mkTmp();
    expect(readEvents('never-written', root)).toEqual([]);
  });

  it('appendEvent swallows write errors (best-effort)', () => {
    // Point at a path where mkdir will fail (a regular file masquerading
    // as a parent of the target dir). The call must NOT throw.
    const root = mkTmp();
    const blockedRoot = join(root, 'blocked');
    // Create a regular file at the path where we'd want the events dir.
    writeFileSync(blockedRoot, 'i am a file, not a dir', 'utf-8');
    const e = makeSpecStarted(
      { run_id: 'r' },
      { spec_id: 'a' },
    );
    expect(() => appendEvent(e, blockedRoot)).not.toThrow();
  });

  it('events round-tripped through readEvents preserve their full envelope', () => {
    const root = mkTmp();
    const original: Event = makePipelineFinished(
      { run_id: 'env-rt' },
      { message: 'all done', specs_completed: 3 },
    );
    appendEvent(original, root);
    const got = readEvents('env-rt', root);
    expect(got).toHaveLength(1);
    const e = got[0]!;
    expect(e.event_type).toBe('pipeline.finished');
    expect(e.run_id).toBe('env-rt');
    expect(e.provenance).toBe('test');
    if (e.payload.event_type === 'pipeline.finished') {
      expect(e.payload.specs_completed).toBe(3);
      expect(e.payload.message).toBe('all done');
    } else {
      throw new Error('payload discriminator mismatch');
    }
  });
});
