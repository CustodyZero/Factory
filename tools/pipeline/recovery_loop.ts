/**
 * Factory — Pipeline / Recovery Loop (orchestration)
 *
 * Phase 6 of specs/single-entry-pipeline.md. The orchestration layer
 * that wraps fail-prone operations (`invokeAgent`, `completePacket`)
 * in retry loops with per-scenario budgets, cost-cap awareness, and
 * structured escalation.
 *
 * THIS IS THE IMPURE LAYER. It composes:
 *   - the pure classifier + recipes from `tools/pipeline/recovery.ts`
 *   - the I/O wrapper for escalation records in `tools/recovery.ts`
 *   - cap aggregation from `tools/cost.ts` (orchestration scope)
 *   - event emission via `tools/events.ts`
 *
 * The split keeps `tools/pipeline/recovery.ts` pure (no fs imports)
 * and confines side effects here.
 *
 * THE LOAD-BEARING CONTRACT
 *
 * `runWithRecovery(operation, ctx, options)` runs `operation`,
 * classifies any failure, and either retries (recipe says `attempt`)
 * or escalates (recipe says `escalate`, classifier returns `null`,
 * scenario budget is exhausted, or a retry would cross a configured
 * cost cap).
 *
 * Return shape is the `RecoveryResult<T>` discriminator from
 * `pipeline/recovery.ts`:
 *   - `{ kind: 'ok', value: T }` on success
 *   - `{ kind: 'escalated', scenario, reason, attempts, escalation,
 *       escalation_path }` on escalation
 *
 * EVERY caller MUST switch on `kind`. The compiler enforces it. The
 * previous Phase 6 attempt returned T plus emitted events; the calling
 * state machine ignored both. This contract makes "observable but not
 * controlling" a type error.
 *
 * BUDGET MODEL
 *
 * The budget is per-packet, per-scenario (no cross-scenario cap).
 * The caller passes a `budget` map (`PacketRecoveryBudget`) tracking
 * attempts USED so far in the current packet's lifetime. The map is
 * read-WRITE: this function increments the entry for the failed
 * scenario each time a retry is attempted. Persisting that map across
 * multiple `runWithRecovery` calls is the caller's responsibility —
 * see `newPacketRecoveryBudget`.
 *
 * COST-CAP INTERACTION
 *
 * Before each retry attempt, this function calls
 * `aggregateRunCost` and (if a per-day cap is configured) `readDayCost`.
 * If the running total is already at-or-above the relevant cap, the
 * retry is BLOCKED and recovery escalates with the cap-block reason.
 * Order of side effects on a cap-blocked path:
 *   cost.cap_crossed -> recovery.escalated -> writeEscalation.
 * This matches the Phase 5.7 ordering rule.
 *
 * EVENT ORDERING
 *
 *   First-attempt success: NO recovery.* events (silent stream).
 *
 *   Successful retry:
 *     recovery.attempt_started(2) -> (op runs) -> recovery.succeeded(2)
 *
 *   Exhausted budget:
 *     recovery.attempt_started(2) -> (fails) ->
 *     ... ->
 *     recovery.exhausted -> recovery.escalated
 *
 *   Cap-blocked retry:
 *     cost.cap_crossed -> recovery.escalated
 *
 *   Immediate escalate (recipe says escalate, OR classifier null):
 *     recovery.escalated  (no attempt_started — the retry was never
 *                           even attempted)
 *
 *   recovery.attempt_started fires ONLY on retry attempts (2+),
 *   never on the initial invocation. Streams with no recovery.*
 *   events mean "everything went normally" — the dominant case.
 */

import { spawnSync } from 'node:child_process';
import { appendEvent } from '../events.js';
import { aggregateRunCost, readDayCost } from '../cost.js';
import {
  makeCostCapCrossed,
  makeRecoveryAttemptStarted,
  makeRecoverySucceeded,
  makeRecoveryExhausted,
  makeRecoveryEscalated,
} from './events.js';
import { writeEscalation } from '../recovery.js';
import {
  ALL_SCENARIOS,
  RECIPES,
  SCENARIO_RETRY_BUDGET,
  classifyFailure,
  tailString,
  type EscalationRecord,
  type FailureContext,
  type FailureScenario,
  type RecipeOutput,
  type RecoveryActionKind,
  type RecoveryResult,
} from './recovery.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The mutable per-packet retry-budget map. Construct one with
 * `newPacketRecoveryBudget` at the start of a packet's lifecycle and
 * pass it to every `runWithRecovery` call within that packet. The
 * map tracks attempts USED per scenario; SCENARIO_RETRY_BUDGET is
 * the static cap.
 *
 * Key semantics:
 *   - Missing entry == 0 attempts used.
 *   - When (used >= SCENARIO_RETRY_BUDGET[scenario]) the next retry
 *     for that scenario is blocked and the result escalates.
 *
 * The map is mutable on purpose — the caller passes the same instance
 * across many runWithRecovery calls, and each call increments the
 * entry for the scenario it observed. A frozen / functional approach
 * would force every call to thread the new map back to the caller,
 * which adds plumbing for no observable benefit at this layer.
 */
export type PacketRecoveryBudget = Map<FailureScenario, number>;

export function newPacketRecoveryBudget(): PacketRecoveryBudget {
  return new Map<FailureScenario, number>();
}

/**
 * Result of a single git invocation.
 */
export interface GitRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runner contract for the StaleBranch action. Receives argv to pass
 * to git (e.g. `['fetch', 'origin']`, `['rebase', 'origin/main']`).
 * Implementations execute the command and capture output.
 *
 * The cwd argument is optional so a single runner instance can be
 * threaded through both this layer and the lifecycle layer's
 * `GitCheckRunner` (which always passes cwd). Structurally compatible
 * with `lifecycle/git_check.ts:GitCheckRunner`.
 */
export type GitRunner = (
  args: ReadonlyArray<string>,
  cwd?: string,
) => GitRunResult;

/**
 * Optional knobs for `runWithRecovery`. All are optional with safe
 * defaults so call sites stay terse.
 *
 *   - `disableRecovery`: when true, runs `operation` exactly once
 *     and returns its result with NO classification, NO retry, NO
 *     events. Intended for tests that want raw operation behavior
 *     without the recovery wrapper interceding. Default false.
 *   - `waitFn`: pluggable wait used between retries (mocked in
 *     tests). Default uses Atomics.wait (synchronous).
 *   - `perRunCap` / `perDayCap` / `today`: caller passes these from
 *     the resolved config. When undefined, the corresponding cap
 *     check is skipped.
 *   - `gitRunner`: pluggable git runner for the StaleBranch action.
 *     Tests inject a stub.
 */
export interface RunWithRecoveryOptions {
  readonly disableRecovery?: boolean;
  readonly waitFn?: (ms: number) => void;
  readonly perRunCap?: number | undefined;
  readonly perDayCap?: number | undefined;
  /** Local YYYY-MM-DD; required to make the per-day cap check meaningful. */
  readonly today?: string;
  readonly gitRunner?: GitRunner;
}

/**
 * Required context for a recovery-wrapped call. The caller threads
 * these through from the orchestrator/spec-runner. They never change
 * mid-call.
 */
export interface RunWithRecoveryContext {
  readonly runId: string;
  readonly artifactRoot: string;
  readonly dryRun: boolean;
  readonly specId: string | null;
  readonly packetId: string | null;
  /**
   * Free-form label identifying the call site (e.g.
   * "develop_phase.implement"). Goes into the escalation record.
   */
  readonly operationLabel: string;
  /** Per-packet recovery budget. Same instance across calls in a packet. */
  readonly budget: PacketRecoveryBudget;
}

/**
 * The shape an operation must return so the loop can detect failure
 * and classify it. The caller wraps a heterogeneous I/O call (e.g.
 * `invokeAgent` returns InvokeResult; `completePacket` returns
 * CompleteResult) into this normalized envelope.
 *
 * Why a discriminated value instead of throwing: failure-by-throw
 * loses the structured outputs (exit_code, stderr) that the
 * classifier needs.
 */
export type OperationResult<T> =
  | { readonly outcome: 'ok'; readonly value: T }
  | {
      readonly outcome: 'fail';
      readonly failure: FailureContext;
    };

/**
 * The operation closure. Receives an `attempt` argument:
 *
 *   - `attempt.attemptNumber`: 1 for the initial call; 2+ for retries.
 *   - `attempt.action`: the RecoveryActionKind requested for this
 *     attempt (undefined on the initial call). The closure can branch
 *     on this to apply the action's prerequisite (e.g. invoke the
 *     dev agent for a BuildFailed remediation in QA flow).
 *   - `attempt.guardrailPrompt`: when the action is
 *     retry_with_guardrail_prompt, the prompt suffix to append.
 *   - `attempt.cascade`: when the action is `cascade_provider`, the
 *     (provider, model) pair the closure must invoke against,
 *     bypassing the persona's default provider/tier. Phase 7.
 */
export interface AttemptContext {
  readonly attemptNumber: number;
  readonly action?: RecoveryActionKind;
  readonly guardrailPrompt?: string;
  readonly cascade?: {
    readonly provider: import('../config.js').PipelineProvider;
    readonly model: string | undefined;
  };
}

export type RecoverableOperation<T> = (attempt: AttemptContext) => OperationResult<T>;

// ---------------------------------------------------------------------------
// runWithRecovery — the wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap an operation in the recovery loop. See the module header for
 * the contract.
 *
 * IMPLEMENTATION NOTE: this function is synchronous. The factory
 * codebase uses synchronous spawnSync / execSync everywhere; adding
 * async would force a cascade of refactors. The waitFn knob defaults
 * to Atomics.wait (synchronous); tests pass a no-op so retries don't
 * actually delay.
 */
export function runWithRecovery<T>(
  operation: RecoverableOperation<T>,
  ctx: RunWithRecoveryContext,
  options: RunWithRecoveryOptions = {},
): RecoveryResult<T> {
  // Test escape hatch: skip the entire wrapper. Used by tests that
  // want to assert raw operation behavior without recovery interceding.
  if (options.disableRecovery === true) {
    const result = operation({ attemptNumber: 1 });
    if (result.outcome === 'ok') return { kind: 'ok', value: result.value };
    // Even with recovery disabled the operation can fail; surface a
    // synthetic escalation result so the caller's switch dispatches
    // the same way it does in the recovery-enabled case. We do NOT
    // emit events or write a record here — recovery is disabled.
    const reason = 'Recovery disabled; operation failed.';
    const escalation = buildEscalationRecord(
      ctx,
      'Unclassified',
      reason,
      1,
      result.failure,
    );
    return {
      kind: 'escalated',
      scenario: 'Unclassified',
      reason,
      attempts: 1,
      escalation,
      escalation_path: null,
    };
  }

  const eventBase = { run_id: ctx.runId, dry_run: ctx.dryRun } as const;

  // Initial call. NO recovery.attempt_started event for attempt 1 —
  // silent streams mean "everything went normally." The brief and
  // module header pin this.
  let attemptNumber = 1;
  let result = operation({ attemptNumber });
  if (result.outcome === 'ok') {
    return { kind: 'ok', value: result.value };
  }
  let lastFailure: FailureContext = result.failure;
  let lastScenario: FailureScenario | null = null;

  // Phase 7 — cascade-walking state. `cascadeIndex` is the index of
  // the most-recently-ATTEMPTED cascade step. The primary attempt
  // corresponds to index 0 (cascade[0] is what the call site invoked
  // before threading into the recovery loop). The recipe reads this
  // value (via `cascade_attempt_index` on FailureContext) to pick
  // the next hop. After each cascade_provider attempt, we increment
  // this counter regardless of outcome — the next failure-classification
  // pass needs to know we've now consumed cascade[cascadeIndex+1].
  let cascadeIndex = 0;

  // Retry loop. We re-classify on every failure because the failure
  // shape can change between attempts (transient -> stable error).
  // Bounded by SCENARIO_RETRY_BUDGET and any caller-supplied cost
  // cap. The loop has a hard upper bound of (sum of all per-scenario
  // budgets + 1) iterations to defend against pathological recipe
  // outputs.
  const maxIterations =
    ALL_SCENARIOS.reduce((sum, s) => sum + SCENARIO_RETRY_BUDGET[s], 0) + 1;

  for (let iter = 0; iter < maxIterations; iter += 1) {
    const failure = lastFailure;
    const scenario = classifyFailure(failure);

    // Unclassifiable failure: escalate immediately. Honest "we don't
    // know" per CLAUDE.md sec 3.1 / 3.5. NO recovery.attempt_started
    // because we never attempted a retry.
    if (scenario === null) {
      const reason = buildUnclassifiedReason(failure);
      return escalate(ctx, eventBase, 'Unclassified', reason, attemptNumber, failure);
    }

    lastScenario = scenario;
    const recipe = RECIPES[scenario];
    // Phase 7 — enrich the failure context with the cascade-walking
    // index so the ProviderUnavailable recipe knows which hop just
    // failed. Recipes that don't consult `cascade` ignore this field.
    const enrichedFailure: FailureContext = {
      ...failure,
      cascade_attempt_index: cascadeIndex,
    };
    const recipeOutput: RecipeOutput = recipe(scenario, enrichedFailure);

    // Recipe says escalate (LintFailed, TestFailed, ProviderUnavailable,
    // CompletionGateBlocked under the Phase-6 contract). Immediate
    // escalation; NO attempt_started, NO exhausted (we never tried).
    if (recipeOutput.kind === 'escalate') {
      return escalate(ctx, eventBase, scenario, recipeOutput.reason, attemptNumber, failure);
    }

    // Recipe says retry. Check the budget BEFORE incrementing.
    const usedSoFar = ctx.budget.get(scenario) ?? 0;
    const allowed = SCENARIO_RETRY_BUDGET[scenario];
    if (usedSoFar >= allowed) {
      // Budget exhausted for this scenario in this packet's lifetime.
      // Emit recovery.exhausted then escalate.
      appendEvent(
        makeRecoveryExhausted(eventBase, {
          scenario,
          attempts: attemptNumber,
          packet_id: ctx.packetId,
          spec_id: ctx.specId,
        }),
        ctx.artifactRoot,
      );
      return escalate(
        ctx,
        eventBase,
        scenario,
        `Retry budget exhausted for ${scenario} (allowed ${allowed}, used ${usedSoFar}).`,
        attemptNumber,
        failure,
      );
    }

    // Cost-cap pre-check. Order is important: cost.cap_crossed
    // MUST precede recovery.escalated (Phase 5.7 ordering rule).
    const capBlock = checkCostCapsBeforeRetry(ctx, eventBase, options);
    if (capBlock !== null) {
      return escalate(ctx, eventBase, scenario, capBlock, attemptNumber, failure);
    }

    // OK to retry. Consume budget, emit attempt_started, optionally
    // wait, dispatch the action, then call the operation closure.
    ctx.budget.set(scenario, usedSoFar + 1);
    attemptNumber += 1;
    appendEvent(
      makeRecoveryAttemptStarted(eventBase, {
        scenario,
        attempt_number: attemptNumber,
        packet_id: ctx.packetId,
        spec_id: ctx.specId,
      }),
      ctx.artifactRoot,
    );
    if (recipeOutput.wait_ms !== undefined && recipeOutput.wait_ms > 0) {
      const wait = options.waitFn ?? waitMsSync;
      try { wait(recipeOutput.wait_ms); } catch { /* ignore */ }
    }

    // git_rebase_then_retry: execute git fetch + git rebase BEFORE
    // re-running the operation. On a fetch failure or rebase conflict
    // we escalate without retrying — the assumption "tree is now in
    // sync with origin/main" no longer holds. The rebase happens here
    // (impure orchestration layer) rather than inside the operation
    // closure: pure git, no per-phase customization, every wrap site
    // benefits uniformly.
    if (recipeOutput.action === 'git_rebase_then_retry') {
      const gitRunner = options.gitRunner ?? defaultGitRunner;
      const rebaseEscalation = runGitRebase(gitRunner);
      if (rebaseEscalation !== null) {
        return escalate(ctx, eventBase, scenario, rebaseEscalation, attemptNumber, failure);
      }
    }

    const attemptCtx: AttemptContext = {
      attemptNumber,
      action: recipeOutput.action,
      ...(recipeOutput.guardrail_prompt !== undefined
        ? { guardrailPrompt: recipeOutput.guardrail_prompt }
        : {}),
      ...(recipeOutput.cascade !== undefined
        ? { cascade: recipeOutput.cascade }
        : {}),
    };
    // Phase 7 — bump the cascade index BEFORE invoking the closure
    // so the next failure-classification pass sees the correct
    // "most-recently-attempted" index. Done here (rather than after
    // the call returns) because the index reflects what the closure
    // is about to attempt, regardless of outcome.
    if (recipeOutput.action === 'cascade_provider') {
      cascadeIndex += 1;
    }
    result = operation(attemptCtx);
    if (result.outcome === 'ok') {
      appendEvent(
        makeRecoverySucceeded(eventBase, {
          scenario,
          attempt_number: attemptNumber,
          packet_id: ctx.packetId,
          spec_id: ctx.specId,
        }),
        ctx.artifactRoot,
      );
      return { kind: 'ok', value: result.value };
    }
    lastFailure = result.failure;
  }

  // Defensive: the loop should have returned by now. Escalate with
  // the last-seen scenario if we somehow exit through the iteration
  // cap (pathological recipe).
  const safetyScenario = lastScenario ?? 'Unclassified';
  const safetyReason = `Recovery loop exceeded safety bound (${maxIterations} iterations).`;
  return escalate(
    ctx,
    eventBase,
    safetyScenario,
    safetyReason,
    attemptNumber,
    lastFailure,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the on-disk EscalationRecord shape from the loop's state.
 * Centralised so the field set stays consistent.
 */
function buildEscalationRecord(
  ctx: RunWithRecoveryContext,
  scenario: FailureScenario | 'Unclassified',
  reason: string,
  attempts: number,
  failure: FailureContext,
): EscalationRecord {
  return {
    scenario,
    reason,
    spec_id: ctx.specId,
    packet_id: ctx.packetId,
    operation_label: ctx.operationLabel,
    attempts,
    run_id: ctx.runId,
    timestamp: new Date().toISOString(),
    failure: {
      exit_code: failure.exit_code,
      stderr_tail: tailString(failure.stderr ?? '', 4000),
      stdout_tail: tailString(failure.stdout ?? '', 4000),
      error_message: failure.error_message,
    },
  };
}

/**
 * Common escalation path: emit recovery.escalated, write the
 * structured record, return the escalation discriminator. Centralised
 * so the event-then-write order can never drift.
 */
function escalate<T>(
  ctx: RunWithRecoveryContext,
  eventBase: { readonly run_id: string; readonly dry_run: boolean },
  scenario: FailureScenario | 'Unclassified',
  reason: string,
  attempts: number,
  failure: FailureContext,
): RecoveryResult<T> {
  appendEvent(
    makeRecoveryEscalated(eventBase, {
      scenario,
      reason,
      packet_id: ctx.packetId,
      spec_id: ctx.specId,
    }),
    ctx.artifactRoot,
  );
  const escalation = buildEscalationRecord(ctx, scenario, reason, attempts, failure);
  const escalation_path = writeEscalation(escalation, ctx.artifactRoot);
  return {
    kind: 'escalated',
    scenario,
    reason,
    attempts,
    escalation,
    escalation_path,
  };
}

/**
 * Aggregate the run's cost AND (when configured) the day's cost.
 * If either is at-or-above its cap, emit cost.cap_crossed for the
 * crossing scope and return the escalation reason. Returns null when
 * no cap is crossed.
 *
 * Phase 5.7 ordering: cost.cap_crossed fires BEFORE the recovery
 * escalation event/file. The caller's escalate() emits
 * recovery.escalated AFTER this returns.
 */
function checkCostCapsBeforeRetry(
  ctx: RunWithRecoveryContext,
  eventBase: { readonly run_id: string; readonly dry_run: boolean },
  options: RunWithRecoveryOptions,
): string | null {
  // Per-run cap.
  if (options.perRunCap !== undefined) {
    const agg = aggregateRunCost(ctx.runId, ctx.artifactRoot);
    if (agg.total >= options.perRunCap) {
      appendEvent(
        makeCostCapCrossed(eventBase, {
          scope: 'per_run',
          cap_dollars: options.perRunCap,
          running_total: agg.total,
          packet_id: ctx.packetId,
          spec_id: ctx.specId,
        }),
        ctx.artifactRoot,
      );
      return `Retry blocked by per-run cost cap (running total $${agg.total.toFixed(4)}, cap $${options.perRunCap}).`;
    }
  }
  // Per-day cap.
  if (options.perDayCap !== undefined && options.today !== undefined) {
    const agg = readDayCost(options.today, ctx.artifactRoot);
    if (agg.total >= options.perDayCap) {
      appendEvent(
        makeCostCapCrossed(eventBase, {
          scope: 'per_day',
          cap_dollars: options.perDayCap,
          running_total: agg.total,
          packet_id: ctx.packetId,
          spec_id: ctx.specId,
        }),
        ctx.artifactRoot,
      );
      return `Retry blocked by per-day cost cap (running total $${agg.total.toFixed(4)}, cap $${options.perDayCap}).`;
    }
  }
  return null;
}

/**
 * Execute the StaleBranch action: `git fetch origin` then
 * `git rebase origin/main`. Returns null on success (the caller
 * proceeds to retry the operation) or an escalation-reason string on
 * failure (the caller escalates without retrying).
 *
 * On rebase conflict we additionally run `git rebase --abort` to
 * leave the working tree in a clean state. The abort is best-effort:
 * if it fails, the escalation reason still surfaces the original
 * conflict.
 */
function runGitRebase(gitRunner: GitRunner): string | null {
  // Step 1: fetch.
  const fetchResult = gitRunner(['fetch', 'origin']);
  if (fetchResult.exitCode !== 0) {
    const detail = (fetchResult.stderr || fetchResult.stdout || 'no output').trim();
    return `git fetch failed: ${detail.slice(0, 1000)}`;
  }

  // Step 2: rebase. On non-zero, abort to leave the tree clean.
  const rebaseResult = gitRunner(['rebase', 'origin/main']);
  if (rebaseResult.exitCode !== 0) {
    try { gitRunner(['rebase', '--abort']); } catch { /* swallow */ }
    const detail = (rebaseResult.stderr || rebaseResult.stdout || 'no output').trim();
    return `git rebase conflict: ${detail.slice(0, 1000)}`;
  }

  return null;
}

/**
 * Default git runner: spawnSync('git', args) at the supplied cwd
 * (or process.cwd() when none is supplied).
 */
function defaultGitRunner(args: ReadonlyArray<string>, cwd?: string): GitRunResult {
  const result = spawnSync('git', [...args], {
    cwd: cwd ?? process.cwd(),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function buildUnclassifiedReason(failure: FailureContext): string {
  const detail =
    failure.error_message ??
    (failure.stderr.length > 0 ? failure.stderr.slice(0, 200) : null) ??
    (failure.stdout.length > 0 ? failure.stdout.slice(0, 200) : null) ??
    'no diagnostic output';
  return `Unclassified failure (no recovery recipe applies): ${detail}`;
}

/**
 * Synchronous wait. We deliberately avoid `setTimeout` + Promise
 * here because the surrounding factory code (spawnSync, execSync) is
 * synchronous and turning recovery async would cascade.
 *
 * Implementation: SharedArrayBuffer + Atomics.wait. In tests, callers
 * pass `waitFn: () => undefined` so this code path doesn't run.
 */
function waitMsSync(ms: number): void {
  if (ms <= 0) return;
  try {
    const sab = new SharedArrayBuffer(4);
    const view = new Int32Array(sab);
    Atomics.wait(view, 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
  }
}

/**
 * Helper for callers: build the FailureContext from a failed
 * subprocess result. Tools/tests may use this to avoid duplicating
 * the spread shape at every call site.
 */
export function failureFromSubprocess(opts: {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly kind?: 'agent_invocation' | 'verification' | 'git' | 'lifecycle';
  readonly failedChecks?: ReadonlyArray<'build' | 'lint' | 'tests' | 'ci'>;
  readonly specId?: string | null;
  readonly packetId?: string | null;
  readonly operationLabel?: string;
}): FailureContext {
  return {
    exit_code: opts.exitCode,
    stdout: opts.stdout,
    stderr: opts.stderr,
    error_message: null,
    ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
    ...(opts.failedChecks !== undefined ? { failed_checks: opts.failedChecks } : {}),
    ...(opts.specId !== undefined ? { spec_id: opts.specId } : {}),
    ...(opts.packetId !== undefined ? { packet_id: opts.packetId } : {}),
    ...(opts.operationLabel !== undefined ? { operation_label: opts.operationLabel } : {}),
  };
}

/**
 * Helper for callers: build the FailureContext from a thrown error.
 */
export function failureFromThrow(opts: {
  readonly error: unknown;
  readonly kind?: 'agent_invocation' | 'verification' | 'git' | 'lifecycle';
  readonly specId?: string | null;
  readonly packetId?: string | null;
  readonly operationLabel?: string;
}): FailureContext {
  const msg = opts.error instanceof Error ? opts.error.message : String(opts.error);
  return {
    exit_code: null,
    stdout: '',
    // Surface the message via stderr so classifier patterns (FI-7,
    // stale-branch, etc.) fire on it just as they would on subprocess
    // stderr.
    stderr: msg,
    error_message: msg,
    ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
    ...(opts.specId !== undefined ? { spec_id: opts.specId } : {}),
    ...(opts.packetId !== undefined ? { packet_id: opts.packetId } : {}),
    ...(opts.operationLabel !== undefined ? { operation_label: opts.operationLabel } : {}),
  };
}

// Re-export key types so phase modules can import only from this
// file (the orchestration entry point).
export type {
  FailureScenario,
  FailureContext,
  RecoveryResult,
  EscalationRecord,
} from './recovery.js';
