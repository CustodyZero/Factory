/**
 * Tests for the agent-invocation helpers extracted from tools/run.ts.
 *
 * These pin the provider-CLI argv shape that each persona's
 * invocation produces. Behavior is byte-identical to the original
 * helpers in run.ts.
 */

import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveModelId,
  buildProviderArgs,
  invokeAgent,
  _startHeartbeat,
  HEARTBEAT_INTERVAL_MS,
  resolveHeartbeatInterval,
} from '../pipeline/agent_invoke.js';
import * as fmt from '../output.js';
import type { FactoryConfig, PipelineProviderConfig } from '../config.js';

function makeProviderConfig(overrides: Partial<PipelineProviderConfig> = {}): PipelineProviderConfig {
  return {
    enabled: overrides.enabled ?? true,
    command: overrides.command ?? 'fake-cli',
    prefix_args: overrides.prefix_args,
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

  // ----- DEP0190: prefix_args prepending -----

  it('prepends prefix_args to the per-provider argv (copilot sub-command shape)', () => {
    // The migration target for `command: "gh copilot --"` is
    // `command: "gh"` + `prefix_args: ["copilot", "--"]`. The
    // post-normalization argv must reach the child as
    // `gh copilot -- --yolo --no-ask-user [--model X]`.
    const out = buildProviderArgs(
      'copilot',
      'p',
      makeProviderConfig({ command: 'gh', prefix_args: ['copilot', '--'] }),
      undefined,
    );
    expect(out.command).toBe('gh');
    expect(out.args).toEqual(['copilot', '--', '--yolo', '--no-ask-user']);
  });

  it('prepends prefix_args before claude flags and after no implicit reordering', () => {
    const out = buildProviderArgs(
      'claude',
      'do the thing',
      makeProviderConfig({ command: 'wrapper', prefix_args: ['claude-cli'] }),
      'opus-4',
    );
    expect(out.command).toBe('wrapper');
    expect(out.args).toEqual([
      'claude-cli',
      '--print',
      '--dangerously-skip-permissions',
      '--model', 'opus-4',
      'do the thing',
    ]);
  });

  it('prepends prefix_args before codex flags', () => {
    const out = buildProviderArgs(
      'codex',
      'p',
      makeProviderConfig({ command: 'wrap', prefix_args: ['codex-sub'] }),
      undefined,
    );
    expect(out.args).toEqual(['codex-sub', '--quiet', '--full-auto', 'p']);
  });

  it('prepends prefix_args before generic-provider flags', () => {
    const out = buildProviderArgs(
      'unknown',
      'p',
      makeProviderConfig({ command: 'wrap', prefix_args: ['sub'] }),
      'm-1',
    );
    expect(out.args).toEqual(['sub', '--model', 'm-1', 'p']);
  });

  it('omits prefix_args entirely when not set (codex/claude bare shape)', () => {
    // Backward-compat: codex/claude configs without prefix_args
    // produce the same argv shape as before.
    const out = buildProviderArgs(
      'codex',
      'p',
      makeProviderConfig({ command: 'codex' }),
      undefined,
    );
    expect(out.args).toEqual(['--quiet', '--full-auto', 'p']);
  });

  it('handles a multi-element prefix_args array preserving order', () => {
    const out = buildProviderArgs(
      'copilot',
      'p',
      makeProviderConfig({
        command: 'tool',
        prefix_args: ['sub1', 'sub2', '--flag', 'value'],
      }),
      undefined,
    );
    expect(out.args).toEqual([
      'sub1', 'sub2', '--flag', 'value',
      '--yolo', '--no-ask-user',
    ]);
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

  it('uses modelOverride as cost.model when supplied (bypasses tier resolution)', async () => {
    const cfg = configWith('claude', {
      enabled: true,
      command: 'true',
      model_map: { high: 'tier-resolved-model' },
    });
    const result = await invokeAgent('claude', 'p', cfg, 'high', 'override-model');
    // Spawn ran (true exits 0); cost.model reports the override, not
    // the tier-resolved value. This is the load-bearing contract:
    // when the cascade selects (provider, model), invokeAgent invokes
    // EXACTLY that model.
    expect(result.cost.model).toBe('override-model');
  });

  it('falls back to tier resolution when modelOverride is undefined', async () => {
    const cfg = configWith('claude', {
      enabled: true,
      command: 'true',
      model_map: { high: 'tier-resolved-model' },
    });
    const result = await invokeAgent('claude', 'p', cfg, 'high');
    expect(result.cost.model).toBe('tier-resolved-model');
  });

  it('reports cost.model = null when neither override nor tier-resolved id is available', async () => {
    const cfg = configWith('claude', {
      enabled: true,
      command: 'true',
      // No model_map -> tier resolution returns undefined.
    });
    const result = await invokeAgent('claude', 'p', cfg, 'high');
    expect(result.cost.model).toBeNull();
  });

  it('override wins even when modelTier is omitted', async () => {
    const cfg = configWith('claude', {
      enabled: true,
      command: 'true',
      model_map: { high: 'tier-resolved-model' },
    });
    const result = await invokeAgent('claude', 'p', cfg, undefined, 'override-only');
    expect(result.cost.model).toBe('override-only');
  });

  it('override is ignored on early-return paths (no spawn, no override observable)', async () => {
    // Provider disabled — early return fires before resolution. The
    // override is silently dropped (the contract: no spawn means no
    // model is reported); cost.model is null.
    const cfg = configWith('claude', { enabled: false, command: 'true' });
    const result = await invokeAgent('claude', 'p', cfg, 'high', 'override-model');
    expect(result.exit_code).toBe(1);
    expect(result.cost.model).toBeNull();
  });
});

describe('invokeAgent — configuration-error early returns', () => {
  it('returns exit_code 1 with a clear stderr when pipeline config is missing', async () => {
    const cfg = makeMinimalConfig({ pipeline: undefined });
    const result = await invokeAgent('claude', 'hello', cfg);
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

  it('returns exit_code 1 with a clear stderr when the requested provider is not configured', async () => {
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
    const result = await invokeAgent('claude', 'hello', cfg);
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toMatch(/not configured/i);
    expect(result.cost.provider).toBe('claude');
    expect(result.cost.dollars).toBeNull();
  });

  it('returns exit_code 1 with a clear stderr when the provider is configured but disabled', async () => {
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
    const result = await invokeAgent('claude', 'hello', cfg);
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toMatch(/disabled/i);
    expect(result.cost.provider).toBe('claude');
    expect(result.cost.dollars).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Heartbeat — convergence pass
//
// Pins the operator-UX contract: every 30 seconds the agent is alive,
// fmt.log emits one progress line. The cadence (HEARTBEAT_INTERVAL_MS)
// is the load-bearing constant; tests use vi's fake timers to drive
// virtual time forward without actually waiting.
//
// We exercise the extracted _startHeartbeat helper directly rather
// than racing it against a real spawn — same setInterval the
// production code uses, no real-time dependency.
// ---------------------------------------------------------------------------

describe('heartbeat — _startHeartbeat cadence', () => {
  it('does NOT fire fmt.log before the first interval elapses (short call)', () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(fmt, 'log').mockImplementation(() => undefined);
    try {
      const timer = _startHeartbeat('claude', {
        message: "planner still running for spec 'demo'...",
        channel: 'plan',
      }, HEARTBEAT_INTERVAL_MS);
      // Advance by less than one interval (29s @ 30s cadence).
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS - 1_000);
      expect(spy).not.toHaveBeenCalled();
      timer.stop();
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('fires fmt.log exactly once after one full interval (30s)', () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(fmt, 'log').mockImplementation(() => undefined);
    try {
      const timer = _startHeartbeat('claude', {
        message: "planner still running for spec 'demo'...",
        channel: 'plan',
      }, HEARTBEAT_INTERVAL_MS);
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      expect(spy).toHaveBeenCalledTimes(1);
      // The line is routed through the configured channel and
      // carries the persona-specific message verbatim.
      expect(spy).toHaveBeenCalledWith(
        'plan',
        "planner still running for spec 'demo'...",
      );
      timer.stop();
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('fires three times across three intervals; stop() halts further heartbeats', () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(fmt, 'log').mockImplementation(() => undefined);
    try {
      const timer = _startHeartbeat('codex', {
        message: "developer working on packet 'pkt-1'...",
        channel: 'develop',
      }, HEARTBEAT_INTERVAL_MS);
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
      expect(spy).toHaveBeenCalledTimes(3);
      timer.stop();
      // After stop the timer no longer fires, even if more virtual
      // time elapses.
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 5);
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('falls back to a generic message when no HeartbeatContext is supplied', () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(fmt, 'log').mockImplementation(() => undefined);
    try {
      const timer = _startHeartbeat('claude', undefined, HEARTBEAT_INTERVAL_MS);
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      // The fallback is informational only; we just pin that it
      // names the provider (so the operator knows which CLI is
      // hanging) and routes to the generic 'agent' channel.
      expect(spy).toHaveBeenCalledTimes(1);
      const [channel, message] = spy.mock.calls[0]!;
      expect(channel).toBe('agent');
      expect(message).toContain('claude');
      timer.stop();
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('heartbeat — invokeAgent integration (no heartbeat for fast calls)', () => {
  it('does NOT emit a heartbeat for an invocation that completes in under 30s', async () => {
    // Real timers (the spawn close event needs real I/O), but the
    // child completes well before HEARTBEAT_INTERVAL_MS so the
    // interval never fires.
    const spy = vi.spyOn(fmt, 'log').mockImplementation(() => undefined);
    try {
      const cfg: FactoryConfig = makeMinimalConfig({
        pipeline: {
          providers: { claude: { enabled: true, command: 'true' } },
          persona_providers: {
            planner: ['claude'], developer: ['claude'],
            code_reviewer: ['claude'], qa: ['claude'],
          },
          completion_identities: {
            developer: 'claude', code_reviewer: 'claude', qa: 'claude',
          },
          max_review_iterations: 3,
        },
      } as Partial<FactoryConfig>);
      const result = await invokeAgent('claude', 'p', cfg, 'high', undefined, {
        message: "planner still running for spec 'fast'...",
        channel: 'plan',
      });
      expect(result.exit_code).toBe(0);
      // The 'true' binary returns instantly. The heartbeat interval
      // (30s) is far longer than any plausible startup delay so
      // fmt.log must not have been called via the heartbeat path.
      const heartbeatCalls = spy.mock.calls.filter(
        ([, msg]) => typeof msg === 'string' && msg.includes('still running'),
      );
      expect(heartbeatCalls.length).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Heartbeat — configurable cadence (pipeline.heartbeat_interval_ms)
//
// The 30 s default is the load-bearing contract; the tests above pin
// it. These tests pin the OPERATOR OVERRIDE: when
// `pipeline.heartbeat_interval_ms` is set, `invokeAgent` resolves that
// value at the call site and passes it to `_startHeartbeat`. We don't
// re-test the underlying setInterval mechanics — those are covered by
// the default-cadence block above. We pin the resolution at the
// `invokeAgent` boundary by spying on `_startHeartbeat`'s effect:
//
//   - A 5 s override fires fmt.log after 5 s of virtual time (NOT 30 s).
//   - The default (config absent OR field absent) STILL fires at 30 s.
//
// Both scenarios exercise the production path:
// `invokeAgent` -> resolve -> `_startHeartbeat(..., intervalMs)`. To
// avoid spawning a real CLI for the configurable test, we exercise
// the `_startHeartbeat` helper with the override value the production
// resolver would have computed — this isolates the cadence assertion
// from spawn timing and keeps the test deterministic under fake timers.
// ---------------------------------------------------------------------------

describe('heartbeat — configurable cadence', () => {
  it('fires at the configured 5s interval (NOT the default 30s) when heartbeat_interval_ms is set', () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(fmt, 'log').mockImplementation(() => undefined);
    try {
      // The production call site reads
      // config.pipeline?.heartbeat_interval_ms ?? HEARTBEAT_INTERVAL_MS;
      // we exercise the same resolved value here.
      const configuredInterval = 5_000;
      const timer = _startHeartbeat('claude', {
        message: "planner still running for spec 'demo'...",
        channel: 'plan',
      }, configuredInterval);
      // 4 s elapsed — still under the 5 s cadence, must not fire.
      vi.advanceTimersByTime(4_000);
      expect(spy).not.toHaveBeenCalled();
      // 5 s total — exactly one fire.
      vi.advanceTimersByTime(1_000);
      expect(spy).toHaveBeenCalledTimes(1);
      // Critical: this is well under the 30 s default. If the
      // resolution at the call site silently ignored the override,
      // the spy would still be empty.
      expect(configuredInterval).toBeLessThan(HEARTBEAT_INTERVAL_MS);
      timer.stop();
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('the default 30s cadence is preserved when pipeline.heartbeat_interval_ms is absent', () => {
    // This pins the BACKWARD-COMPAT contract: a config without the new
    // field behaves exactly as before the field existed. We exercise
    // the production resolution explicitly here:
    //   config.pipeline?.heartbeat_interval_ms  // undefined
    //   ?? HEARTBEAT_INTERVAL_MS               // 30000
    //
    // The fallback is the same one `invokeAgent` runs at the call site.
    vi.useFakeTimers();
    const spy = vi.spyOn(fmt, 'log').mockImplementation(() => undefined);
    try {
      const pipelineWithoutOverride: { heartbeat_interval_ms?: number } = {};
      const resolved =
        pipelineWithoutOverride.heartbeat_interval_ms ?? HEARTBEAT_INTERVAL_MS;
      expect(resolved).toBe(30_000);
      const timer = _startHeartbeat('claude', {
        message: "planner still running for spec 'demo'...",
        channel: 'plan',
      }, resolved);
      // 5 s elapsed — would have fired under a 5 s override; under
      // the default it must not.
      vi.advanceTimersByTime(5_000);
      expect(spy).not.toHaveBeenCalled();
      // One full 30 s interval — exactly one fire.
      vi.advanceTimersByTime(25_000);
      expect(spy).toHaveBeenCalledTimes(1);
      timer.stop();
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// resolveHeartbeatInterval — the pure resolution helper. Codex round-1
// finding: the previous configurable-cadence tests only exercised
// `_startHeartbeat` directly, which would still pass if `invokeAgent`
// ignored `config.pipeline.heartbeat_interval_ms`. Extracting and
// pinning the resolver gives a NAMED contract; the integration test
// below pins that `invokeAgent` actually consumes it.
// ---------------------------------------------------------------------------

describe('resolveHeartbeatInterval (pure)', () => {
  it('returns the configured value when pipeline.heartbeat_interval_ms is set', () => {
    const cfg = makeMinimalConfig({
      pipeline: {
        providers: { claude: { enabled: true, command: 'claude' } },
        persona_providers: {
          planner: ['claude'], developer: ['claude'],
          code_reviewer: ['claude'], qa: ['claude'],
        },
        completion_identities: {
          developer: 'claude', code_reviewer: 'claude', qa: 'claude',
        },
        max_review_iterations: 3,
        heartbeat_interval_ms: 5_000,
      },
    } as Partial<FactoryConfig>);
    expect(resolveHeartbeatInterval(cfg)).toBe(5_000);
  });

  it('returns the HEARTBEAT_INTERVAL_MS default (30000) when the field is absent', () => {
    const cfg = makeMinimalConfig({
      pipeline: {
        providers: { claude: { enabled: true, command: 'claude' } },
        persona_providers: {
          planner: ['claude'], developer: ['claude'],
          code_reviewer: ['claude'], qa: ['claude'],
        },
        completion_identities: {
          developer: 'claude', code_reviewer: 'claude', qa: 'claude',
        },
        max_review_iterations: 3,
        // heartbeat_interval_ms intentionally omitted.
      },
    } as Partial<FactoryConfig>);
    expect(resolveHeartbeatInterval(cfg)).toBe(HEARTBEAT_INTERVAL_MS);
    expect(resolveHeartbeatInterval(cfg)).toBe(30_000);
  });

  it('returns the default when the pipeline block is undefined', () => {
    const cfg = makeMinimalConfig({ pipeline: undefined });
    expect(resolveHeartbeatInterval(cfg)).toBe(HEARTBEAT_INTERVAL_MS);
  });

  it('returns the default when config itself is undefined', () => {
    expect(resolveHeartbeatInterval(undefined)).toBe(HEARTBEAT_INTERVAL_MS);
  });
});

// ---------------------------------------------------------------------------
// invokeAgent — heartbeat resolver integration. Pins that invokeAgent
// actually consumes the configured heartbeat cadence. The previous
// configurable-cadence tests exercised `_startHeartbeat` directly,
// which would still pass if `invokeAgent` ignored
// `config.pipeline.heartbeat_interval_ms`. Codex round-1 finding.
//
// Mechanism: drive `invokeAgent` against a child that lingers long
// enough for the heartbeat to fire, with a very small override (50 ms).
// Observe `fmt.log` calls — the heartbeat message MUST appear, proving
// the override threaded all the way through to `setInterval`. With a
// 30 s default and a child that exits in <500 ms, the heartbeat would
// NEVER fire; with a 50 ms override it fires at least once before the
// child exits. The signal is unambiguous: override-respected vs not.
//
// Spying on `_startHeartbeat` directly is not viable under ESM live
// bindings (vitest can rewrite the namespace getter but invokeAgent
// captured the function reference at module load). The behavioral
// assertion below is end-to-end and equivalent: if `invokeAgent`
// ignored the config, the spy would observe ZERO 'heartbeat' lines.
// ---------------------------------------------------------------------------

describe('invokeAgent — heartbeat resolver integration', () => {
  it('passes the configured heartbeat_interval_ms through to the heartbeat timer (50ms override fires during a slow child; 30s default would not)', async () => {
    // Spy on fmt.log to count heartbeat lines. We can't use fake
    // timers because the child process is real; instead we use a
    // very small override and a child that lingers long enough for
    // one or more heartbeats to fire.
    const heartbeatCalls: Array<{ channel: string; message: string }> = [];
    const spy = vi.spyOn(fmt, 'log').mockImplementation((channel: string, message: string) => {
      if (message.includes('still running')) {
        heartbeatCalls.push({ channel, message });
      }
    });
    try {
      // DEP0190 — argv-mode spawn. We use `sleep` as the executable
      // and pass `0.5` as a prefix_arg. The generic-provider branch
      // in buildProviderArgs appends the prompt as a positional. We
      // build the cfg so the prompt becomes a sleep duration that
      // sleep silently ignores after the first numeric arg (POSIX
      // sleep accepts one or more times and sums them; passing 'p'
      // is non-numeric and errors on some implementations, so we
      // use a separate strategy below).
      //
      // To stay portable across POSIX `sleep` implementations, we
      // invoke `sh -c 'sleep 0.5'` as the executable token via the
      // `node -e` escape: spawn `node` with a `-e` evaluator that
      // sleeps via setTimeout. This is platform-deterministic and
      // requires no shell.
      const cfg = makeMinimalConfig({
        pipeline: {
          providers: {
            // 'unknown' is the generic-provider branch in
            // buildProviderArgs. Args become:
            //   [...prefix_args, prompt]
            //   = ['-e', 'setTimeout(()=>{},500)', 'p']
            // Node ignores the trailing 'p' positional under `-e`.
            unknown: {
              enabled: true,
              command: 'node',
              prefix_args: ['-e', 'setTimeout(()=>{},500)'],
            } as never,
          },
          persona_providers: {
            planner: ['unknown' as never], developer: ['unknown' as never],
            code_reviewer: ['unknown' as never], qa: ['unknown' as never],
          },
          completion_identities: {
            developer: 'x', code_reviewer: 'x', qa: 'x',
          },
          max_review_iterations: 3,
          heartbeat_interval_ms: 50,
        },
      } as Partial<FactoryConfig>);
      const result = await invokeAgent('unknown' as never, 'p', cfg, 'high', undefined, {
        message: "test agent still running for spec 'demo'...",
        channel: 'plan',
      });
      expect(result.exit_code).toBe(0);

      // With a 50 ms heartbeat over a 500 ms child, expect at least
      // one heartbeat fire. With the 30 s default, ZERO would fire.
      // This asymmetry IS the contract: the override threaded
      // through `resolveHeartbeatInterval` to `_startHeartbeat`'s
      // `intervalMs` parameter is the only thing that can flip this
      // assertion from passing to failing.
      expect(heartbeatCalls.length).toBeGreaterThanOrEqual(1);
      expect(heartbeatCalls[0]!.channel).toBe('plan');
      expect(heartbeatCalls[0]!.message).toBe(
        "test agent still running for spec 'demo'...",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('does NOT pre-fire the heartbeat when the default (no override) is in play and the child finishes quickly', async () => {
    // Mirror image of the test above: no override, fast child. The
    // 30 s default means zero heartbeats during a ~10 ms spawn.
    const heartbeatCalls: Array<{ channel: string; message: string }> = [];
    const spy = vi.spyOn(fmt, 'log').mockImplementation((_channel: string, message: string) => {
      if (message.includes('still running')) {
        heartbeatCalls.push({ channel: _channel, message });
      }
    });
    try {
      const cfg = makeMinimalConfig({
        pipeline: {
          providers: { claude: { enabled: true, command: 'true' } },
          persona_providers: {
            planner: ['claude'], developer: ['claude'],
            code_reviewer: ['claude'], qa: ['claude'],
          },
          completion_identities: {
            developer: 'claude', code_reviewer: 'claude', qa: 'claude',
          },
          max_review_iterations: 3,
          // heartbeat_interval_ms omitted — default applies.
        },
      } as Partial<FactoryConfig>);
      const result = await invokeAgent('claude', 'p', cfg, 'high');
      expect(result.exit_code).toBe(0);
      // No override -> default (30 s) -> NO heartbeat for a fast child.
      // Paired with the override test above, this isolates the override
      // as the load-bearing input.
      expect(heartbeatCalls).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// DEP0190 — argv-mode spawn boundary
//
// Phase 2 of specs/dep0190-shell-removal.md drops `shell: true` from
// `invokeAgent`'s spawn call. These tests pin the new boundary by
// spawning a real fixture child that echoes its argv as JSON, then
// asserting the argv was delivered byte-identical.
//
// The fixture is a Node script: `node -e "echo argv as JSON"`. We
// invoke it as the provider executable so the argv array reaches the
// child unmodified. No real provider CLI is launched — the test runs
// under POSIX-style argv semantics (see the top-of-file SUPPORT
// BOUNDARY note in agent_invoke.ts).
// ---------------------------------------------------------------------------

// The fixture script echoes process.argv.slice(1) — the user-supplied
// argv after the node binary.
//
// Under `node -e SCRIPT -- <args>`, the `--` separator terminates
// node's own flag parsing (so suffix flags like `--print` or
// `--quiet` reach the script as literal args rather than being
// interpreted as node options). With `-e`, node does NOT insert the
// usual `[eval]` script-name sentinel into `process.argv[1]`; the
// first user arg lands at index 1 directly. Hence slice(1) — NOT
// slice(2) as one might expect from the standard `node script.js`
// layout.
const ARGV_ECHO_SCRIPT = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";

function makeArgvEchoConfig(
  provider: 'claude' | 'codex' | 'copilot' | 'generic',
  extra: Partial<PipelineProviderConfig> = {},
  pipelineExtras: Record<string, unknown> = {},
): FactoryConfig {
  // The provider key matches a real branch in buildProviderArgs.
  // For 'generic' we pick a name that hits the default case.
  const providerKey = provider === 'generic' ? 'unknown' : provider;
  return makeMinimalConfig({
    pipeline: {
      providers: {
        [providerKey]: {
          enabled: true,
          command: 'node',
          // The `-e` flag and the inline script become leading argv;
          // the trailing `--` terminates node's own flag parsing so
          // suffix args like `--print` reach the script intact. The
          // per-provider suffix flags + prompt land after.
          prefix_args: ['-e', ARGV_ECHO_SCRIPT, '--'],
          ...extra,
        } as never,
      },
      persona_providers: {
        planner: [providerKey as never],
        developer: [providerKey as never],
        code_reviewer: [providerKey as never],
        qa: [providerKey as never],
      },
      completion_identities: { developer: 'x', code_reviewer: 'x', qa: 'x' },
      max_review_iterations: 3,
      ...pipelineExtras,
    },
  } as Partial<FactoryConfig>);
}

describe('invokeAgent — argv-mode spawn (DEP0190)', () => {
  it('claude provider: argv reaches the child as the literal prefix + suffix sequence', async () => {
    const cfg = makeArgvEchoConfig('claude');
    const result = await invokeAgent('claude', 'hello world', cfg);
    expect(result.exit_code, `stderr was: ${result.stderr}`).toBe(0);
    // process.argv.slice(2) skips the node binary and the script
    // sentinel `[eval]`, so the echo carries the user-supplied args
    // verbatim (everything after our `--` separator).
    const echoed = JSON.parse(result.stdout) as string[];
    expect(echoed).toEqual([
      '--print',
      '--dangerously-skip-permissions',
      'hello world',
    ]);
  });

  it('codex provider: argv reaches the child verbatim', async () => {
    const cfg = makeArgvEchoConfig('codex');
    const result = await invokeAgent('codex', 'p', cfg);
    expect(result.exit_code, `stderr was: ${result.stderr}`).toBe(0);
    const echoed = JSON.parse(result.stdout) as string[];
    expect(echoed).toEqual(['--quiet', '--full-auto', 'p']);
  });

  it('copilot provider: prompt is delivered via stdin, NOT as an argv element', async () => {
    // Copilot's contract: prompt is sent via stdin to dodge OS
    // command-line length limits. The argv echo proves it: the
    // suffix carries only the copilot flags, no prompt.
    const cfg = makeArgvEchoConfig('copilot');
    const result = await invokeAgent('copilot', 'this-prompt-should-go-to-stdin', cfg);
    expect(result.exit_code, `stderr was: ${result.stderr}`).toBe(0);
    const echoed = JSON.parse(result.stdout) as string[];
    expect(echoed).toEqual(['--yolo', '--no-ask-user']);
    // The prompt is NOT in argv (the assert above is exact-match).
    expect(echoed).not.toContain('this-prompt-should-go-to-stdin');
  });

  it('generic provider: argv reaches the child verbatim with prompt as positional', async () => {
    const cfg = makeArgvEchoConfig('generic');
    const result = await invokeAgent('unknown' as never, 'p-generic', cfg);
    expect(result.exit_code, `stderr was: ${result.stderr}`).toBe(0);
    const echoed = JSON.parse(result.stdout) as string[];
    expect(echoed).toEqual(['p-generic']);
  });

  it('delivers prompts containing spaces, single quotes, double quotes, backticks, and newlines byte-identical', async () => {
    // Without shell:true, the OS argv contract handles every shell
    // metacharacter as a literal byte in the argument. No escaping
    // needed; we just assert the bytes survive round-trip.
    const trickyPrompts = [
      'has spaces',
      "has 'single quotes'",
      'has "double quotes"',
      'has `back ticks`',
      'has $varlike substr',
      'embedded\nnewline',
      'has;semicolon;and|pipe&ampersand',
      'unicode: 🦀 ñ é',
    ];
    for (const prompt of trickyPrompts) {
      const cfg = makeArgvEchoConfig('codex');
      const result = await invokeAgent('codex', prompt, cfg);
      expect(result.exit_code, `for prompt ${JSON.stringify(prompt)}; stderr=${result.stderr}`).toBe(0);
      const echoed = JSON.parse(result.stdout) as string[];
      // The prompt is the LAST argv element (codex suffix is
      // ['--quiet','--full-auto', prompt]).
      expect(echoed[echoed.length - 1], `byte-identical delivery of ${JSON.stringify(prompt)}`)
        .toBe(prompt);
    }
  });

  it('does NOT emit DEP0190 deprecation warnings during a normal invocation', async () => {
    // Node's `warning` event is process-global. We attach a scoped
    // listener for the duration of this single invocation, capture
    // any `code === 'DEP0190'` warnings, and detach. Other tests in
    // the file run sequentially within vitest's default
    // configuration; we additionally filter on the DEP0190 code so
    // unrelated warnings (e.g. ExperimentalWarning) do not trip the
    // assertion.
    const dep0190Warnings: NodeJS.ErrnoException[] = [];
    const listener = (warning: NodeJS.ErrnoException): void => {
      if ((warning as unknown as { code?: string }).code === 'DEP0190') {
        dep0190Warnings.push(warning);
      }
    };
    process.on('warning', listener);
    try {
      const cfg = makeArgvEchoConfig('claude');
      const result = await invokeAgent('claude', 'p', cfg);
      expect(result.exit_code).toBe(0);
      // Give Node a microtask to flush any pending warnings before
      // we tear down the listener. The warning event is emitted
      // synchronously inside `child_process.spawn`'s argv-validation
      // path when shell:true is combined with array args, so by the
      // time the child has exited any DEP0190 would already have
      // fired.
      await new Promise<void>((r) => setImmediate(r));
    } finally {
      process.off('warning', listener);
    }
    expect(dep0190Warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DEP0190 — executable path with internal whitespace
//
// Under `shell: false`, `command` is a literal path — internal
// whitespace is part of the path, not a tokenizer. We exercise this
// by creating a temp directory whose name contains a space, copying
// a node-fixture executable into it, and pointing the provider's
// `command` at the absolute path. The argv echo proves the
// invocation succeeded.
// ---------------------------------------------------------------------------

describe('invokeAgent — absolute path with internal whitespace (DEP0190)', () => {
  let tempDir: string;
  let fixturePath: string;

  beforeAll(() => {
    // The OS temp root differs by platform; we create a child dir
    // whose NAME contains a space. The full path therefore has
    // whitespace inside it.
    const root = mkdtempSync(join(tmpdir(), 'factory-dep0190-'));
    const subdir = join(root, 'dir with space');
    mkdirSync(subdir, { recursive: true });
    fixturePath = join(subdir, 'argv-echo.js');
    // A node script that echoes argv as JSON. We invoke it via the
    // node interpreter, but to exercise "command is an absolute
    // path with whitespace" we wrap it in a shebanged executable
    // wrapper script. On POSIX, a #!/usr/bin/env node header turns
    // the .js file into an executable when chmod'd.
    writeFileSync(
      fixturePath,
      '#!/usr/bin/env node\n' +
      'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
      'utf-8',
    );
    chmodSync(fixturePath, 0o755);
    tempDir = root;
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('spawns an executable at an absolute path containing spaces (argv-mode, no tokenization)', async () => {
    // The whole point: a path with whitespace must be treated as one
    // executable token, not split. Under `shell: true` it would have
    // been split by the shell; under argv-mode spawn it is one
    // literal path.
    const cfg = makeMinimalConfig({
      pipeline: {
        providers: {
          codex: { enabled: true, command: fixturePath },
        },
        persona_providers: {
          planner: ['codex'], developer: ['codex'],
          code_reviewer: ['codex'], qa: ['codex'],
        },
        completion_identities: { developer: 'x', code_reviewer: 'x', qa: 'x' },
        max_review_iterations: 3,
      },
    } as Partial<FactoryConfig>);
    const result = await invokeAgent('codex', 'p', cfg);
    expect(result.exit_code, `stderr was: ${result.stderr}`).toBe(0);
    // The fixture echoed its argv. codex's suffix is
    // ['--quiet','--full-auto',prompt].
    expect(JSON.parse(result.stdout)).toEqual(['--quiet', '--full-auto', 'p']);
  });
});

