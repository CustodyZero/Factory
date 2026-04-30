/**
 * Tests for the dev-phase state machine extracted from tools/run.ts.
 *
 * These pin the decision logic that decides where to resume a
 * partially-completed dev packet, and how to advance after each
 * imperative step in the loop. The decisions are pure: given the
 * input state, the output resume point is deterministic.
 */

import { describe, it, expect } from 'vitest';
import {
  deriveDevResumePoint,
  nextPointAfterImplement,
  nextPointAfterReview,
  nextPointAfterRework,
  nextPointAfterFinalize,
} from '../pipeline/develop_phase.js';
import type { DevResumePoint } from '../pipeline/develop_phase.js';
import type { RawPacket } from '../execute.js';

function makePacket(overrides: Partial<RawPacket> = {}): RawPacket {
  return {
    id: overrides.id ?? 'pkt-1',
    kind: overrides.kind ?? 'dev',
    title: overrides.title ?? 'Test packet',
    ...overrides,
  } as RawPacket;
}

// ---------------------------------------------------------------------------
// deriveDevResumePoint
// ---------------------------------------------------------------------------

describe('deriveDevResumePoint', () => {
  it('returns "completed" when a completion record exists, regardless of status', () => {
    expect(deriveDevResumePoint(makePacket({ status: 'implementing' }), true)).toBe('completed');
    expect(deriveDevResumePoint(makePacket({ status: 'review_requested' }), true)).toBe('completed');
    expect(deriveDevResumePoint(makePacket({ status: null }), true)).toBe('completed');
  });

  it('returns "implement" for null/undefined status (no completion)', () => {
    expect(deriveDevResumePoint(makePacket({ status: null }), false)).toBe('implement');
    expect(deriveDevResumePoint(makePacket({}), false)).toBe('implement');
  });

  it('returns "implement" for "draft" / "ready" / "implementing" statuses', () => {
    expect(deriveDevResumePoint(makePacket({ status: 'draft' }), false)).toBe('implement');
    expect(deriveDevResumePoint(makePacket({ status: 'ready' }), false)).toBe('implement');
    expect(deriveDevResumePoint(makePacket({ status: 'implementing' }), false)).toBe('implement');
  });

  it('returns "review" for status "review_requested"', () => {
    expect(deriveDevResumePoint(makePacket({ status: 'review_requested' }), false)).toBe('review');
  });

  it('returns "rework" for status "changes_requested"', () => {
    expect(deriveDevResumePoint(makePacket({ status: 'changes_requested' }), false)).toBe('rework');
  });

  it('returns "finalize" for status "review_approved"', () => {
    expect(deriveDevResumePoint(makePacket({ status: 'review_approved' }), false)).toBe('finalize');
  });

  it('falls back to "implement" for unknown status strings', () => {
    expect(deriveDevResumePoint(makePacket({ status: 'mystery_status' }), false)).toBe('implement');
  });
});

// ---------------------------------------------------------------------------
// nextPointAfterImplement
// ---------------------------------------------------------------------------

describe('nextPointAfterImplement', () => {
  it('returns "request_review" on success', () => {
    expect(nextPointAfterImplement(true)).toBe('request_review');
  });

  it('returns null on failure (signals loop to stop)', () => {
    expect(nextPointAfterImplement(false)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// nextPointAfterReview
// ---------------------------------------------------------------------------

describe('nextPointAfterReview', () => {
  it('returns null when the reviewer agent failed (regardless of status)', () => {
    expect(nextPointAfterReview(false, 'review_approved')).toBeNull();
    expect(nextPointAfterReview(false, 'changes_requested')).toBeNull();
    expect(nextPointAfterReview(false, null)).toBeNull();
  });

  it('returns "finalize" when reviewer succeeded and packet was approved', () => {
    expect(nextPointAfterReview(true, 'review_approved')).toBe('finalize');
  });

  it('returns "rework" when reviewer succeeded and packet had changes requested', () => {
    expect(nextPointAfterReview(true, 'changes_requested')).toBe('rework');
  });

  it('returns "finalize" when reviewer succeeded but did not transition status (force-approve case)', () => {
    // Original loop: when status didn't transition, the imperative
    // path force-approves on disk and falls through to finalize.
    // The pure decision says: target finalize.
    expect(nextPointAfterReview(true, null)).toBe('finalize');
    expect(nextPointAfterReview(true, 'implementing')).toBe('finalize');
    expect(nextPointAfterReview(true, 'review_requested')).toBe('finalize');
  });
});

// ---------------------------------------------------------------------------
// nextPointAfterRework
// ---------------------------------------------------------------------------

describe('nextPointAfterRework', () => {
  it('returns "request_review" on success — re-enter the review loop', () => {
    expect(nextPointAfterRework(true)).toBe('request_review');
  });

  it('returns null on failure', () => {
    expect(nextPointAfterRework(false)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// nextPointAfterFinalize
// ---------------------------------------------------------------------------

describe('nextPointAfterFinalize', () => {
  it('returns "completed" on success', () => {
    const out: DevResumePoint | null = nextPointAfterFinalize(true);
    expect(out).toBe('completed');
  });

  it('returns null on failure', () => {
    expect(nextPointAfterFinalize(false)).toBeNull();
  });
});
