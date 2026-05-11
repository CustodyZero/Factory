/**
 * Factory — Pipeline / Agent Invocation Helpers
 *
 * Pure helpers that prepare provider-CLI invocations PLUS the
 * imperative I/O wrapper that actually spawns one.
 *
 * SCOPE CHANGE — PHASE 4.5
 *
 * Phase 1 of specs/single-entry-pipeline.md kept this file pure
 * (resolveModelId, buildProviderArgs only) and left invokeAgent in
 * tools/run.ts. The rationale at the time was a strict "no I/O in
 * pipeline/" invariant.
 *
 * Phase 4.5 extracts the three phase loops (plan/develop/verify)
 * into their own pipeline modules. All three call invokeAgent. With
 * invokeAgent still in run.ts, the phase modules would either have
 * to import upward from run.ts (a layering violation) or each
 * receive an injected callable (extra ceremony with no benefit at
 * the current call sites). The cleanest fix is to relocate the I/O
 * wrapper to live alongside its pure helpers — the brief for Phase
 * 4.5 explicitly calls this out as the preferred placement.
 *
 * The "no I/O in pipeline/" invariant is not a global rule of the
 * architecture. It applied to Phase 1 because at that point the
 * imperative bodies still lived in run.ts. After Phase 4.5, the
 * pipeline/ layer is exactly where imperative phases belong; the
 * argument-building helpers stay pure inside this same file as
 * before.
 *
 * CONVERGENCE PASS (post-Phase-8) — async + heartbeats
 *
 * Long-running planner/developer/QA invocations were silent: the
 * synchronous spawnSync blocked the event loop for up to ten minutes
 * and the operator saw nothing between "invoking <persona>..." and
 * "<persona> completed". This module migrates to `child_process.spawn`
 * wrapped in a Promise so:
 *
 *   1. The pipeline can yield while the child runs (no other code
 *      yields synchronously in TS — async is the natural fit).
 *   2. We can emit periodic heartbeats while the child is alive.
 *
 * The new contract is `invokeAgent(...): Promise<InvokeResult>`. Every
 * existing call site awaits. The InvokeResult shape — exit_code,
 * stdout, stderr, cost — is unchanged. The early-return paths (missing
 * pipeline config, unknown provider, disabled provider) return a
 * resolved Promise with the same payload as before.
 *
 * Heartbeat surface: `fmt.log` to stderr (operator UX, NOT events).
 * Events stay reserved for durable record-of-what-happened; heartbeats
 * are progress indicators that exist only to reassure the human
 * reading the terminal. Interval is hardcoded at 30 seconds; revisit
 * if operators report it as too chatty or too quiet.
 */

import { spawn } from 'node:child_process';
import { findProjectRoot } from '../config.js';
import type {
  FactoryConfig,
  ModelTier,
  PipelineProvider,
  PipelineProviderConfig,
} from '../config.js';
import * as fmt from '../output.js';
import { computeCost, extractTokens, mergeRateCard } from './cost.js';

// ---------------------------------------------------------------------------
// Heartbeat configuration
// ---------------------------------------------------------------------------

/**
 * Default heartbeat cadence in milliseconds. The first heartbeat fires
 * after this many milliseconds of the child still running, then every
 * interval after.
 *
 * 30 s is the chosen tradeoff: short enough that an operator watching
 * the terminal sees motion (a 10-min agent gets 19 reassurances),
 * long enough that fast happy-path invocations (planner < 30 s) emit
 * zero heartbeats. Operators can override via
 * `factory.config.json` -> `pipeline.heartbeat_interval_ms` (integer,
 * min 1000); see `tools/config.ts:PipelineConfig`. When absent the
 * default below applies — this constant is the load-bearing fallback
 * referenced by the resolution at the `invokeAgent` call site.
 *
 * Kept as `HEARTBEAT_INTERVAL_MS` (the original name) so existing
 * tests that imported the constant for the default-cadence assertion
 * keep compiling.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Optional heartbeat context: what label to print and which packet/
 * spec is in flight. Each call site populates this with persona-
 * specific text (e.g. "planner still running for spec '<id>'..."
 * or "developer working on packet '<id>'..."). When omitted, the
 * heartbeat falls back to a generic "<provider> still running" line.
 *
 * The context is purely advisory — heartbeats never affect the agent
 * call or its result.
 */
export interface HeartbeatContext {
  /** Operator-facing message (without the elapsed timer prefix). */
  readonly message: string;
  /**
   * Which `fmt.log` channel to write to (e.g. 'plan', 'develop',
   * 'verify', 'review'). Defaults to 'agent' when omitted so casual
   * call sites still produce a reasonable label.
   */
  readonly channel?: string;
}

/**
 * Start a heartbeat timer and return a stop function. Extracted so
 * the cadence is testable without mocking spawn — tests use vi's
 * fake timers to advance virtual time and assert that fmt.log fires
 * exactly once per interval.
 *
 * `intervalMs` is required (no default) so the call site is forced
 * to thread the resolved cadence through explicitly. The resolution
 * (`config.pipeline?.heartbeat_interval_ms ?? HEARTBEAT_INTERVAL_MS`)
 * lives at the `invokeAgent` boundary; injecting the value here
 * keeps `_startHeartbeat` pure with respect to configuration.
 *
 * The leading-underscore export name signals "test-only public".
 * Production callers should NOT consume this; they get heartbeats
 * for free via `invokeAgent`.
 */
export function _startHeartbeat(
  provider: string,
  heartbeat: HeartbeatContext | undefined,
  intervalMs: number,
): { stop: () => void } {
  const channel = heartbeat?.channel ?? 'agent';
  const message = heartbeat?.message
    ?? `${provider} agent still running (no progress signal yet)`;
  const handle = setInterval(() => {
    fmt.log(channel, message);
  }, intervalMs);
  // unref so the heartbeat never keeps the process alive on its own.
  handle.unref?.();
  return {
    stop: () => clearInterval(handle),
  };
}

// ---------------------------------------------------------------------------
// resolveModelId
// ---------------------------------------------------------------------------

/**
 * Resolve the concrete model ID for a given provider and tier.
 *
 * If the provider config has a model_map, look up the tier. If the
 * tier is missing OR the provider has no model_map at all, return
 * undefined — the provider CLI will fall back to its own default.
 */
export function resolveModelId(
  providerConfig: PipelineProviderConfig,
  tier: ModelTier,
): string | undefined {
  return providerConfig.model_map?.[tier];
}

// ---------------------------------------------------------------------------
// buildProviderArgs
// ---------------------------------------------------------------------------

export interface ProviderInvocation {
  /** The CLI command to spawn (from providerConfig.command). */
  readonly command: string;
  /** The argv to pass after the command. */
  readonly args: string[];
}

/**
 * Build CLI arguments for a provider invocation.
 *
 * Each provider has its own conventions for autonomous mode and
 * model selection. The contract here matches the original
 * buildProviderArgs in run.ts byte-for-byte:
 *
 *   claude:
 *     args = ['--print', '--dangerously-skip-permissions',
 *             ...(modelId ? ['--model', modelId] : []),
 *             prompt]
 *
 *   codex:
 *     args = ['--quiet', '--full-auto',
 *             ...(modelId ? ['--model', modelId] : []),
 *             prompt]
 *
 *   copilot:
 *     args = ['--yolo', '--no-ask-user',
 *             ...(modelId ? ['--model', modelId] : [])]
 *     -- prompt is delivered via stdin by the caller, not here.
 *
 *   anything else:
 *     args = [...(modelId ? ['--model', modelId] : []), prompt]
 */
export function buildProviderArgs(
  provider: string,
  prompt: string,
  providerConfig: PipelineProviderConfig,
  modelId: string | undefined,
): ProviderInvocation {
  const command = providerConfig.command;
  const args: string[] = [];

  switch (provider) {
    case 'claude':
      args.push('--print', '--dangerously-skip-permissions');
      if (modelId) args.push('--model', modelId);
      args.push(prompt);
      break;

    case 'codex':
      args.push('--quiet', '--full-auto');
      if (modelId) args.push('--model', modelId);
      args.push(prompt);
      break;

    case 'copilot':
      // Pass prompt via stdin rather than as a -p argument to avoid OS
      // command-line length limits (Windows cmd.exe caps at ~8191 chars).
      args.push('--yolo', '--no-ask-user');
      if (modelId) args.push('--model', modelId);
      break;

    default:
      // Generic provider: pass prompt as positional, model via --model.
      if (modelId) args.push('--model', modelId);
      args.push(prompt);
      break;
  }

  return { command, args };
}

// ---------------------------------------------------------------------------
// invokeAgent — async I/O wrapper around child_process.spawn
// ---------------------------------------------------------------------------

/**
 * Cost data attached to every invocation result (Phase 5.7).
 *
 * Always populated. Null fields are the honest "we do not know"
 * signal — see tools/pipeline/cost.ts for the rationale. The early-
 * return error paths (missing pipeline config, unknown provider,
 * disabled provider) populate this with the caller-supplied
 * provider name and null tokens/dollars; downstream callers can
 * still record the row if they want, but `recordCost` only fires
 * after a real spawn so the early-return rows are not persisted.
 */
export interface InvokeCost {
  readonly provider: string;
  readonly model: string | null;
  readonly tokens_in: number | null;
  readonly tokens_out: number | null;
  readonly dollars: number | null;
}

export interface InvokeResult {
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * Phase 5.7 — provider/model/tokens/dollars for this invocation.
   * Always present; null fields when the provider does not report
   * tokens or no rate-card entry exists.
   */
  readonly cost: InvokeCost;
}

/**
 * Invoke a provider CLI and return its result.
 *
 * Resolves the configured provider, builds argv via the pure helpers
 * above, then spawns the CLI. The migration from `spawnSync` to
 * `spawn` (post-Phase-8 convergence pass) preserves every observable
 * behavior of the previous synchronous implementation:
 *
 *   - returns exit_code 1 with a stderr message when:
 *       * the pipeline config block is missing
 *       * the provider is not configured
 *       * the provider is configured but disabled
 *   - copilot receives the prompt via stdin (per buildProviderArgs's
 *     contract); other providers receive the prompt as the last argv
 *   - cwd is the project root; timeout is 10 minutes per agent;
 *     stdio is fully piped so stdout/stderr are captured into the
 *     return value.
 *
 * The async migration adds:
 *
 *   - a heartbeat: while the child is alive, emit one fmt.log line
 *     every HEARTBEAT_INTERVAL_MS to stderr, populated from the
 *     supplied HeartbeatContext (or a generic fallback). The timer
 *     stops the moment the child exits.
 *
 * Phase 7 of single-entry-pipeline — the optional `modelOverride`
 * argument lets the caller pin a concrete model id, bypassing the
 * `modelTier` -> `model_map` resolution. The cascade closure
 * (`develop_phase` / `verify_phase` / `plan_phase`, when handling
 * `attempt.action === 'cascade_provider'`) passes the cascade's
 * resolved model id here so the failover hop targets the exact
 * (provider, model) the recipe selected. When `modelOverride` is
 * undefined or null, tier resolution applies as before (backward
 * compatible). When BOTH `modelOverride` and `modelTier` are
 * supplied, the override wins — it is, by definition, an override.
 */
export function invokeAgent(
  provider: PipelineProvider,
  prompt: string,
  config: FactoryConfig,
  modelTier?: ModelTier,
  modelOverride?: string,
  heartbeat?: HeartbeatContext,
): Promise<InvokeResult> {
  // Phase 5.7: every early-return path returns a populated cost field
  // (null tokens/dollars). The cost shape is part of the contract
  // even on configuration errors — downstream callers may still want
  // to surface the provider name in logs.
  const pipelineConfig = config.pipeline;
  if (pipelineConfig === undefined) {
    return Promise.resolve({
      exit_code: 1,
      stdout: '',
      stderr: 'Pipeline config not found',
      cost: nullCost(provider, null),
    });
  }
  const providerConfig = pipelineConfig.providers[provider];
  if (providerConfig === undefined) {
    return Promise.resolve({
      exit_code: 1,
      stdout: '',
      stderr: `Provider '${provider}' not configured`,
      cost: nullCost(provider, null),
    });
  }
  if (!providerConfig.enabled) {
    return Promise.resolve({
      exit_code: 1,
      stdout: '',
      stderr: `Provider '${provider}' is disabled`,
      cost: nullCost(provider, null),
    });
  }

  // Phase 7 — modelOverride wins over modelTier when both are
  // supplied. The cascade closure pre-resolves the model id from the
  // cascade step and passes it here; tier resolution against
  // model_map is bypassed in that case.
  const modelId = modelOverride !== undefined
    ? modelOverride
    : (modelTier ? resolveModelId(providerConfig, modelTier) : undefined);
  const { command, args } = buildProviderArgs(provider, prompt, providerConfig, modelId);
  // Copilot: prompt via stdin to avoid OS command-line length limits.
  const useStdin = provider === 'copilot';

  return new Promise<InvokeResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: findProjectRoot(),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });

    if (useStdin) {
      child.stdin?.write(prompt);
    }
    child.stdin?.end();

    // 10-minute timeout — the spawnSync contract was a hard kill at
    // 600_000 ms. We replicate that here: when the timer fires, send
    // SIGTERM (then SIGKILL on slow exit) and let the close handler
    // resolve with whatever output was captured up to that point.
    const TIMEOUT_MS = 600_000;
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      // Last-resort kill if the child hasn't shut down.
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, 2_000).unref();
    }, TIMEOUT_MS);
    timeoutHandle.unref();

    // Heartbeat: every `heartbeatInterval` ms, emit one progress line.
    // Cleared when the child closes. The cadence is unit-tested via
    // _startHeartbeat directly; here we just consume the helper.
    //
    // Resolution: operator override (`pipeline.heartbeat_interval_ms`)
    // wins; otherwise the load-bearing default (30 s) applies. The
    // schema enforces the floor (>= 1000 ms); we don't re-validate here
    // — defense-in-depth against a hand-edited config that bypassed
    // ajv would risk masking a real misconfiguration (CLAUDE.md §3.3
    // failures must be visible).
    const heartbeatInterval =
      pipelineConfig.heartbeat_interval_ms ?? HEARTBEAT_INTERVAL_MS;
    const heartbeatTimer = _startHeartbeat(provider, heartbeat, heartbeatInterval);

    const cleanup = (): void => {
      clearTimeout(timeoutHandle);
      heartbeatTimer.stop();
    };

    child.on('error', (err) => {
      cleanup();
      // spawn-error path: replicate the spawnSync "could not spawn"
      // shape — exit_code 1 with the error surfaced through stderr.
      // The recovery layer's classifier consumes stderr text; we
      // leave whatever was already captured intact and append.
      const message = err instanceof Error ? err.message : String(err);
      resolve({
        exit_code: 1,
        stdout,
        stderr: stderr.length > 0 ? `${stderr}\n${message}` : message,
        cost: nullCost(provider, modelId ?? null),
      });
    });

    child.on('close', (code) => {
      cleanup();
      // Phase 5.7 — extract tokens, then compute dollars. The rate card
      // is the merged DEFAULT_RATE_CARD with any per-run overrides from
      // config.pipeline.rate_card. Both extractTokens and computeCost
      // are pure and tolerate every missing-data shape with null.
      const tokens = extractTokens(provider, stdout, stderr);
      const rateCard = mergeRateCard(pipelineConfig.rate_card);
      const { dollars } = computeCost(
        provider,
        modelId,
        tokens.tokens_in,
        tokens.tokens_out,
        rateCard,
      );
      // Match spawnSync's behavior: when the timeout fires the child
      // is killed and the captured exit_code is 1 (spawnSync surfaced
      // `null` -> 1 via the `?? 1` fallback). For non-timeout exits
      // the actual code is preserved.
      const exitCode = timedOut ? 1 : (code ?? 1);
      resolve({
        exit_code: exitCode,
        stdout,
        stderr,
        cost: {
          provider,
          model: modelId ?? null,
          tokens_in: tokens.tokens_in,
          tokens_out: tokens.tokens_out,
          dollars,
        },
      });
    });
  });
}

/**
 * Build a null-cost record for early-return paths. Centralised so the
 * shape stays consistent across the three configuration-error
 * branches above.
 */
function nullCost(provider: string, model: string | null): InvokeCost {
  return {
    provider,
    model,
    tokens_in: null,
    tokens_out: null,
    dollars: null,
  };
}
