/**
 * Tests for the agent-invocation helpers extracted from tools/run.ts.
 *
 * These pin the provider-CLI argv shape that each persona's
 * invocation produces. Behavior is byte-identical to the original
 * helpers in run.ts.
 */

import { describe, it, expect } from 'vitest';
import { resolveModelId, buildProviderArgs, invokeAgent } from '../pipeline/agent_invoke.js';
import type { FactoryConfig, PipelineProviderConfig } from '../config.js';

function makeProviderConfig(overrides: Partial<PipelineProviderConfig> = {}): PipelineProviderConfig {
  return {
    enabled: overrides.enabled ?? true,
    command: overrides.command ?? 'fake-cli',
    model_map: overrides.model_map,
    sandbox: overrides.sandbox,
    permission_mode: overrides.permission_mode,
  };
}

// ---------------------------------------------------------------------------
// resolveModelId
// ---------------------------------------------------------------------------

describe('resolveModelId', () => {
  it('returns the mapped model id for a known tier', () => {
    const cfg = makeProviderConfig({
      model_map: { high: 'opus-4', medium: 'sonnet-4', low: 'haiku-4' },
    });
    expect(resolveModelId(cfg, 'high')).toBe('opus-4');
    expect(resolveModelId(cfg, 'medium')).toBe('sonnet-4');
    expect(resolveModelId(cfg, 'low')).toBe('haiku-4');
  });

  it('returns undefined when the tier is missing from the model_map', () => {
    const cfg = makeProviderConfig({ model_map: { high: 'opus-4' } });
    expect(resolveModelId(cfg, 'medium')).toBeUndefined();
  });

  it('returns undefined when the provider has no model_map at all', () => {
    const cfg = makeProviderConfig({});
    expect(resolveModelId(cfg, 'high')).toBeUndefined();
    expect(resolveModelId(cfg, 'medium')).toBeUndefined();
    expect(resolveModelId(cfg, 'low')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildProviderArgs
// ---------------------------------------------------------------------------

describe('buildProviderArgs', () => {
  // ----- claude -----

  it('builds claude args with --print and --dangerously-skip-permissions, prompt last', () => {
    const out = buildProviderArgs('claude', 'do the thing', makeProviderConfig({ command: 'claude' }), undefined);
    expect(out.command).toBe('claude');
    expect(out.args).toEqual(['--print', '--dangerously-skip-permissions', 'do the thing']);
  });

  it('builds claude args with --model when modelId is provided', () => {
    const out = buildProviderArgs('claude', 'p', makeProviderConfig({ command: 'claude' }), 'opus-4');
    expect(out.args).toEqual([
      '--print', '--dangerously-skip-permissions', '--model', 'opus-4', 'p',
    ]);
  });

  // ----- codex -----

  it('builds codex args with --quiet and --full-auto, prompt last', () => {
    const out = buildProviderArgs('codex', 'p', makeProviderConfig({ command: 'codex' }), undefined);
    expect(out.command).toBe('codex');
    expect(out.args).toEqual(['--quiet', '--full-auto', 'p']);
  });

  it('builds codex args with --model when modelId is provided', () => {
    const out = buildProviderArgs('codex', 'p', makeProviderConfig({ command: 'codex' }), 'gpt-5');
    expect(out.args).toEqual(['--quiet', '--full-auto', '--model', 'gpt-5', 'p']);
  });

  // ----- copilot -----

  it('builds copilot args with --yolo and --no-ask-user but does NOT include the prompt (it goes via stdin)', () => {
    const out = buildProviderArgs('copilot', 'p', makeProviderConfig({ command: 'copilot' }), undefined);
    expect(out.command).toBe('copilot');
    expect(out.args).toEqual(['--yolo', '--no-ask-user']);
  });

  it('builds copilot args with --model when modelId is provided (still no prompt)', () => {
    const out = buildProviderArgs('copilot', 'p', makeProviderConfig({ command: 'copilot' }), 'claude-opus-4-6');
    expect(out.args).toEqual(['--yolo', '--no-ask-user', '--model', 'claude-opus-4-6']);
  });

  // ----- generic / unknown -----

  it('builds generic args (unknown provider) with prompt as last positional', () => {
    const out = buildProviderArgs('unknown', 'p', makeProviderConfig({ command: 'mystery' }), undefined);
    expect(out.command).toBe('mystery');
    expect(out.args).toEqual(['p']);
  });

  it('builds generic args with --model when modelId is provided', () => {
    const out = buildProviderArgs('unknown', 'p', makeProviderConfig({ command: 'mystery' }), 'm-1');
    expect(out.args).toEqual(['--model', 'm-1', 'p']);
  });

  // ----- command field comes from providerConfig -----

  it('passes through providerConfig.command unchanged', () => {
    expect(buildProviderArgs('claude', 'p', makeProviderConfig({ command: 'custom-claude' }), undefined).command)
      .toBe('custom-claude');
  });
});

// ---------------------------------------------------------------------------
// invokeAgent (configuration-error paths only — the spawn path is exercised
// via the pipeline integration tests since it would launch a real provider
// CLI; here we pin only the deterministic early-return branches that don't
// touch spawnSync at all).
// ---------------------------------------------------------------------------

function makeMinimalConfig(overrides: Partial<FactoryConfig> = {}): FactoryConfig {
  return {
    project_name: 'test',
    factory_dir: '.',
    artifact_dir: '.',
    verification: { build: 'true', lint: 'true', test: 'true' },
    validation: { command: 'true' },
    infrastructure_patterns: [],
    completed_by_default: { kind: 'agent', id: 'test' },
    personas: {
      planner: { description: '', instructions: [] },
      developer: { description: '', instructions: [] },
      code_reviewer: { description: '', instructions: [] },
      qa: { description: '', instructions: [] },
    },
    ...overrides,
  } as FactoryConfig;
}

// ---------------------------------------------------------------------------
// invokeAgent — Phase 7 modelOverride argument
//
// The override bypasses tier resolution against model_map. We can't
// run a real spawn deterministically, so we verify the contract by
// asserting on the InvokeResult.cost.model — which invokeAgent
// populates from the same `modelId` value it passes to spawnSync.
// (When modelOverride is supplied, modelId === modelOverride.) This
// also pins the report shape: cost.model in the result is always the
// model that was actually targeted, not the tier.
//
// To avoid spawning a real CLI, the tests below use a provider whose
// `command` is a no-op: 'true' (POSIX) returns exit_code 0 with no
// output. Windows hosts could fail this test, but the rest of the
// factory test suite already assumes a POSIX-like /bin/sh shell
// (e.g. recovery_loop.test.ts uses `git`, lifecycle tests use shell
// strings).
// ---------------------------------------------------------------------------

describe('invokeAgent — Phase 7 modelOverride', () => {
  function configWith(provider: string, providerConfig: { enabled: boolean; command: string; model_map?: Record<string, string>; model_failover?: ReadonlyArray<string> }): FactoryConfig {
    return makeMinimalConfig({
      pipeline: {
        providers: { [provider]: providerConfig },
        persona_providers: {
          planner: [provider as never],
          developer: [provider as never],
          code_reviewer: [provider as never],
          qa: [provider as never],
        },
        completion_identities: { developer: 'x', code_reviewer: 'x', qa: 'x' },
        max_review_iterations: 3,
      },
    } as Partial<FactoryConfig>);
  }

  it('uses modelOverride as cost.model when supplied (bypasses tier resolution)', () => {
    const cfg = configWith('claude', {
      enabled: true,
      command: 'true',
      model_map: { high: 'tier-resolved-model' },
    });
    const result = invokeAgent('claude', 'p', cfg, 'high', 'override-model');
    // Spawn ran (true exits 0); cost.model reports the override, not
    // the tier-resolved value. This is the load-bearing contract:
    // when the cascade selects (provider, model), invokeAgent invokes
    // EXACTLY that model.
    expect(result.cost.model).toBe('override-model');
  });

  it('falls back to tier resolution when modelOverride is undefined', () => {
    const cfg = configWith('claude', {
      enabled: true,
      command: 'true',
      model_map: { high: 'tier-resolved-model' },
    });
    const result = invokeAgent('claude', 'p', cfg, 'high');
    expect(result.cost.model).toBe('tier-resolved-model');
  });

  it('reports cost.model = null when neither override nor tier-resolved id is available', () => {
    const cfg = configWith('claude', {
      enabled: true,
      command: 'true',
      // No model_map -> tier resolution returns undefined.
    });
    const result = invokeAgent('claude', 'p', cfg, 'high');
    expect(result.cost.model).toBeNull();
  });

  it('override wins even when modelTier is omitted', () => {
    const cfg = configWith('claude', {
      enabled: true,
      command: 'true',
      model_map: { high: 'tier-resolved-model' },
    });
    const result = invokeAgent('claude', 'p', cfg, undefined, 'override-only');
    expect(result.cost.model).toBe('override-only');
  });

  it('override is ignored on early-return paths (no spawn, no override observable)', () => {
    // Provider disabled — early return fires before resolution. The
    // override is silently dropped (the contract: no spawn means no
    // model is reported); cost.model is null.
    const cfg = configWith('claude', { enabled: false, command: 'true' });
    const result = invokeAgent('claude', 'p', cfg, 'high', 'override-model');
    expect(result.exit_code).toBe(1);
    expect(result.cost.model).toBeNull();
  });
});

describe('invokeAgent — configuration-error early returns', () => {
  it('returns exit_code 1 with a clear stderr when pipeline config is missing', () => {
    const cfg = makeMinimalConfig({ pipeline: undefined });
    const result = invokeAgent('claude', 'hello', cfg);
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toMatch(/pipeline config/i);
    // Phase 5.7 — InvokeResult.cost is always populated. Early-return
    // paths use nulls because no spawn ever happened.
    expect(result.cost).toEqual({
      provider: 'claude',
      model: null,
      tokens_in: null,
      tokens_out: null,
      dollars: null,
    });
  });

  it('returns exit_code 1 with a clear stderr when the requested provider is not configured', () => {
    const cfg = makeMinimalConfig({
      pipeline: {
        providers: {},
        persona_providers: {
          planner: ['claude'], developer: ['claude'], code_reviewer: ['claude'], qa: ['claude'],
        },
        completion_identities: {
          developer: 'claude', code_reviewer: 'claude', qa: 'claude',
        },
        max_review_iterations: 3,
      },
    } as Partial<FactoryConfig>);
    const result = invokeAgent('claude', 'hello', cfg);
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toMatch(/not configured/i);
    expect(result.cost.provider).toBe('claude');
    expect(result.cost.dollars).toBeNull();
  });

  it('returns exit_code 1 with a clear stderr when the provider is configured but disabled', () => {
    const cfg = makeMinimalConfig({
      pipeline: {
        providers: {
          claude: { enabled: false, command: 'claude' },
        },
        persona_providers: {
          planner: ['claude'], developer: ['claude'], code_reviewer: ['claude'], qa: ['claude'],
        },
        completion_identities: {
          developer: 'claude', code_reviewer: 'claude', qa: 'claude',
        },
        max_review_iterations: 3,
      },
    } as Partial<FactoryConfig>);
    const result = invokeAgent('claude', 'hello', cfg);
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toMatch(/disabled/i);
    expect(result.cost.provider).toBe('claude');
    expect(result.cost.dollars).toBeNull();
  });
});
