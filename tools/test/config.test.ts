/**
 * Tests for factory configuration utilities.
 */

import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadConfig,
  normalizePersonaProvider,
  resolveArtifactRoot,
  resolveFactoryRoot,
  resolveToolScriptPath,
} from '../config.js';
import type { FactoryConfig, PipelineProvider } from '../config.js';

function makeConfig(overrides: Partial<FactoryConfig> = {}): FactoryConfig {
  return {
    project_name: 'test',
    factory_dir: '.',
    artifact_dir: '.',
    verification: { build: 'true', lint: 'true', test: 'true' },
    validation: { command: 'true' },
    infrastructure_patterns: [],
    completed_by_default: { kind: 'agent', id: 'test' },
    personas: {
      planner: { description: 'planner', instructions: [] },
      developer: { description: 'dev', instructions: [] },
      code_reviewer: { description: 'cr', instructions: [] },
      qa: { description: 'qa', instructions: [] },
    },
    ...overrides,
  } as FactoryConfig;
}

describe('resolveToolScriptPath', () => {
  it('resolves to project root when factory_dir is "."', () => {
    const config = makeConfig({ factory_dir: '.' });
    const result = resolveToolScriptPath('plan.ts', '/project', config);
    expect(result).toBe(join('/project', 'tools', 'plan.ts'));
  });

  it('resolves to submodule dir when factory_dir is ".factory"', () => {
    const config = makeConfig({ factory_dir: '.factory' });
    const result = resolveToolScriptPath('plan.ts', '/project', config);
    expect(result).toBe(join('/project', '.factory', 'tools', 'plan.ts'));
  });

  it('resolves to submodule dir when factory_dir is "factory"', () => {
    const config = makeConfig({ factory_dir: 'factory' });
    const result = resolveToolScriptPath('run.ts', '/project', config);
    expect(result).toBe(join('/project', 'factory', 'tools', 'run.ts'));
  });
});

describe('resolveFactoryRoot', () => {
  it('returns project root when factory_dir is "."', () => {
    const config = makeConfig({ factory_dir: '.' });
    expect(resolveFactoryRoot('/project', config)).toBe('/project');
  });

  it('returns submodule path when factory_dir is ".factory"', () => {
    const config = makeConfig({ factory_dir: '.factory' });
    expect(resolveFactoryRoot('/project', config)).toBe(join('/project', '.factory'));
  });
});

describe('resolveArtifactRoot', () => {
  it('returns project root when artifact_dir is "."', () => {
    const config = makeConfig({ artifact_dir: '.' });
    expect(resolveArtifactRoot('/project', config)).toBe('/project');
  });

  it('returns artifact subdir when artifact_dir is "factory"', () => {
    const config = makeConfig({ artifact_dir: 'factory' });
    expect(resolveArtifactRoot('/project', config)).toBe(join('/project', 'factory'));
  });
});

// ---------------------------------------------------------------------------
// Phase 7 — normalizePersonaProvider
//
// `persona_providers.<persona>` accepts `string | string[]` on disk;
// the loader normalizes to `ReadonlyArray<PipelineProvider>`. These
// tests pin every shape — including the empty-array degenerate case
// that falls back to defaults.
// ---------------------------------------------------------------------------

describe('normalizePersonaProvider (Phase 7)', () => {
  const defaults: ReadonlyArray<PipelineProvider> = ['claude'];

  it('normalizes a single string to a one-element array', () => {
    expect(normalizePersonaProvider('codex', defaults)).toEqual(['codex']);
  });

  it('keeps a multi-element array as-is', () => {
    expect(normalizePersonaProvider(['copilot', 'claude', 'codex'], defaults)).toEqual([
      'copilot',
      'claude',
      'codex',
    ]);
  });

  it('returns defaults when raw is undefined', () => {
    expect(normalizePersonaProvider(undefined, defaults)).toBe(defaults);
  });

  it('falls back to defaults for an empty array (degenerate case)', () => {
    expect(normalizePersonaProvider([], defaults)).toBe(defaults);
  });

  it('keeps a single-element array distinct from a string', () => {
    expect(normalizePersonaProvider(['codex'], defaults)).toEqual(['codex']);
  });
});

// ---------------------------------------------------------------------------
// Phase 7 — loadConfig integration with persona_providers
//
// Pin the on-disk -> in-memory normalization across both the legacy
// single-string form and the new array form.
// ---------------------------------------------------------------------------

let configDirs: string[] = [];

afterEach(() => {
  for (const d of configDirs) rmSync(d, { recursive: true, force: true });
  configDirs = [];
});

function writeConfigDir(rawConfig: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-config-test-'));
  configDirs.push(dir);
  // Minimal but schema-valid base; the persona_providers shape is the
  // only thing each test varies.
  const base = {
    project_name: 'cfg-test',
    factory_dir: '.',
    artifact_dir: '.',
    verification: { build: 'true', lint: 'true', test: 'true' },
    validation: { command: 'true' },
    infrastructure_patterns: [],
    completed_by_default: { kind: 'agent', id: 'x' },
    personas: {
      planner: { description: 'p', instructions: [] },
      developer: { description: 'd', instructions: [] },
      code_reviewer: { description: 'cr', instructions: [] },
      qa: { description: 'qa', instructions: [] },
    },
  };
  const merged = { ...base, ...rawConfig };
  writeFileSync(join(dir, 'factory.config.json'), JSON.stringify(merged, null, 2), 'utf-8');
  // status/cost/etc. directories may be expected by other tests; not
  // needed here — loadConfig only reads factory.config.json.
  void mkdirSync;
  return dir;
}

describe('loadConfig — Phase 7 persona_providers normalization', () => {
  it('accepts the legacy single-string form and yields a one-element array', () => {
    const dir = writeConfigDir({
      pipeline: {
        providers: {
          codex: { enabled: true, command: 'codex' },
          claude: { enabled: true, command: 'claude' },
        },
        persona_providers: {
          planner: 'claude',
          developer: 'codex',
          code_reviewer: 'claude',
          qa: 'claude',
        },
        completion_identities: {
          developer: 'codex-dev', code_reviewer: 'claude-cr', qa: 'claude-qa',
        },
        max_review_iterations: 3,
      },
    });
    const cfg = loadConfig(dir);
    expect(cfg.pipeline?.persona_providers.planner).toEqual(['claude']);
    expect(cfg.pipeline?.persona_providers.developer).toEqual(['codex']);
    expect(cfg.pipeline?.persona_providers.code_reviewer).toEqual(['claude']);
    expect(cfg.pipeline?.persona_providers.qa).toEqual(['claude']);
  });

  it('accepts the new multi-element array form and preserves order', () => {
    const dir = writeConfigDir({
      pipeline: {
        providers: {
          codex: { enabled: true, command: 'codex' },
          claude: { enabled: true, command: 'claude' },
          copilot: { enabled: true, command: 'gh copilot --' },
        },
        persona_providers: {
          planner: ['claude'],
          developer: ['copilot', 'claude', 'codex'],
          code_reviewer: ['claude', 'copilot'],
          qa: ['claude'],
        },
        completion_identities: {
          developer: 'codex-dev', code_reviewer: 'claude-cr', qa: 'claude-qa',
        },
        max_review_iterations: 3,
      },
    });
    const cfg = loadConfig(dir);
    expect(cfg.pipeline?.persona_providers.developer).toEqual(['copilot', 'claude', 'codex']);
    expect(cfg.pipeline?.persona_providers.code_reviewer).toEqual(['claude', 'copilot']);
  });

  it('accepts mixed-shape config (some personas single string, others arrays)', () => {
    const dir = writeConfigDir({
      pipeline: {
        providers: {
          codex: { enabled: true, command: 'codex' },
          claude: { enabled: true, command: 'claude' },
          copilot: { enabled: true, command: 'gh copilot --' },
        },
        persona_providers: {
          planner: 'claude',                       // legacy single-string
          developer: ['copilot', 'codex'],         // new array
          code_reviewer: ['claude'],               // single-element array
          qa: 'claude',                            // legacy single-string
        },
        completion_identities: {
          developer: 'codex-dev', code_reviewer: 'claude-cr', qa: 'claude-qa',
        },
        max_review_iterations: 3,
      },
    });
    const cfg = loadConfig(dir);
    expect(cfg.pipeline?.persona_providers.planner).toEqual(['claude']);
    expect(cfg.pipeline?.persona_providers.developer).toEqual(['copilot', 'codex']);
    expect(cfg.pipeline?.persona_providers.code_reviewer).toEqual(['claude']);
    expect(cfg.pipeline?.persona_providers.qa).toEqual(['claude']);
  });

  it('defaults model_failover to undefined when absent', () => {
    const dir = writeConfigDir({
      pipeline: {
        providers: {
          codex: { enabled: true, command: 'codex' },
          claude: { enabled: true, command: 'claude' },
        },
        persona_providers: {
          planner: 'claude', developer: 'codex', code_reviewer: 'claude', qa: 'claude',
        },
        completion_identities: {
          developer: 'codex-dev', code_reviewer: 'claude-cr', qa: 'claude-qa',
        },
        max_review_iterations: 3,
      },
    });
    const cfg = loadConfig(dir);
    expect(cfg.pipeline?.providers['codex']?.model_failover).toBeUndefined();
    expect(cfg.pipeline?.providers['claude']?.model_failover).toBeUndefined();
  });

  it('passes through model_failover on a provider when present', () => {
    const dir = writeConfigDir({
      pipeline: {
        providers: {
          codex: { enabled: true, command: 'codex' },
          claude: { enabled: true, command: 'claude' },
          copilot: {
            enabled: true,
            command: 'gh copilot --',
            model_map: { high: 'claude-opus-4-6', medium: 'GPT-5.4' },
            model_failover: ['claude-opus-4-6', 'GPT-5.4'],
          },
        },
        persona_providers: {
          planner: 'claude', developer: 'copilot', code_reviewer: 'claude', qa: 'claude',
        },
        completion_identities: {
          developer: 'copilot-dev', code_reviewer: 'claude-cr', qa: 'claude-qa',
        },
        max_review_iterations: 3,
      },
    });
    const cfg = loadConfig(dir);
    expect(cfg.pipeline?.providers['copilot']?.model_failover).toEqual([
      'claude-opus-4-6',
      'GPT-5.4',
    ]);
    // Direct providers without the field still report undefined.
    expect(cfg.pipeline?.providers['codex']?.model_failover).toBeUndefined();
  });
});
