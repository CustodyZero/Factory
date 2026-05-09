/**
 * Factory — Pipeline / Recovery (pure logic)
 *
 * Phase 6 of specs/single-entry-pipeline.md. Implements the
 * scenario-keyed recipe map per docs/decisions/recovery_recipes_not_dsl.md.
 *
 * This module is the PURE half of the recovery layer. It owns:
 *
 *   - the closed `FailureScenario` enum (8 variants)
 *   - the `FailureContext` shape that callers populate from a failed
 *     operation's exit_code / stderr / stdout / error
 *   - the `RecoveryAttempt` and `EscalateRequest` discriminated types
 *   - the `RecoveryResult<T>` discriminator returned by the orchestration
 *     layer to its callers — a TYPE-LEVEL guarantee that "escalation"
 *     is observable AND controlling, not a fact emitted into a void
 *   - `classifyFailure(...)`: pure pattern-matching from observable
 *     failure inputs to a scenario, or `null` when the failure cannot
 *     be honestly classified (the orchestration layer escalates
 *     immediately in that case — see CLAUDE.md §3.1 / §3.5)
 *   - `RECIPES`: the constant map from scenario to recipe function.
 *     Each recipe is a TypeScript function returning either a
 *     RecoveryAttempt (action to take) or an EscalateRequest (give up
 *     and write an escalation record).
 *   - `SCENARIO_RETRY_BUDGET`: per-scenario retry caps.
 *   - `EscalationRecord` and `tailString` for the on-disk shape.
 *
 * It has NO filesystem dependency by design: the I/O wrapper for
 * writing escalation records lives in `tools/recovery.ts`, and the
 * orchestration that wraps fail-prone calls in retry loops lives in
 * `tools/pipeline/recovery_loop.ts`. Same split as
 * `pipeline/events.ts` / `tools/events.ts` and `pipeline/cost.ts` /
 * `tools/cost.ts`.
 *
 * The classifier returning `null` for an unknown failure is HONEST
 * BEHAVIOR (CLAUDE.md §3.1, §3.5): we cannot recover what we cannot
 * recognize, so the loop escalates immediately rather than silently
 * retry on unknown error shapes.
 *
 * FORWARD-COMPAT FOR PHASE 7
 *
 * The `ProviderUnavailable` recipe currently escalates immediately
 * with a Phase-7-deferred reason. Phase 7 will replace this single
 * function with the cross-CLI / within-CLI cascade. The replacement
 * is a one-line edit to RECIPES — no other file in the recovery
 * layer needs to change.
 *
 * STATE-MACHINE-INTEGRATION CONTRACT
 *
 * The previous attempt at Phase 6 (reverted) made the recovery layer
 * observable (events fired, escalations were written) but NOT
 * controlling: the calling state machines logged the escalation and
 * unconditionally advanced. The fix in this attempt: the orchestration
 * layer returns a `RecoveryResult<T>` discriminator. Every wrapping
 * call site MUST dispatch on `kind`. The compiler enforces this at
 * the boundary — "observable but not controlling" is now a type error.
 */

// ---------------------------------------------------------------------------
// Failure scenarios — closed enum.
//
// Eight variants per docs/decisions/single_entry_pipeline.md §Recovery
// scope table. The names match the table verbatim so the spec and
// the code use the same vocabulary.
// ---------------------------------------------------------------------------

export type FailureScenario =
  | 'ProviderTransient'
  | 'ProviderUnavailable'
  | 'BuildFailed'
  | 'LintFailed'
  | 'TestFailed'
  | 'StaleBranch'
  | 'AgentNonResponsive'
  | 'CompletionGateBlocked';

/**
 * The set of all known scenarios as a runtime-iterable array. The
 * RECIPES map below has an entry for every member; runtime tests
 * iterate this list to confirm completeness without re-asserting
 * each name.
 */
export const ALL_SCENARIOS: ReadonlyArray<FailureScenario> = [
  'ProviderTransient',
  'ProviderUnavailable',
  'BuildFailed',
  'LintFailed',
  'TestFailed',
  'StaleBranch',
  'AgentNonResponsive',
  'CompletionGateBlocked',
];

// ---------------------------------------------------------------------------
// FailureContext — the input the classifier and recipes consume.
//
// The shape is intentionally narrow: every field is something the
// caller can supply from observable outputs of a failed operation
// (subprocess result, lifecycle library throw, etc.). No file paths,
// no global state, no configuration — recipes are pure functions of
// this struct.
//
// The optional `kind` hint is set by the call site when it knows
// which class of operation failed (agent invocation vs verification
// vs git rebase). This is what makes the BuildFailed/LintFailed/
// TestFailed dispatch unambiguous: a test-execution failure could
// otherwise be confused with a build failure that mentioned tests
// in its output.
// ---------------------------------------------------------------------------

/**
 * What kind of operation produced this failure. The caller supplies
 * this as a hint that the classifier respects when present. Optional
 * so call sites that don't know can omit it — the classifier falls
 * back to text-pattern matching.
 *
 *   - `agent_invocation`: an `invokeAgent` call returned non-zero
 *     and/or surfaced a network/transport error
 *   - `verification`: a `complete.ts` (or equivalent) call reported
 *     build/lint/test failure
 *   - `git`: a git operation (rebase, fetch) failed, OR a lifecycle
 *     script throw was identified by its caller as stale-branch text
 *   - `lifecycle`: a non-verification lifecycle call (start,
 *     request_review, review) threw
 */
export type FailureKind =
  | 'agent_invocation'
  | 'verification'
  | 'git'
  | 'lifecycle';

export interface FailureContext {
  /** Subprocess exit code or `null` if the failure was a thrown error. */
  readonly exit_code: number | null;
  /** Captured stdout from the failed operation, or empty string. */
  readonly stdout: string;
  /** Captured stderr from the failed operation, or empty string. */
  readonly stderr: string;
  /** Thrown Error message, if the operation threw rather than exited non-zero. */
  readonly error_message: string | null;
  /** Operation kind, when known. See FailureKind doc. */
  readonly kind?: FailureKind;
  /**
   * For `verification` failures, which checks failed. Caller fills
   * this from the CompleteResult shape. Empty array means "unknown
   * which check failed"; the classifier then falls back to stderr
   * matching.
   */
  readonly failed_checks?: ReadonlyArray<'build' | 'lint' | 'tests' | 'ci'>;
  /** Spec id, when known. Carried into events/escalation records. */
  readonly spec_id?: string | null;
  /** Packet id, when known. Carried into events/escalation records. */
  readonly packet_id?: string | null;
  /**
   * Free-form provenance label for the operation that failed. Goes
   * into the escalation record so a human reading it can locate the
   * call site. Examples: "develop_phase.implement",
   * "verify_phase.complete", "plan_phase.invoke_planner".
   */
  readonly operation_label?: string;
  /**
   * Phase 7 — the persona's full ordered cascade for the call site
   * that produced this failure. Computed once by the closure (via
   * `computeCascade(persona, tier, config)`) and threaded through
   * unchanged on every retry. The `ProviderUnavailable` recipe reads
   * this list to pick the next failover step; on exhaustion the
   * recipe escalates with a reason naming the attempted cascade.
   *
   * Optional because most call sites do NOT compute a cascade
   * (BuildFailed / StaleBranch / non-agent operations). Recipes
   * other than `ProviderUnavailable` ignore this field.
   *
   * When present, `cascade[0]` is the primary (already-attempted)
   * step; the next step to try is `cascade[cascade_attempt_index + 1]`.
   * See `cascade_attempt_index` below for the indexing contract.
   */
  readonly cascade?: ReadonlyArray<{
    readonly provider: import('../config.js').PipelineProvider;
    readonly model: string | undefined;
  }>;
  /**
   * Phase 7 — the cascade index of the most-recently-attempted step.
   * The recovery_loop populates this just before calling the
   * `ProviderUnavailable` recipe (or any recipe that might consult
   * the cascade). Index 0 is the primary; after the primary fails
   * the loop sets this to 0 and the recipe returns cascade[1] as
   * the next hop. After cascade[1] fails the loop sets it to 1,
   * and so on.
   *
   * Recipes that do not consult `cascade` ignore this field. The
   * loop never sets this on the initial classification call (the
   * primary attempt has not "happened" yet from the recipe's point
   * of view) — only on the retry-classification path.
   */
  readonly cascade_attempt_index?: number;
}

// ---------------------------------------------------------------------------
// Recipe outputs — RecoveryAttempt | EscalateRequest discriminated union.
//
// A recipe's job is to look at one (scenario, context) pair and
// produce ONE of two outputs:
//
//   - RecoveryAttempt: "try this remediation, then re-run the
//     original operation." The orchestration layer
//     (recovery_loop.ts) executes the action, decrements the budget,
//     and re-invokes the wrapped op.
//
//   - EscalateRequest: "give up. Write a structured failure record
//     and surface a typed escalation discriminator to the caller."
// ---------------------------------------------------------------------------

/**
 * The kind of remediation a recipe can request.
 *
 *   - `retry_same`: re-run the original operation as-is. Used for
 *     truly transient failures where waiting + re-trying is the
 *     right move (network blip, 429, etc.).
 *   - `retry_with_guardrail_prompt`: re-run the developer agent with
 *     the failure output appended and an explicit "do not modify
 *     tests/build/lint config" guardrail. Used by BuildFailed.
 *   - `git_rebase_then_retry`: run `git fetch && git rebase
 *     origin/main` from the worktree; on success, re-run the
 *     original operation. Used by StaleBranch.
 *   - `cascade_provider`: re-run the operation against a different
 *     (provider, model) pair, supplied via `RecoveryAttempt.cascade`.
 *     Used by ProviderUnavailable to walk the cross-CLI / within-CLI
 *     failover order computed by `computeCascade`. Phase 7.
 *
 * The orchestration layer maps each kind to a concrete sequence of
 * I/O calls. Adding a new kind requires updating both this enum
 * AND the dispatch in recovery_loop.ts AND the closures in
 * `plan_phase.ts` / `develop_phase.ts` / `verify_phase.ts`.
 */
export type RecoveryActionKind =
  | 'retry_same'
  | 'retry_with_guardrail_prompt'
  | 'git_rebase_then_retry'
  | 'cascade_provider';

export interface RecoveryAttempt {
  readonly kind: 'attempt';
  readonly action: RecoveryActionKind;
  /**
   * Optional human-readable context for the action. For
   * retry_with_guardrail_prompt, this is the prompt suffix the loop
   * must append to the next agent invocation. For other actions,
   * informational only.
   */
  readonly guardrail_prompt?: string;
  /**
   * For retry_same and retry_with_guardrail_prompt, optional wait
   * time in milliseconds before retrying. Used by ProviderTransient
   * to back off briefly. Default (when omitted) is no wait.
   */
  readonly wait_ms?: number;
  /**
   * For action='cascade_provider', the (provider, model) pair the
   * closure must use on the next attempt — bypassing the persona's
   * default provider/tier resolution. The closure passes these
   * through to `invokeAgent(provider, prompt, config, modelTier?,
   * model)`. Phase 7.
   *
   * Required when `action === 'cascade_provider'`; ignored otherwise.
   * The recipe always populates this when it returns
   * cascade_provider.
   */
  readonly cascade?: {
    readonly provider: import('../config.js').PipelineProvider;
    readonly model: string | undefined;
  };
}

export interface EscalateRequest {
  readonly kind: 'escalate';
  readonly reason: string;
}

export type RecipeOutput = RecoveryAttempt | EscalateRequest;

/**
 * Recipe shape per docs/decisions/recovery_recipes_not_dsl.md.
 *
 * Each recipe is a pure function of (scenario, context). The
 * scenario argument is technically redundant (each recipe lives at a
 * known key in RECIPES) but we pass it anyway so a recipe can be
 * lifted out and inspected/tested in isolation, and so a future
 * shared recipe — if any — can branch on it.
 */
export type RecoveryRecipe = (
  scenario: FailureScenario,
  context: FailureContext,
) => RecipeOutput;

// ---------------------------------------------------------------------------
// EscalationRecord — the on-disk shape (defined here in the pure
// module so callers construct it once; the I/O wrapper just
// serializes whatever shape it is handed).
// ---------------------------------------------------------------------------

export interface EscalationRecord {
  readonly scenario: FailureScenario | 'Unclassified';
  readonly reason: string;
  readonly spec_id: string | null;
  readonly packet_id: string | null;
  readonly operation_label: string | null;
  readonly attempts: number;
  readonly run_id: string;
  readonly timestamp: string;
  /** Failure context truncated to keep the file readable. */
  readonly failure: {
    readonly exit_code: number | null;
    readonly stderr_tail: string;
    readonly stdout_tail: string;
    readonly error_message: string | null;
  };
}

/**
 * Truncate a possibly-large output buffer to a fixed tail. Pure
 * helper exposed for use by recovery_loop.ts when it builds the
 * EscalationRecord. Keeps the on-disk file bounded in size.
 */
export function tailString(s: string, maxBytes: number): string {
  if (s.length <= maxBytes) return s;
  return s.slice(s.length - maxBytes);
}

// ---------------------------------------------------------------------------
// RecoveryResult<T> — the discriminator the orchestration layer
// returns to its callers.
//
// THIS TYPE IS THE LOAD-BEARING DESIGN of Phase 6 (revised). The
// previous attempt returned `T` plus emitted events; the calling
// state machine ignored both. With this discriminator, the calling
// state machine MUST switch on `kind` to read `value` — and the
// `escalated` branch carries enough context for the caller to mark
// the packet failed, emit `packet.failed`, and break the per-packet
// state machine. The compiler enforces "observable AND controlling".
//
//   - `kind: 'ok'` — operation succeeded (initial OR after retry).
//     Caller reads `value` and advances state.
//   - `kind: 'escalated'` — recovery has given up. The escalation
//     record was written; the four-event sequence emitted; the
//     scenario, reason, and the in-memory EscalationRecord are
//     surfaced to the caller. The caller MUST stop the per-packet
//     state machine (mark packet failed, emit packet.failed, break).
//
// Note: this is NOT the same as the recipe-output union. Recipes
// produce `RecoveryAttempt | EscalateRequest`; the orchestration
// loop consumes those and produces `RecoveryResult<T>` for the
// surrounding state machine.
// ---------------------------------------------------------------------------

export type RecoveryResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | {
      readonly kind: 'escalated';
      readonly scenario: FailureScenario | 'Unclassified';
      readonly reason: string;
      readonly attempts: number;
      readonly escalation: EscalationRecord;
      readonly escalation_path: string | null;
    };

// ---------------------------------------------------------------------------
// classifyFailure — pure pattern-matcher from observable failure
// inputs to a FailureScenario, or null when no honest classification
// is possible.
//
// Order of decisions:
//   1. If the caller supplied `kind === 'verification'` and a
//      non-empty `failed_checks` list, use that authoritatively.
//   2. If the caller supplied `kind === 'git'`, look for stale-branch /
//      rebase markers in stderr; if present -> StaleBranch.
//   3. ProviderUnavailable BEFORE ProviderTransient: the patterns are
//      narrow and authoritative ("provider disabled / not configured /
//      model not found"). Without this ordering a "Provider X is
//      disabled" stderr could superficially match a transient pattern
//      and burn the ProviderTransient budget retrying a fundamentally
//      unavailable CLI.
//   4. ProviderTransient: 5xx / 429 / connection error / timeout.
//   5. Completion-gate / FI-7 markers in stderr.
//   6. Build/lint/test text matching when no kind hint was supplied
//      (the verification call site should always supply the hint, but
//      unit tests exercise the fallback).
//   7. exit_code != 0 with empty stdout AND empty stderr from an
//      agent_invocation -> AgentNonResponsive.
//   8. Anything else -> null. The orchestration layer treats null as
//      "escalate immediately" — we do NOT silently retry unknowns.
// ---------------------------------------------------------------------------

const TRANSIENT_PATTERNS: ReadonlyArray<RegExp> = [
  /\bHTTP\s*5\d{2}\b/i,
  /\b5\d{2}\s*(Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i,
  /\b429\b/, // rate limited
  /\brate[-_ ]?limit(ed|ing)?\b/i,
  /\bECONN(REFUSED|RESET|ABORTED)\b/,
  /\bETIMEDOUT\b/,
  /\bENOTFOUND\b/,
  /\bEAI_AGAIN\b/,
  /\bENETUNREACH\b/,
  /\bEHOSTUNREACH\b/,
  /\bsocket hang up\b/i,
  /\b(connection|network)\s+(timeout|reset|refused|error|aborted)\b/i,
  /\brequest timed? out\b/i,
];

/**
 * ProviderUnavailable patterns. These match cases where the CLI / model
 * is not available for invocation at all — distinct from a single call
 * timing out (ProviderTransient).
 *
 * The first three strings are produced verbatim by the early-return
 * branches in `tools/pipeline/agent_invoke.ts`:
 *
 *   - "Pipeline config not found"            (config.pipeline === undefined)
 *   - "Provider 'X' not configured"          (no providers[X] entry)
 *   - "Provider 'X' is disabled"             (providers[X].enabled === false)
 *
 * The model-unavailable patterns cover the case where the CLI itself
 * runs but the configured model id is rejected by the provider. We
 * treat this as ProviderUnavailable rather than ProviderTransient
 * because no amount of retrying the same call will help; the operator
 * (Phase 7) needs to fail over to a different provider.
 *
 * Order matters: this list is consulted BEFORE TRANSIENT_PATTERNS in
 * classifyFailure so a "provider disabled" stderr cannot be confused
 * with a 5xx blip.
 */
const PROVIDER_UNAVAILABLE_PATTERNS: ReadonlyArray<RegExp> = [
  /Provider '[^']*' is disabled/,
  /Provider '[^']*' not configured/,
  /Pipeline config not found/,
  /\bmodel[^.\n]*\bnot found\b/i,
  /\bmodel[^.\n]*\bunavailable\b/i,
];

/**
 * STALE_BRANCH_PATTERNS — exported so a cross-layer drift test can
 * confirm that every lifecycle stale-branch text matches a classifier
 * pattern. The lifecycle layer keeps a duplicated subset (no upward
 * import); the cross-layer test pins them in sync.
 */
export const STALE_BRANCH_PATTERNS: ReadonlyArray<RegExp> = [
  /\byour branch is behind\b/i,
  /\bnon[- ]fast[- ]forward\b/i,
  /\b(updates were|hint:.+) rejected because.+behind\b/i,
  /\brebase (in progress|conflict|failed)\b/i,
  /\bcannot rebase: you have unstaged changes\b/i,
  /\bbranch is behind ['"]?origin\/main['"]?\b/i,
  /\bfailed to push some refs\b/i,
];

const COMPLETION_GATE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bFI-7\b/,
  /\bcompletion[- ]gate\b/i,
  /\bpre[- ]commit hook (failed|rejected|blocked)\b/i,
];

const BUILD_FAILED_PATTERNS: ReadonlyArray<RegExp> = [
  /\bbuild (failed|error)\b/i,
  /\btsc\b.*\berror\s+TS\d+/i,
  /\berror\s+TS\d+:/,
  /\bcompil(ation|er)\s+error\b/i,
];

const LINT_FAILED_PATTERNS: ReadonlyArray<RegExp> = [
  /\beslint\b/i,
  /\blint(ing)?\s+(failed|error|errors|problems?)\b/i,
];

const TEST_FAILED_PATTERNS: ReadonlyArray<RegExp> = [
  /\btests? (failed|fail)\b/i,
  /\bvitest\b.*\b(failed|fail)\b/i,
  /\bjest\b.*\b(failed|fail)\b/i,
  /\b\d+\s+failed\b.*\btests?\b/i,
  /\bFAIL\b\s+.*\.test\.[jt]sx?\b/,
];

function anyMatch(patterns: ReadonlyArray<RegExp>, ...haystacks: string[]): boolean {
  for (const h of haystacks) {
    if (h.length === 0) continue;
    for (const p of patterns) {
      if (p.test(h)) return true;
    }
  }
  return false;
}

/**
 * Classify a failure into a FailureScenario, or return null when no
 * honest classification is possible.
 *
 * The contract of `null` is critical: it does NOT mean "treat as
 * transient" or "use a default scenario." It means "we do not know
 * how to handle this, escalate immediately." Silently retrying
 * unknown failures would invite the failure modes recovery exists to
 * prevent (CLAUDE.md §3.1).
 *
 * Pure: no I/O, no globals, no time. Same inputs, same output.
 */
export function classifyFailure(context: FailureContext): FailureScenario | null {
  const stderr = context.stderr ?? '';
  const stdout = context.stdout ?? '';
  const errorMsg = context.error_message ?? '';

  // (1) Authoritative verification dispatch when the caller knows.
  if (context.kind === 'verification') {
    const failed = context.failed_checks ?? [];
    if (failed.includes('build')) return 'BuildFailed';
    if (failed.includes('lint')) return 'LintFailed';
    if (failed.includes('tests')) return 'TestFailed';
    // ci-only failure with no explicit sub-check is ambiguous; fall
    // through to text matching rather than guessing build vs lint.
  }

  // (2) Git operations: stale branch markers.
  if (context.kind === 'git') {
    if (anyMatch(STALE_BRANCH_PATTERNS, stderr, stdout, errorMsg)) {
      return 'StaleBranch';
    }
    // A non-stale-branch git failure (permission, missing repo) is
    // not in the recovery scope. Return null -> escalate.
    return null;
  }

  // (3) ProviderUnavailable BEFORE ProviderTransient. These patterns
  // mean "the CLI itself is unavailable" (config missing, provider
  // disabled, model not found) — fundamentally different from a 5xx
  // / 429 / network blip. The Phase 6 recipe escalates immediately
  // (cascade lives in Phase 7); checking these first prevents a
  // "Provider 'X' is disabled" stderr from being misclassified as
  // a transient failure that retries fruitlessly until budget
  // exhaustion.
  if (anyMatch(PROVIDER_UNAVAILABLE_PATTERNS, stderr, stdout, errorMsg)) {
    return 'ProviderUnavailable';
  }

  // (4) Provider transient.
  if (anyMatch(TRANSIENT_PATTERNS, stderr, stdout, errorMsg)) {
    return 'ProviderTransient';
  }

  // (5) Completion-gate / FI-7 markers.
  if (anyMatch(COMPLETION_GATE_PATTERNS, stderr, stdout, errorMsg)) {
    return 'CompletionGateBlocked';
  }

  // (6) Verification text matching when the kind hint was missing or
  // ci-only. Order: build before lint before tests because a project
  // that fails to build typically also reports a downstream lint
  // false-positive; the build failure is the root cause to surface.
  if (anyMatch(BUILD_FAILED_PATTERNS, stderr, stdout)) return 'BuildFailed';
  if (anyMatch(LINT_FAILED_PATTERNS, stderr, stdout)) return 'LintFailed';
  if (anyMatch(TEST_FAILED_PATTERNS, stderr, stdout)) return 'TestFailed';

  // (7) Empty-output non-zero exit from an agent invocation.
  if (
    context.kind === 'agent_invocation' &&
    context.exit_code !== null &&
    context.exit_code !== 0 &&
    stdout.length === 0 &&
    stderr.length === 0
  ) {
    return 'AgentNonResponsive';
  }

  // (8) Honest unknown.
  return null;
}

// ---------------------------------------------------------------------------
// RECIPES — the constant map.
//
// Each entry is a pure function. The map shape is intentional so the
// orchestrator can look up `RECIPES[scenario]` directly; no class
// hierarchy, no factory.
//
// PHASE 7 NOTE: `ProviderUnavailable` here ESCALATES IMMEDIATELY
// with a deferred-implementation reason. Phase 7 will replace this
// single function with the cross-CLI / within-CLI cascade — the
// rest of the recovery layer is unaffected by that change.
// ---------------------------------------------------------------------------

/**
 * The guardrail prompt suffix appended to the developer agent's next
 * invocation when retrying after a BuildFailed. Pinned here as a
 * single string so the unit test can assert on the exact text.
 *
 * The wording mirrors docs/decisions/single_entry_pipeline.md
 * §Recovery scope table for BuildFailed.
 */
export const BUILD_GUARDRAIL_PROMPT =
  'The previous implementation failed the build. Fix the implementation. ' +
  'Do not modify tests, build configuration, or lint configuration to make the build pass.';

const recipeProviderTransient: RecoveryRecipe = (_scenario, _ctx) => ({
  kind: 'attempt',
  action: 'retry_same',
  // Brief back-off so a momentary network blip has time to clear.
  wait_ms: 250,
});

/**
 * Phase 7 — ProviderUnavailable cascade recipe.
 *
 * Consults the cascade computed at the call site
 * (`context.cascade`) and returns either:
 *
 *   - `RecoveryAttempt` with `action: 'cascade_provider'` and the
 *     next (provider, model) pair, when the cascade is not yet
 *     exhausted.
 *   - `EscalateRequest` when the cascade is exhausted (or absent —
 *     the call site supplied no cascade).
 *
 * The recipe self-caps based on cascade length, NOT on
 * SCENARIO_RETRY_BUDGET. The orchestration layer's per-scenario
 * budget for ProviderUnavailable is therefore a high sentinel (see
 * SCENARIO_RETRY_BUDGET); the data-driven cap lives here so the
 * cascade-length contract stays in one place. Any future change to
 * "how many cascade hops are allowed" is a change to this recipe
 * and to `computeCascade`, not to the budget map.
 *
 * Indexing contract:
 *   `cascade[0]` is the PRIMARY (already-attempted) step. The
 *   `cascade_attempt_index` field on the failure context tracks
 *   the most-recently-attempted index. After cascade[N] fails, the
 *   loop sets cascade_attempt_index=N; the recipe returns
 *   cascade[N+1] (or escalates if N+1 >= cascade.length).
 *
 * On the FIRST ProviderUnavailable failure, the loop has not yet
 * set cascade_attempt_index — it defaults to 0 (the primary just
 * failed). So the first call to this recipe returns cascade[1].
 *
 * Pure: no I/O, no globals, no time. Same inputs, same output.
 */
const recipeProviderUnavailable: RecoveryRecipe = (_scenario, ctx) => {
  const cascade = ctx.cascade;
  if (cascade === undefined || cascade.length === 0) {
    // Call site supplied no cascade. Honest "we cannot fail over"
    // (CLAUDE.md §3.1): the persona has no failover declared OR the
    // call site is non-agent (planner planning isn't, but this can
    // happen if the closure is called outside the agent path). Escalate.
    return {
      kind: 'escalate',
      reason:
        'Provider unavailable: no cascade configured for this persona ' +
        '(persona_providers list of length 1 with no model_failover, or ' +
        'the call site did not compute a cascade).',
    };
  }
  // The "current" attempted index. On the first call (after the
  // primary failed) this is 0. The next step to try is index+1.
  const lastAttempted = ctx.cascade_attempt_index ?? 0;
  const nextIndex = lastAttempted + 1;
  if (nextIndex >= cascade.length) {
    // Cascade exhausted. Escalate with a reason naming the full
    // attempted list so a human reading the escalation record can
    // see exactly what was tried.
    const attempted = cascade
      .map((s) => `${s.provider}${s.model !== undefined ? `:${s.model}` : ''}`)
      .join(', ');
    return {
      kind: 'escalate',
      reason:
        `Provider unavailable: cascade exhausted after ${cascade.length} ` +
        `attempt(s). Tried: [${attempted}].`,
    };
  }
  const next = cascade[nextIndex]!;
  return {
    kind: 'attempt',
    action: 'cascade_provider',
    cascade: { provider: next.provider, model: next.model },
  };
};

const recipeBuildFailed: RecoveryRecipe = (_scenario, ctx) => {
  // Append a short tail of the failure output so the developer agent
  // sees the actual error text. Truncate to keep the prompt within
  // CLI argv limits.
  const tail = (ctx.stderr || ctx.stdout || ctx.error_message || '').slice(0, 4000);
  return {
    kind: 'attempt',
    action: 'retry_with_guardrail_prompt',
    guardrail_prompt: tail.length > 0
      ? `${BUILD_GUARDRAIL_PROMPT}\n\nBuild output:\n${tail}`
      : BUILD_GUARDRAIL_PROMPT,
  };
};

const recipeLintFailed: RecoveryRecipe = (_scenario, _ctx) => ({
  kind: 'escalate',
  reason:
    'Lint failure: always escalate. Auto-recovery would invite the agent to ' +
    'disable lint rules rather than fix code violations.',
});

const recipeTestFailed: RecoveryRecipe = (_scenario, _ctx) => ({
  kind: 'escalate',
  reason:
    'Test failure: always escalate. The agent has no mandate to decide ' +
    'whether tests are wrong or its implementation is wrong; humans decide.',
});

const recipeStaleBranch: RecoveryRecipe = (_scenario, _ctx) => ({
  kind: 'attempt',
  action: 'git_rebase_then_retry',
});

const recipeAgentNonResponsive: RecoveryRecipe = (_scenario, _ctx) => ({
  kind: 'attempt',
  action: 'retry_same',
  wait_ms: 250,
});

const recipeCompletionGateBlocked: RecoveryRecipe = (_scenario, _ctx) => ({
  kind: 'escalate',
  reason:
    'Completion gate blocked (FI-7 / pre-commit hook): cannot auto-recover. ' +
    'This is an intentional human gate.',
});

export const RECIPES: Readonly<Record<FailureScenario, RecoveryRecipe>> = {
  ProviderTransient: recipeProviderTransient,
  ProviderUnavailable: recipeProviderUnavailable,
  BuildFailed: recipeBuildFailed,
  LintFailed: recipeLintFailed,
  TestFailed: recipeTestFailed,
  StaleBranch: recipeStaleBranch,
  AgentNonResponsive: recipeAgentNonResponsive,
  CompletionGateBlocked: recipeCompletionGateBlocked,
};

// ---------------------------------------------------------------------------
// Per-scenario retry budget — pure data.
//
// "n retries" means n attempts AFTER the first failure. Budget is
// per-packet, per-scenario; see recovery_loop.ts for enforcement.
//
// All numbers come straight from the brief.
//
// EXCEPTION — ProviderUnavailable:
//   The cap is fully data-driven (= cascade length - 1, where the
//   cascade is attached to the FailureContext at the call site).
//   The recipe self-caps via `cascade_attempt_index`: when the
//   index exceeds `cascade.length - 1` it returns an `escalate`
//   output naming the exhausted cascade. The orchestration layer
//   honors this by SKIPPING the per-scenario budget check entirely
//   when the scenario is ProviderUnavailable (see recovery_loop.ts).
//
//   We deliberately set this entry to 0 so any code path that
//   *did* consult it (in violation of the contract) would
//   short-circuit on the very first hop — failing loudly at the
//   typecheck/test boundary rather than letting an off-by-one cap
//   silently bound the cascade. The orchestration layer's
//   ProviderUnavailable branch is the authoritative bound.
//
//   Round-2 fix: previously we set this to a "high sentinel" (99)
//   and relied on the assumption that no realistic config would
//   produce a cascade longer than 99. The schema had no maxItems
//   constraint, making that assumption unenforced. Option A
//   (preferred): remove the sentinel; let the recipe self-cap;
//   give the orchestration loop a dynamic safety bound based on
//   the actual cascade length. See docs/decisions/single_entry_pipeline.md.
// ---------------------------------------------------------------------------

export const SCENARIO_RETRY_BUDGET: Readonly<Record<FailureScenario, number>> = {
  ProviderTransient: 2,
  AgentNonResponsive: 2,
  BuildFailed: 1,
  StaleBranch: 1,
  // Phase 7 round-2 — the orchestration layer SKIPS this check for
  // ProviderUnavailable; the recipe self-caps via cascade length.
  // The 0 here is intentional: any caller that consults this map
  // for ProviderUnavailable is violating the contract and should
  // observe a failure on the first hop.
  ProviderUnavailable: 0,
  LintFailed: 0,
  TestFailed: 0,
  CompletionGateBlocked: 0,
};
