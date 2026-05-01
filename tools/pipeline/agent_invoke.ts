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
 * The behavior of invokeAgent is unchanged — same arg shape, same
 * spawn options, same return shape, same Copilot-via-stdin special
 * case. This is a pure relocation.
 */

import { spawnSync } from 'node:child_process';
import { findProjectRoot } from '../config.js';
import type {
  FactoryConfig,
  ModelTier,
  PipelineProvider,
  PipelineProviderConfig,
} from '../config.js';

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
// invokeAgent — imperative I/O leaf (spawnSync)
// ---------------------------------------------------------------------------

export interface InvokeResult {
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Invoke a provider CLI synchronously and return its result.
 *
 * Resolves the configured provider, builds argv via the pure helpers
 * above, then spawns the CLI. Behavior is identical to the
 * pre-Phase-4.5 run.ts implementation:
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
 */
export function invokeAgent(
  provider: PipelineProvider,
  prompt: string,
  config: FactoryConfig,
  modelTier?: ModelTier,
): InvokeResult {
  const pipelineConfig = config.pipeline;
  if (pipelineConfig === undefined) {
    return { exit_code: 1, stdout: '', stderr: 'Pipeline config not found' };
  }
  const providerConfig = pipelineConfig.providers[provider];
  if (providerConfig === undefined) {
    return { exit_code: 1, stdout: '', stderr: `Provider '${provider}' not configured` };
  }
  if (!providerConfig.enabled) {
    return { exit_code: 1, stdout: '', stderr: `Provider '${provider}' is disabled` };
  }

  const modelId = modelTier ? resolveModelId(providerConfig, modelTier) : undefined;
  const { command, args } = buildProviderArgs(provider, prompt, providerConfig, modelId);
  // Copilot: prompt via stdin to avoid OS command-line length limits.
  const useStdin = provider === 'copilot';
  const result = spawnSync(command, args, {
    cwd: findProjectRoot(),
    encoding: 'utf-8',
    timeout: 600_000, // 10 min per agent
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
    ...(useStdin ? { input: prompt } : {}),
  });
  return {
    exit_code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}
