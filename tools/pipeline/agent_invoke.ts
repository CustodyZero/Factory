/**
 * Factory — Pipeline / Agent Invocation Helpers
 *
 * Pure helpers that prepare provider-CLI invocations.
 *
 * SCOPE FOR PHASE 1
 *
 * The brief asked for resolveModelId, buildProviderArgs, AND
 * invokeAgent to be moved here. The brief's acceptance criteria
 * also state: "No file under tools/pipeline/ does I/O. Pure
 * functions only." invokeAgent calls spawnSync, which is I/O,
 * so it cannot live in this module without violating the harder
 * constraint.
 *
 * Resolution: the two pure helpers live here (testable, no I/O).
 * invokeAgent stays in run.ts (imperative, calls spawnSync). The
 * file boundary now matches the no-I/O invariant exactly.
 *
 * This is also what the brief explicitly notes about test
 * coverage: "The pure helpers (resolveModelId, buildProviderArgs)
 * get unit tests. invokeAgent is imperative and stays untested
 * in this phase." That distinction only makes sense if the pure
 * helpers are isolated from the imperative caller.
 *
 * A later phase that needs to swap providers (Phase 7 — two-layer
 * failover) can move invokeAgent here once it's been broken into
 * a pure "resolve provider chain" decision plus a thin imperative
 * "run one provider" leaf — at which point the decision can live
 * here and the leaf in lifecycle code.
 */

import type { ModelTier, PipelineProviderConfig } from '../config.js';

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
