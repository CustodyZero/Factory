/**
 * Phase 7 — Unit tests for the pure cascade-computation module.
 *
 * Pins:
 *   - Single-string persona_providers (1 cascade step).
 *   - Multi-element persona_providers (cross-CLI failover).
 *   - Abstraction provider with model_failover (within-CLI failover
 *     expansion).
 *   - Direct provider without model_failover (one step per CLI).
 *   - Mixed (one abstraction provider + one direct).
 *   - Tier resolution against model_map for direct providers.
 *   - Edge cases: persona_providers length 1 with no failover;
 *     model_failover empty array; missing provider entry; missing
 *     pipeline config.
 *
 * Pure-function tests; no I/O, no fixtures on disk.
 */

import { describe, it, expect } from 'vitest';
import { computeCascade, type CascadeStep } from '../pipeline/cascade.js';
import type {
  FactoryConfig,
  ModelTier,
  PipelinePersona,
  PipelineProvider,
  PipelineProviderConfig,
} from '../config.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeProvider(overrides: Partial<PipelineProviderConfig> = {}): PipelineProviderConfig {
  return {
    enabled: overrides.enabled ?? true,
    command: overrides.command ?? 'noop',
    ...(overrides.sandbox !== undefined ? { sandbox: overrides.sandbox } : {}),
    ...(overrides.permission_mode !== undefined ? { permission_mode: overrides.permission_mode } : {}),
    ...(overrides.model_map !== undefined ? { model_map: overrides.model_map } : {}),
    ...(overrides.model_failover !== undefined ? { model_failover: overrides.model_failover } : {}),
  };
}

interface PersonaProviderOverrides {
  readonly planner?: ReadonlyArray<PipelineProvider>;
  readonly developer?: ReadonlyArray<PipelineProvider>;
  readonly code_reviewer?: ReadonlyArray<PipelineProvider>;
  readonly qa?: ReadonlyArray<PipelineProvider>;
}

function makeConfig(opts: {
  readonly providers: Record<string, PipelineProviderConfig>;
  readonly personaProviders: PersonaProviderOverrides;
  readonly tier?: ModelTier;
}): FactoryConfig {
  return ({
    project_name: 'cascade-test',
    factory_dir: '.',
    artifact_dir: '.',
    verification: { build: 'true', lint: 'true', test: 'true' },
    validation: { command: 'true' },
    infrastructure_patterns: [],
    completed_by_default: { kind: 'agent', id: 'x' },
    personas: {
      planner: { description: 'p', instructions: [], model: opts.tier ?? 'high' },
      developer: { description: 'd', instructions: [], model: opts.tier ?? 'high' },
      code_reviewer: { description: 'cr', instructions: [], model: opts.tier ?? 'medium' },
      qa: { description: 'qa', instructions: [], model: opts.tier ?? 'medium' },
    },
    pipeline: {
      providers: opts.providers,
      persona_providers: {
        planner: opts.personaProviders.planner ?? ['claude'],
        developer: opts.personaProviders.developer ?? ['codex'],
        code_reviewer: opts.personaProviders.code_reviewer ?? ['claude'],
        qa: opts.personaProviders.qa ?? ['claude'],
      },
      completion_identities: {
        developer: 'codex-dev',
        code_reviewer: 'claude-cr',
        qa: 'claude-qa',
      },
      max_review_iterations: 3,
    },
  } as unknown) as FactoryConfig;
}

function steps(...entries: Array<[PipelineProvider, string | undefined]>): CascadeStep[] {
  return entries.map(([provider, model]) => ({ provider, model }));
}

// ---------------------------------------------------------------------------
// Single-string persona_providers
// ---------------------------------------------------------------------------

describe('computeCascade — single-string persona_providers (length 1)', () => {
  it('direct provider, no model_failover, no model_map: one step with model undefined', () => {
    const config = makeConfig({
      providers: { codex: makeProvider() },
      personaProviders: { developer: ['codex'] },
    });
    expect(computeCascade('developer', 'high', config)).toEqual(steps(['codex', undefined]));
  });

  it('direct provider with model_map: one step with the tier-resolved model', () => {
    const config = makeConfig({
      providers: {
        codex: makeProvider({ model_map: { high: 'gpt-5', medium: 'gpt-5-mini', low: 'gpt-5-nano' } }),
      },
      personaProviders: { developer: ['codex'] },
    });
    expect(computeCascade('developer', 'medium', config)).toEqual(
      steps(['codex', 'gpt-5-mini']),
    );
  });

  it('tier missing from model_map: model is undefined (CLI default)', () => {
    const config = makeConfig({
      providers: {
        codex: makeProvider({ model_map: { high: 'gpt-5' } }),
      },
      personaProviders: { developer: ['codex'] },
    });
    expect(computeCascade('developer', 'low', config)).toEqual(steps(['codex', undefined]));
  });
});

// ---------------------------------------------------------------------------
// Multi-element persona_providers
// ---------------------------------------------------------------------------

describe('computeCascade — multi-element persona_providers (cross-CLI failover)', () => {
  it('two direct providers: one cascade step each, in order', () => {
    const config = makeConfig({
      providers: {
        codex: makeProvider(),
        claude: makeProvider(),
      },
      personaProviders: { developer: ['codex', 'claude'] },
    });
    expect(computeCascade('developer', 'high', config)).toEqual(
      steps(['codex', undefined], ['claude', undefined]),
    );
  });

  it('three direct providers with model_maps: tier resolves per CLI', () => {
    const config = makeConfig({
      providers: {
        codex: makeProvider({ model_map: { high: 'gpt-5' } }),
        claude: makeProvider({ model_map: { high: 'claude-opus-4-7' } }),
        copilot: makeProvider({ model_map: { high: 'github-copilot-default' } }),
      },
      personaProviders: { developer: ['codex', 'claude', 'copilot'] },
    });
    expect(computeCascade('developer', 'high', config)).toEqual(
      steps(
        ['codex', 'gpt-5'],
        ['claude', 'claude-opus-4-7'],
        ['copilot', 'github-copilot-default'],
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Abstraction provider with model_failover (within-CLI cascade)
// ---------------------------------------------------------------------------

describe('computeCascade — abstraction provider with model_failover', () => {
  it('expands model_failover into one step per model on the same CLI', () => {
    const config = makeConfig({
      providers: {
        copilot: makeProvider({
          model_map: { high: 'claude-opus-4-6', medium: 'GPT-5.4' },
          model_failover: ['claude-opus-4-6', 'GPT-5.4', 'claude-haiku-4-5'],
        }),
      },
      personaProviders: { developer: ['copilot'] },
    });
    expect(computeCascade('developer', 'high', config)).toEqual(
      steps(
        ['copilot', 'claude-opus-4-6'],
        ['copilot', 'GPT-5.4'],
        ['copilot', 'claude-haiku-4-5'],
      ),
    );
  });

  it('model_failover is independent of the persona tier (within-CLI order overrides tier resolution)', () => {
    const config = makeConfig({
      providers: {
        copilot: makeProvider({
          model_map: { high: 'M-A', medium: 'M-B' },
          // model_failover is the within-CLI cascade order; tier
          // resolution is NOT consulted when model_failover is present.
          model_failover: ['M-X', 'M-Y'],
        }),
      },
      personaProviders: { developer: ['copilot'] },
      tier: 'high',
    });
    expect(computeCascade('developer', 'high', config)).toEqual(
      steps(['copilot', 'M-X'], ['copilot', 'M-Y']),
    );
  });
});

// ---------------------------------------------------------------------------
// Mixed: abstraction + direct
// ---------------------------------------------------------------------------

describe('computeCascade — mixed abstraction + direct', () => {
  it('within-CLI failover expands first, then falls through to direct provider', () => {
    const config = makeConfig({
      providers: {
        copilot: makeProvider({
          model_failover: ['claude-opus-4-6', 'GPT-5.4'],
        }),
        codex: makeProvider(),
      },
      personaProviders: { developer: ['copilot', 'codex'] },
    });
    expect(computeCascade('developer', 'high', config)).toEqual(
      steps(
        ['copilot', 'claude-opus-4-6'],
        ['copilot', 'GPT-5.4'],
        ['codex', undefined],
      ),
    );
  });

  it('two abstraction providers: each expands within-CLI before the other', () => {
    const config = makeConfig({
      providers: {
        copilot: makeProvider({ model_failover: ['M-X', 'M-Y'] }),
        cursor: makeProvider({ model_failover: ['M-Z'] }),
      },
      personaProviders: {
        // 'cursor' is not a real provider name in PipelineProvider;
        // cast through unknown for the test fixture only. Production
        // configs are bound by the schema's enum.
        developer: ['copilot', 'cursor' as unknown as PipelineProvider],
      },
    });
    expect(computeCascade('developer', 'high', config)).toEqual(
      steps(
        ['copilot', 'M-X'],
        ['copilot', 'M-Y'],
        ['cursor' as PipelineProvider, 'M-Z'],
      ),
    );
  });

  it('direct then abstraction: direct one step then within-CLI expansion', () => {
    const config = makeConfig({
      providers: {
        codex: makeProvider({ model_map: { high: 'gpt-5' } }),
        copilot: makeProvider({ model_failover: ['M-X', 'M-Y'] }),
      },
      personaProviders: { developer: ['codex', 'copilot'] },
    });
    expect(computeCascade('developer', 'high', config)).toEqual(
      steps(['codex', 'gpt-5'], ['copilot', 'M-X'], ['copilot', 'M-Y']),
    );
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('computeCascade — edge cases', () => {
  it('persona_providers length 1, no model_failover: cascade has just one entry', () => {
    const config = makeConfig({
      providers: { codex: makeProvider() },
      personaProviders: { developer: ['codex'] },
    });
    const cascade = computeCascade('developer', 'high', config);
    expect(cascade.length).toBe(1);
    expect(cascade[0]?.provider).toBe('codex');
  });

  it('empty model_failover array: treated as no within-CLI failover (one step using tier)', () => {
    const config = makeConfig({
      providers: {
        copilot: makeProvider({
          model_map: { high: 'fallback-tier-model' },
          model_failover: [],
        }),
      },
      personaProviders: { developer: ['copilot'] },
    });
    expect(computeCascade('developer', 'high', config)).toEqual(
      steps(['copilot', 'fallback-tier-model']),
    );
  });

  it('persona_providers names a CLI that is not in providers: emits one step with model undefined', () => {
    const config = makeConfig({
      providers: {
        // Note: no 'codex' entry. The persona still references it.
        claude: makeProvider(),
      },
      personaProviders: { developer: ['codex', 'claude'] },
    });
    expect(computeCascade('developer', 'high', config)).toEqual(
      steps(['codex', undefined], ['claude', undefined]),
    );
  });

  it('returns [] when the pipeline config block is absent', () => {
    const config = ({
      project_name: 'no-pipeline',
      factory_dir: '.',
      artifact_dir: '.',
      verification: { build: 'true', lint: 'true', test: 'true' },
      validation: { command: 'true' },
      infrastructure_patterns: [],
      completed_by_default: { kind: 'agent', id: 'x' },
      personas: {
        planner: { description: '', instructions: [] },
        developer: { description: '', instructions: [] },
        code_reviewer: { description: '', instructions: [] },
        qa: { description: '', instructions: [] },
      },
    } as unknown) as FactoryConfig;
    expect(computeCascade('developer', 'high', config)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// All four personas exercise the same code path
// ---------------------------------------------------------------------------

describe('computeCascade — every PipelinePersona', () => {
  const personas: ReadonlyArray<PipelinePersona> = [
    'planner', 'developer', 'code_reviewer', 'qa',
  ];

  for (const persona of personas) {
    it(`computes a cascade for persona='${persona}'`, () => {
      const config = makeConfig({
        providers: {
          codex: makeProvider(),
          claude: makeProvider(),
        },
        personaProviders: { [persona]: ['codex', 'claude'] } as PersonaProviderOverrides,
      });
      const cascade = computeCascade(persona, 'high', config);
      expect(cascade.length).toBe(2);
      expect(cascade[0]?.provider).toBe('codex');
      expect(cascade[1]?.provider).toBe('claude');
    });
  }
});
