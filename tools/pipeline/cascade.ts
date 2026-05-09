/**
 * Factory — Pipeline / Cascade computation (pure logic)
 *
 * Phase 7 of `specs/single-entry-pipeline.md`. Implements the
 * cross-CLI / within-CLI cascade described in
 * `docs/decisions/single_entry_pipeline.md` §"Provider failover (the
 * `ProviderUnavailable` recipe in detail)".
 *
 * SCOPE
 *
 * This module is pure (no I/O, no globals, no time): it consumes a
 * persona name + the loaded `FactoryConfig` and returns the full
 * ordered cascade as `ReadonlyArray<CascadeStep>`. The recovery
 * recipe and the orchestration layer consume the result; this
 * module knows nothing about retries, events, or escalation
 * records.
 *
 * SHAPE OF THE CASCADE
 *
 * Each entry is `{ provider, model }`. `provider` is the CLI; `model`
 * is the concrete model id to invoke with — or `undefined` when the
 * CLI's own default should be used (matches the contract of
 * `resolveModelId` in `agent_invoke.ts`).
 *
 * The cascade is built in TWO nested loops:
 *
 *   for each P in persona_providers[persona]:           // cross-CLI
 *     if providers[P].model_failover is configured:
 *       for each M in providers[P].model_failover:      // within-CLI
 *         emit { provider: P, model: M }
 *     else:                                              // direct provider
 *       emit { provider: P, model: resolveModelId(providers[P], tier) }
 *
 * The PRIMARY attempt is `cascade[0]`. Subsequent entries form the
 * failover order: within-CLI alternates first (when configured), then
 * the next CLI in `persona_providers`, recursively.
 *
 * EXAMPLES
 *
 * 1) Single-CLI direct provider (current default config):
 *
 *      persona_providers.developer = ['codex']
 *      providers.codex.model_failover = undefined
 *      personas.developer.model = 'high'
 *
 *      cascade = [{ provider: 'codex', model: undefined }]
 *
 *    (codex has no `model_map` in the default config; tier resolution
 *    yields undefined — invokeAgent passes no --model flag and the CLI
 *    uses its own default.)
 *
 * 2) Multi-CLI, all direct providers:
 *
 *      persona_providers.developer = ['codex', 'claude']
 *
 *      cascade = [
 *        { provider: 'codex',  model: undefined },
 *        { provider: 'claude', model: undefined },
 *      ]
 *
 * 3) Abstraction provider with within-CLI failover:
 *
 *      persona_providers.developer = ['copilot', 'codex']
 *      providers.copilot.model_failover = ['claude-opus-4-6', 'GPT-5.4']
 *      providers.codex (no model_failover)
 *
 *      cascade = [
 *        { provider: 'copilot', model: 'claude-opus-4-6' },  // primary
 *        { provider: 'copilot', model: 'GPT-5.4' },           // within-CLI
 *        { provider: 'codex',   model: undefined },           // cross-CLI
 *      ]
 *
 * EDGE CASES
 *
 *   - Empty `persona_providers[persona]` cannot happen after loader
 *     normalization (normalizePersonaProvider falls back to defaults
 *     when raw is empty). The function nevertheless tolerates an
 *     empty list and returns `[]`.
 *
 *   - `providers[P]` is `undefined` (no entry for the CLI in the
 *     providers map): we still emit one cascade step with
 *     `model: undefined` so the call site sees the misconfiguration
 *     when it tries to invoke. The classifier flags this as
 *     ProviderUnavailable on the next attempt and the cascade
 *     proceeds. We do NOT silently skip the misconfigured CLI: that
 *     would hide the operator-facing bug.
 *
 *   - `model_failover` is configured but empty (`[]`): treated as
 *     "no within-CLI failover" — equivalent to absence. The schema's
 *     `minItems: 1` discourages this, but the loader still tolerates
 *     it (the operator might write `[]` while editing).
 *
 *   - Pipeline config absent: returns `[]`. Call sites already handle
 *     "no pipeline" via invokeAgent's early-return path.
 *
 * PURE: no I/O, no globals, no time. Same inputs, same output.
 */

import type {
  FactoryConfig,
  ModelTier,
  PipelinePersona,
  PipelineProvider,
} from '../config.js';
import { resolveModelId } from './agent_invoke.js';

/**
 * One step of a persona's cascade. The orchestration layer dispatches
 * `cascade_provider` with this shape; the closure passes `provider`
 * + `model` to `invokeAgent` (model bypasses tier resolution when
 * not undefined).
 */
export interface CascadeStep {
  readonly provider: PipelineProvider;
  /**
   * Concrete model id, or `undefined` when the CLI's own default
   * should be used (no `--model` flag passed). Matches the contract
   * of `resolveModelId` in `agent_invoke.ts`.
   */
  readonly model: string | undefined;
}

/**
 * Compute the full ordered cascade for a persona.
 *
 * The `tier` argument is the persona's configured tier (from
 * `config.personas.<persona>.model`) plus a phase-supplied default
 * when the persona didn't pin one. The cascade module does NOT
 * apply phase-level defaults itself — those are the call site's
 * concern (planner/dev default to 'high'; cr/qa default to 'medium').
 * Threading the tier explicitly keeps this function pure and
 * predictable for tests.
 *
 * Returns a frozen-by-readonly array of cascade steps in attempt
 * order: [primary, ...within-CLI failovers, ...next-CLI primary,
 * ...next-CLI within-CLI failovers, ...].
 */
export function computeCascade(
  persona: PipelinePersona,
  tier: ModelTier,
  config: FactoryConfig,
): ReadonlyArray<CascadeStep> {
  const pipeline = config.pipeline;
  if (pipeline === undefined) return [];
  const personaProviders = pipeline.persona_providers[persona];
  if (personaProviders === undefined || personaProviders.length === 0) {
    return [];
  }

  const out: CascadeStep[] = [];
  for (const provider of personaProviders) {
    const providerConfig = pipeline.providers[provider];
    if (providerConfig === undefined) {
      // The CLI is named in persona_providers but has no entry in
      // providers. Emit one step with model: undefined; the call
      // site's invokeAgent will surface "Provider 'X' not configured"
      // (classifier -> ProviderUnavailable) and the cascade advances
      // to the next CLI on the next attempt. We do NOT silently skip
      // the misconfigured CLI: hiding the bug would contradict the
      // honest-failure rule (CLAUDE.md §3.1).
      out.push({ provider, model: undefined });
      continue;
    }
    const modelFailover = providerConfig.model_failover;
    if (modelFailover !== undefined && modelFailover.length > 0) {
      // Abstraction provider with explicit within-CLI failover.
      // Each model_failover entry is one cascade step on the same CLI.
      for (const model of modelFailover) {
        out.push({ provider, model });
      }
    } else {
      // Direct provider (or abstraction without explicit failover):
      // one cascade step using the persona's tier-resolved model id.
      // resolveModelId returns undefined when the tier is missing
      // from the model_map OR the provider has no model_map at all;
      // that undefined flows through to the CLI default — same
      // behavior as today's (pre-Phase-7) invokeAgent calls.
      const model = resolveModelId(providerConfig, tier);
      out.push({ provider, model });
    }
  }
  return out;
}
