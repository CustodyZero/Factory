/**
 * Tests for the agent-invocation helpers extracted from tools/run.ts.
 *
 * These pin the provider-CLI argv shape that each persona's
 * invocation produces. Behavior is byte-identical to the original
 * helpers in run.ts.
 */

import { describe, it, expect } from 'vitest';
import { resolveModelId, buildProviderArgs } from '../pipeline/agent_invoke.js';
import type { PipelineProviderConfig } from '../config.js';

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
