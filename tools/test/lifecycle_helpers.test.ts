/**
 * Tests for the small lifecycle-loop helpers extracted from run.ts in
 * Phase 4.5: refreshCompletionId and safeCall.
 *
 * The refreshCompletionId tests in run.test.ts already pin its main
 * contract (the test file there imports from this module after the
 * relocation). This file adds coverage for safeCall — the throws-to-
 * Result adapter that the develop and verify phase loops rely on.
 */

import { describe, it, expect } from 'vitest';
import { safeCall } from '../pipeline/lifecycle_helpers.js';

describe('safeCall', () => {
  it('returns { ok: true } for a callable that does not throw', () => {
    const result = safeCall(() => 42);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('returns { ok: false, error } when the callable throws an Error', () => {
    const result = safeCall(() => { throw new Error('precondition failed'); });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('precondition failed');
  });

  it('returns { ok: false, error } when the callable throws a non-Error value', () => {
    // Some throwers throw strings or numbers. The helper must coerce
    // them via String() rather than letting `.message` blow up.
    const result = safeCall(() => { throw 'string-thrown'; });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('string-thrown');
  });

  it('does NOT re-throw — the caller relies on this to keep loops linear', () => {
    expect(() => {
      safeCall(() => { throw new Error('still suppressed'); });
    }).not.toThrow();
  });

  it('runs the callable for its side effects (the result value is ignored)', () => {
    let counter = 0;
    safeCall(() => { counter += 1; });
    expect(counter).toBe(1);
  });
});
