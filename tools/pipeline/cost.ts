/**
 * Factory — Pipeline / Cost (pure logic)
 *
 * Phase 5.7 of specs/single-entry-pipeline.md. Implements
 * docs/decisions/cost_visibility.md.
 *
 * This module owns the pure cost-record types, the rate-card data,
 * and the pure functions that turn (provider, model, tokens) into
 * dollars or that detect a cap crossing. It has NO filesystem
 * dependency by design: the I/O wrapper for emission lives in
 * `tools/cost.ts`. The split mirrors `pipeline/events.ts` (pure)
 * vs `tools/events.ts` (I/O).
 *
 * SCOPE
 *
 *   - Default rate cards per (provider, model). The defaults are
 *     point-in-time published rates (USD per million tokens). They
 *     can be partially overridden via `pipeline.rate_card` in
 *     `factory.config.json`.
 *   - `computeCost`: pure conversion of token counts to dollars.
 *     Returns `{ dollars: null }` when tokens are null OR when no
 *     rate-card entry exists for the (provider, model) pair. This
 *     is honest "we do not know" — NOT a facade. See the function
 *     comment for the rationale.
 *   - `extractTokens`: pure provider-specific parser over the
 *     stdout/stderr that an agent CLI emits. Tolerates any input
 *     shape without throwing. Returns `{null,null}` when the format
 *     is not recognized (again: honest unknowns, not facades).
 *   - `aggregateDollars`: sum across cost records, skipping nulls
 *     and counting them separately so the operator can see how much
 *     cost is unaccounted for.
 *   - `checkCap`: `>=` semantics (running_total at-or-above cap is
 *     "crossed"). Returns false when cap is undefined.
 *
 * NON-SCOPE
 *
 *   - Filesystem reads or writes. See `tools/cost.ts`.
 *   - Cap-crossing event emission. See `tools/pipeline/events.ts`
 *     (the `makeCostCapCrossed` constructor) and the orchestrator /
 *     phase modules that decide when to emit.
 *   - Schema validation. The cost-record schema at
 *     `schemas/cost_record.schema.json` is documentation only,
 *     mirroring the Phase 4.6 decision.
 */

// ---------------------------------------------------------------------------
// Cost record (the on-disk JSONL row shape)
// ---------------------------------------------------------------------------

/**
 * One per-invocation cost row. Phase 6 retry budgets will read these
 * back to compute "this packet has already cost $X across N retries"
 * — the (run_id, packet_id, spec_id) tuple is what makes that
 * computation possible.
 *
 *   - `dollars` is null when tokens are null or no rate-card entry
 *     exists for (provider, model). Never silently zero — null is
 *     the honest signal that cost is unknown for this invocation.
 *   - `model` is null when the resolved model id is undefined.
 *     Different providers report tier→model mapping inconsistently.
 *   - `packet_id`/`spec_id` are null for invocations outside a
 *     packet/spec context (e.g. orchestrator-level planner calls,
 *     though today the planner always runs inside a spec).
 *   - `timestamp` is ISO-8601 (UTC).
 */
export interface CostRecord {
  readonly run_id: string;
  readonly packet_id: string | null;
  readonly spec_id: string | null;
  readonly provider: string;
  readonly model: string | null;
  readonly tokens_in: number | null;
  readonly tokens_out: number | null;
  readonly dollars: number | null;
  readonly timestamp: string;
}

// ---------------------------------------------------------------------------
// Rate cards
//
// Per-million-token USD rates. Partial overrides are merged on top of
// the defaults at config-load time; downstream callers see a single
// merged RateCard. The structure is intentionally a plain map keyed
// by provider then model so JSON config can mirror it directly.
// ---------------------------------------------------------------------------

export interface ModelRate {
  /** USD per 1,000,000 input tokens. */
  readonly input_per_mtok: number;
  /** USD per 1,000,000 output tokens. */
  readonly output_per_mtok: number;
}

/**
 * A rate card. Outer key is provider, inner key is model id. Missing
 * entries (provider not present, OR model not present under provider)
 * mean "no rate known" and computeCost returns dollars: null.
 *
 * Keep the type readonly: callers never mutate the resolved rate card.
 */
export type RateCard = {
  readonly [provider: string]: {
    readonly [model: string]: ModelRate;
  };
};

/**
 * Default rate card. Point-in-time published rates as of the
 * implementation of Phase 5.7. These are intentionally conservative
 * — partial overrides via `factory.config.json#pipeline.rate_card`
 * let an operator pin tighter rates if they have negotiated pricing
 * or want to model a worst case.
 *
 * Rates are USD per 1,000,000 tokens, per Anthropic / OpenAI
 * published pricing. Copilot has no publicly listed token-based rate
 * here; we leave its entries undefined so dollars resolves to null
 * (honest unknown) rather than guessing.
 *
 * Keep this map narrow: only models the factory actually addresses
 * via its tier mappings appear here. New entries land alongside new
 * tier mappings.
 */
export const DEFAULT_RATE_CARD: RateCard = {
  claude: {
    'claude-opus-4-6': { input_per_mtok: 15, output_per_mtok: 75 },
    'claude-opus-4-7': { input_per_mtok: 15, output_per_mtok: 75 },
    'claude-sonnet-4-5': { input_per_mtok: 3, output_per_mtok: 15 },
    'claude-sonnet-4-6': { input_per_mtok: 3, output_per_mtok: 15 },
    'claude-haiku-4-5': { input_per_mtok: 0.8, output_per_mtok: 4 },
  },
  codex: {
    'gpt-5': { input_per_mtok: 5, output_per_mtok: 20 },
    'GPT-5.4': { input_per_mtok: 5, output_per_mtok: 20 },
    'GPT-5.5': { input_per_mtok: 5, output_per_mtok: 20 },
    'gpt-4o': { input_per_mtok: 2.5, output_per_mtok: 10 },
  },
  // copilot intentionally omitted: no public token-based rate.
};

/**
 * Produce a merged rate card: defaults overlaid with per-provider /
 * per-model overrides. `overrides` may be undefined or partial.
 * Callers in `tools/config.ts` resolve this once and pass the
 * resolved RateCard down to `computeCost`.
 */
export function mergeRateCard(overrides: RateCard | undefined): RateCard {
  if (overrides === undefined) return DEFAULT_RATE_CARD;
  const out: { [p: string]: { [m: string]: ModelRate } } = {};
  const providers = new Set<string>([
    ...Object.keys(DEFAULT_RATE_CARD),
    ...Object.keys(overrides),
  ]);
  for (const p of providers) {
    const base = DEFAULT_RATE_CARD[p] ?? {};
    const over = overrides[p] ?? {};
    out[p] = { ...base, ...over };
  }
  return out;
}

// ---------------------------------------------------------------------------
// computeCost — pure
// ---------------------------------------------------------------------------

/**
 * Convert token counts to dollars using the provided rate card.
 *
 * Returns `{ dollars: null }` in any of these cases:
 *
 *   - tokens_in is null OR tokens_out is null
 *   - model is undefined (we do not know which row of the card to use)
 *   - the rate card has no entry for (provider, model)
 *
 * Null is the honest "we do not know" signal. A null dollar value is
 * counted separately by `aggregateDollars` so the operator sees how
 * much cost is unaccounted for, but null does not contribute to a cap
 * threshold — the alternative (refusing to run when costs are unknown)
 * is too aggressive for providers like copilot that simply do not
 * report token counts.
 *
 * The math: `(tokens / 1_000_000) * rate_per_mtok`. We do not round
 * here; aggregation rounds for display only.
 */
export function computeCost(
  provider: string,
  model: string | undefined,
  tokens_in: number | null,
  tokens_out: number | null,
  rateCard: RateCard,
): { dollars: number | null } {
  if (tokens_in === null || tokens_out === null) return { dollars: null };
  if (model === undefined) return { dollars: null };
  const providerEntry = rateCard[provider];
  if (providerEntry === undefined) return { dollars: null };
  const rate = providerEntry[model];
  if (rate === undefined) return { dollars: null };
  const dollars =
    (tokens_in / 1_000_000) * rate.input_per_mtok +
    (tokens_out / 1_000_000) * rate.output_per_mtok;
  return { dollars };
}

// ---------------------------------------------------------------------------
// extractTokens — pure provider-specific parsers
// ---------------------------------------------------------------------------

/**
 * Parse a provider's stdout / stderr for the token counts it reports.
 *
 * NOT A FACADE: returning `{tokens_in: null, tokens_out: null}` for an
 * unrecognized format is the honest signal that the provider did not
 * report token counts (or did so in a shape we don't yet parse). The
 * alternative — refusing to record the invocation, or fabricating zero
 * tokens — would be dishonest. A null tokens_in/out propagates to a
 * null dollars (see computeCost), which the operator-facing aggregate
 * displays as "(N unknown-cost invocations)".
 *
 * MUST tolerate any input shape without throwing. We exercise this in
 * the cost.test.ts "garbage input" cases: random bytes, empty strings,
 * embedded NUL, very long strings — none may throw.
 *
 * Provider-specific extraction:
 *
 *   codex   — emits `tokens used: total=N input=N output=N` in stderr
 *             (the existing CLI wraps it with a banner; we look for
 *             both `total_tokens:` and the structured pair). We
 *             prefer the input/output split when present.
 *   claude  — does not emit token counts in --print mode today.
 *             Returns null/null. If a future Claude CLI version adds
 *             a recognizable shape, extend this branch.
 *   copilot — does not emit token counts. Returns null/null.
 *   default — anything else returns null/null.
 */
export function extractTokens(
  provider: string,
  stdout: string,
  stderr: string,
): { tokens_in: number | null; tokens_out: number | null } {
  // Defensive guard: callers should always pass strings, but we cannot
  // afford to throw from this function — see file header.
  if (typeof stdout !== 'string') stdout = '';
  if (typeof stderr !== 'string') stderr = '';

  try {
    switch (provider) {
      case 'codex':
        return extractCodexTokens(stdout, stderr);
      case 'claude':
        return extractClaudeTokens(stdout, stderr);
      case 'copilot':
        // Copilot does not report tokens. Honest unknown.
        return { tokens_in: null, tokens_out: null };
      default:
        return { tokens_in: null, tokens_out: null };
    }
  } catch {
    // Any unexpected error is treated as "we don't know".
    return { tokens_in: null, tokens_out: null };
  }
}

function extractCodexTokens(
  stdout: string,
  stderr: string,
): { tokens_in: number | null; tokens_out: number | null } {
  const haystack = `${stdout}\n${stderr}`;
  // Format A (preferred): `input_tokens: N`, `output_tokens: N`.
  const inMatch = /\binput[_-]?tokens\s*[:=]\s*(\d+)/i.exec(haystack);
  const outMatch = /\boutput[_-]?tokens\s*[:=]\s*(\d+)/i.exec(haystack);
  if (inMatch && outMatch) {
    return {
      tokens_in: parseSafeInt(inMatch[1]),
      tokens_out: parseSafeInt(outMatch[1]),
    };
  }
  // Format B (degraded): `total_tokens: N` only — we cannot split
  // input vs output, so we record the total under tokens_out and zero
  // for tokens_in. That is dishonest — instead, return null for both.
  // The honest signal is that we don't know the split.
  return { tokens_in: null, tokens_out: null };
}

function extractClaudeTokens(
  _stdout: string,
  _stderr: string,
): { tokens_in: number | null; tokens_out: number | null } {
  // Today's claude --print does not emit token counts in a stable
  // recognizable shape. Honest unknown.
  return { tokens_in: null, tokens_out: null };
}

function parseSafeInt(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

// ---------------------------------------------------------------------------
// aggregateDollars — pure
// ---------------------------------------------------------------------------

/**
 * Sum dollars across a list of cost records. Records with null
 * dollars are SKIPPED from the total and counted in `unknown_count`
 * so the caller can show "$X.YZ (N unknown-cost invocations)".
 */
export function aggregateDollars(
  records: ReadonlyArray<CostRecord>,
): { total: number; unknown_count: number } {
  let total = 0;
  let unknown_count = 0;
  for (const r of records) {
    if (r.dollars === null) {
      unknown_count += 1;
    } else {
      total += r.dollars;
    }
  }
  return { total, unknown_count };
}

// ---------------------------------------------------------------------------
// checkCap — pure
// ---------------------------------------------------------------------------

/**
 * Return true iff `running_total >= cap`. The semantics are `>=` (at-
 * or-above is "crossed") — this is the conservative choice: the very
 * invocation that ties the cap is the one that triggers the abort, so
 * a cap of $1.00 cannot be exceeded by a sequence of invocations that
 * each add up to exactly $1.00. The alternative (`>`) would let a
 * tied-at-cap run squeak through, which surprises operators.
 *
 * Returns false when `cap` is undefined (no cap configured).
 */
export function checkCap(running_total: number, cap: number | undefined): boolean {
  if (cap === undefined) return false;
  return running_total >= cap;
}

// ---------------------------------------------------------------------------
// Local-date helpers — pure
//
// Round-2 fix (Issue 2): per-day cost aggregation must classify each
// CostRecord by its LOCAL date, not by the UTC date encoded in its
// run-id filename. A run started at 23:00 in Phoenix (UTC-7) gets a
// run-id filename prefixed with the NEXT UTC day; the operator
// considers it "today" but the prior filename-prefix scan in
// readDayCost would miss it.
//
// These helpers stay in pipeline/cost.ts (pure layer) so the I/O
// wrapper in tools/cost.ts can compose them without inverting the
// boundary. Both functions are total and deterministic given a fixed
// system timezone — they read no env vars and perform no I/O.
// ---------------------------------------------------------------------------

/**
 * Format a UTC ISO-8601 timestamp as a YYYY-MM-DD string in LOCAL
 * time. Inverse-flavoured partner of `localDateString` (which takes
 * a Date directly).
 *
 * The intended use is per-record day-cap classification: the cap is
 * configured against the operator's working day, not against a UTC
 * day boundary. Reading the record's `timestamp` field (always UTC
 * ISO) and converting it to the local date here is what makes the
 * cap honest in non-UTC zones.
 *
 * Returns the empty string ("") when the timestamp does not parse —
 * a caller that compares against a real local-date string will never
 * accidentally match. The empty-string sentinel is honest: we cannot
 * classify an unparseable timestamp.
 */
export function localDateFromTimestamp(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Given a local YYYY-MM-DD, return the three UTC YYYY-MM-DD strings
 * that bracket it: the day before, the day of, and the day after.
 *
 * Why three: a record's UTC date can be at most ±1 calendar day away
 * from its local date in any earth-bound timezone (max offset is
 * UTC+14, min is UTC-12). So a record dated locally `2026-05-02` can
 * have a UTC date of `2026-05-01`, `2026-05-02`, or `2026-05-03` —
 * never anything else. readDayCost uses this window to bound the
 * candidate run-files it scans, keeping the work O(few-files) instead
 * of O(all-cost-files).
 *
 * Returns `['', localDate, '']` if `localDate` does not parse — a
 * caller filtering filename prefixes with `f.startsWith(`${''}T`)`
 * matches nothing, which is the safe degraded behaviour.
 */
export function utcDateWindow(localDate: string): [string, string, string] {
  // Parse the local date into a Date positioned at local midnight on
  // that day. We cannot construct the date directly from a UTC parse
  // (that would give us UTC midnight, which is the wrong day in
  // negative offsets); we use the y/m/d Date constructor which
  // interprets in local time.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (m === null) return ['', localDate, ''];
  const year = Number.parseInt(m[1]!, 10);
  const month = Number.parseInt(m[2]!, 10) - 1;
  const day = Number.parseInt(m[3]!, 10);
  const localMidnight = new Date(year, month, day, 0, 0, 0, 0);
  if (Number.isNaN(localMidnight.getTime())) return ['', localDate, ''];

  // Format a Date as UTC YYYY-MM-DD.
  const fmt = (d: Date): string => {
    const y = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
    const da = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${mo}-${da}`;
  };

  const today = fmt(localMidnight);
  const dayMs = 24 * 60 * 60 * 1000;
  // Use the local-midnight as our anchor and step ±1 calendar day at
  // the local-time level. Adding/subtracting 24h crosses one local-day
  // boundary; the resulting Date's UTC date is what we want for the
  // window edges. This is safe for DST: even on a 23h or 25h day the
  // resulting Date still lands inside the next/prior local day, and we
  // are taking only the UTC-date component — sub-day skew is irrelevant.
  const yesterdayLocal = new Date(year, month, day - 1, 0, 0, 0, 0);
  const tomorrowLocal = new Date(year, month, day + 1, 0, 0, 0, 0);
  // Defensive fallback: if the constructor produced an invalid date
  // (extreme inputs), fall back to a UTC-millis offset. Same end
  // result for normal inputs.
  const yesterday = Number.isNaN(yesterdayLocal.getTime())
    ? fmt(new Date(localMidnight.getTime() - dayMs))
    : fmt(yesterdayLocal);
  const tomorrow = Number.isNaN(tomorrowLocal.getTime())
    ? fmt(new Date(localMidnight.getTime() + dayMs))
    : fmt(tomorrowLocal);
  return [yesterday, today, tomorrow];
}
