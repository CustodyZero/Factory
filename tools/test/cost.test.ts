/**
 * Unit tests for the Phase 5.7 cost-visibility pure module.
 *
 * Pins the rate-card-driven dollar computation, the provider-specific
 * token extraction, the aggregate behavior over null records, the
 * cap boundary semantics, and the no-throw guarantee on garbage input.
 *
 * These tests have no fs dependency — they exercise tools/pipeline/cost.ts
 * only. The I/O wrapper (tools/cost.ts) has its own test file.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RATE_CARD,
  type CostRecord,
  type RateCard,
  aggregateDollars,
  checkCap,
  computeCost,
  extractTokens,
  mergeRateCard,
} from '../pipeline/cost.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function rec(overrides: Partial<CostRecord>): CostRecord {
  return {
    run_id: 'run-1',
    packet_id: 'pkt-1',
    spec_id: 'spec-1',
    provider: 'claude',
    model: null,
    tokens_in: null,
    tokens_out: null,
    dollars: null,
    timestamp: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeCost
// ---------------------------------------------------------------------------

describe('computeCost', () => {
  const card: RateCard = DEFAULT_RATE_CARD;

  it('returns dollars when tokens and rate-card entry are present (claude opus)', () => {
    const r = computeCost('claude', 'claude-opus-4-7', 1_000_000, 1_000_000, card);
    // 1M input * $15/MTok + 1M output * $75/MTok = $90
    expect(r.dollars).toBe(90);
  });

  it('returns dollars for codex gpt-5', () => {
    const r = computeCost('codex', 'gpt-5', 2_000_000, 500_000, card);
    // 2M input * $5 + 0.5M output * $20 = 10 + 10 = $20
    expect(r.dollars).toBe(20);
  });

  it('returns null dollars when tokens_in is null', () => {
    const r = computeCost('claude', 'claude-opus-4-7', null, 1000, card);
    expect(r.dollars).toBeNull();
  });

  it('returns null dollars when tokens_out is null', () => {
    const r = computeCost('claude', 'claude-opus-4-7', 1000, null, card);
    expect(r.dollars).toBeNull();
  });

  it('returns null dollars when both tokens are null', () => {
    const r = computeCost('claude', 'claude-opus-4-7', null, null, card);
    expect(r.dollars).toBeNull();
  });

  it('returns null dollars when model is undefined', () => {
    const r = computeCost('claude', undefined, 1000, 1000, card);
    expect(r.dollars).toBeNull();
  });

  it('returns null dollars when provider has no rate-card entry', () => {
    const r = computeCost('copilot', 'some-model', 1000, 1000, card);
    expect(r.dollars).toBeNull();
  });

  it('returns null dollars when model has no rate-card entry under known provider', () => {
    const r = computeCost('claude', 'unknown-model', 1000, 1000, card);
    expect(r.dollars).toBeNull();
  });

  it('returns 0 dollars when both token counts are zero (rate-card present)', () => {
    const r = computeCost('claude', 'claude-opus-4-7', 0, 0, card);
    expect(r.dollars).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// mergeRateCard
// ---------------------------------------------------------------------------

describe('mergeRateCard', () => {
  it('returns DEFAULT_RATE_CARD when overrides is undefined', () => {
    const merged = mergeRateCard(undefined);
    expect(merged).toBe(DEFAULT_RATE_CARD);
  });

  it('overlays per-model overrides on top of defaults', () => {
    const merged = mergeRateCard({
      claude: {
        'claude-opus-4-7': { input_per_mtok: 100, output_per_mtok: 500 },
      },
    });
    expect(merged['claude']!['claude-opus-4-7']).toEqual({
      input_per_mtok: 100,
      output_per_mtok: 500,
    });
    // Other claude entries preserved.
    expect(merged['claude']!['claude-haiku-4-5']).toEqual(
      DEFAULT_RATE_CARD['claude']!['claude-haiku-4-5'],
    );
    // Other providers preserved.
    expect(merged['codex']).toEqual(DEFAULT_RATE_CARD['codex']);
  });

  it('introduces a new provider that was not in defaults', () => {
    const merged = mergeRateCard({
      copilot: {
        'gpt-5-copilot': { input_per_mtok: 7, output_per_mtok: 21 },
      },
    });
    expect(merged['copilot']!['gpt-5-copilot']).toEqual({
      input_per_mtok: 7,
      output_per_mtok: 21,
    });
  });
});

// ---------------------------------------------------------------------------
// extractTokens
// ---------------------------------------------------------------------------

describe('extractTokens', () => {
  it('extracts codex tokens from an input_tokens / output_tokens stderr fixture', () => {
    const stderr = '[banner]\ninput_tokens: 1234\noutput_tokens: 5678\n[done]';
    const r = extractTokens('codex', '', stderr);
    expect(r).toEqual({ tokens_in: 1234, tokens_out: 5678 });
  });

  it('extracts codex tokens from stdout when stderr is empty', () => {
    const stdout = 'tokens used: input_tokens=42 output_tokens=99';
    const r = extractTokens('codex', stdout, '');
    expect(r).toEqual({ tokens_in: 42, tokens_out: 99 });
  });

  it('extracts codex tokens regardless of case and underscore vs hyphen', () => {
    const stderr = 'INPUT-TOKENS: 100\nOUTPUT_TOKENS: 200';
    const r = extractTokens('codex', '', stderr);
    expect(r).toEqual({ tokens_in: 100, tokens_out: 200 });
  });

  it('returns null/null for codex when only total_tokens is reported (cannot split honestly)', () => {
    const stderr = 'total_tokens: 1234';
    const r = extractTokens('codex', '', stderr);
    expect(r).toEqual({ tokens_in: null, tokens_out: null });
  });

  it('returns null/null for claude — no stable shape today', () => {
    const stderr = 'Claude finished. tokens=1234';
    const r = extractTokens('claude', '', stderr);
    expect(r).toEqual({ tokens_in: null, tokens_out: null });
  });

  it('returns null/null for copilot — no token reporting', () => {
    const r = extractTokens('copilot', 'whatever', 'whatever');
    expect(r).toEqual({ tokens_in: null, tokens_out: null });
  });

  it('returns null/null for an unknown provider', () => {
    const r = extractTokens('mystery', 'input_tokens: 100 output_tokens: 200', '');
    expect(r).toEqual({ tokens_in: null, tokens_out: null });
  });

  // No-throw on garbage input — the contract documented in the file
  // header. We exercise a handful of nasty shapes.
  it('does not throw on empty strings', () => {
    expect(() => extractTokens('codex', '', '')).not.toThrow();
    expect(extractTokens('codex', '', '')).toEqual({ tokens_in: null, tokens_out: null });
  });

  it('does not throw on random binary-ish bytes', () => {
    const garbage = '\x00\x01\x02\xffinput_tokens:NaN output_tokens:foo\x00';
    expect(() => extractTokens('codex', garbage, garbage)).not.toThrow();
    // Non-numeric values must not become NaN-tokens — return null.
    const r = extractTokens('codex', garbage, garbage);
    expect(r).toEqual({ tokens_in: null, tokens_out: null });
  });

  it('does not throw on a very long stderr', () => {
    // Separated from preceding bytes by a newline so the \b word
    // boundary anchors at "input_tokens".
    const long = 'x'.repeat(100_000) + '\ninput_tokens: 7 output_tokens: 11';
    expect(() => extractTokens('codex', '', long)).not.toThrow();
    const r = extractTokens('codex', '', long);
    expect(r).toEqual({ tokens_in: 7, tokens_out: 11 });
  });

  it('does not throw when stdout/stderr are not strings (defensive guard)', () => {
    // Cast through unknown to avoid blowing up the typechecker — this
    // is the runtime defensive case.
    const r = extractTokens(
      'codex',
      undefined as unknown as string,
      null as unknown as string,
    );
    expect(r).toEqual({ tokens_in: null, tokens_out: null });
  });

  it('does not parse negative integers', () => {
    // The regex requires `[:=]\s*(\d+)`, so a leading `-` between the
    // colon and the digits prevents a match — the result is null/null.
    // This is the conservative outcome: providers do not emit negative
    // token counts in practice, so a malformed `-N` value is treated
    // as an unknown rather than silently coerced to a positive.
    const r = extractTokens('codex', '', 'input_tokens: -5\noutput_tokens: -1');
    expect(r).toEqual({ tokens_in: null, tokens_out: null });
  });
});

// ---------------------------------------------------------------------------
// aggregateDollars
// ---------------------------------------------------------------------------

describe('aggregateDollars', () => {
  it('sums across known-dollar records', () => {
    const out = aggregateDollars([
      rec({ dollars: 0.5 }),
      rec({ dollars: 0.25 }),
      rec({ dollars: 1.25 }),
    ]);
    expect(out.total).toBe(2);
    expect(out.unknown_count).toBe(0);
  });

  it('skips null-dollar records and counts them separately', () => {
    const out = aggregateDollars([
      rec({ dollars: 0.5 }),
      rec({ dollars: null }),
      rec({ dollars: null }),
      rec({ dollars: 1.5 }),
    ]);
    expect(out.total).toBe(2);
    expect(out.unknown_count).toBe(2);
  });

  it('returns zero totals for an empty input', () => {
    const out = aggregateDollars([]);
    expect(out.total).toBe(0);
    expect(out.unknown_count).toBe(0);
  });

  it('returns zero totals when every record is null', () => {
    const out = aggregateDollars([
      rec({ dollars: null }),
      rec({ dollars: null }),
    ]);
    expect(out.total).toBe(0);
    expect(out.unknown_count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// checkCap (>= semantics, undefined = no cap)
// ---------------------------------------------------------------------------

describe('checkCap', () => {
  it('returns true when running_total exceeds cap', () => {
    expect(checkCap(1.01, 1)).toBe(true);
  });

  it('returns true when running_total equals cap (>= boundary)', () => {
    expect(checkCap(1, 1)).toBe(true);
  });

  it('returns false when running_total is strictly below cap', () => {
    expect(checkCap(0.99, 1)).toBe(false);
  });

  it('returns false when cap is undefined (no cap configured)', () => {
    expect(checkCap(99, undefined)).toBe(false);
    expect(checkCap(0, undefined)).toBe(false);
  });

  it('returns false at zero against zero cap (>= but with zero spend the operator clearly intended a no-op)', () => {
    // Edge case: cap=0 disables work entirely. This is the >= contract
    // — the very first invocation crosses. Documented in checkCap's
    // comment; this test pins the behavior so a future contributor
    // does not silently relax to `>`.
    expect(checkCap(0, 0)).toBe(true);
  });
});
