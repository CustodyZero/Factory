/**
 * Tests for factory configuration utilities.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadConfig,
  normalizePersonaProvider,
  normalizeProviderCommand,
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
            command: 'gh',
            prefix_args: ['copilot', '--'],
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

// ---------------------------------------------------------------------------
// DEP0190 — normalizeProviderCommand (pure helper)
//
// Pins the (command, prefix_args) normalization contract directly,
// independent of the surrounding loader. The loader-integration block
// below exercises the full path including warning frequency.
// ---------------------------------------------------------------------------

describe('normalizeProviderCommand (DEP0190)', () => {
  it('passes through the new shape unchanged (single-token command + prefix_args array)', () => {
    const recorded: Array<{ name: string; rawCommand: string }> = [];
    const out = normalizeProviderCommand(
      'copilot',
      'gh',
      ['copilot', '--'],
      (name, rawCommand) => { recorded.push({ name, rawCommand }); },
    );
    expect(out.command).toBe('gh');
    expect(out.prefix_args).toEqual(['copilot', '--']);
    // No legacy-shape signal.
    expect(recorded).toEqual([]);
  });

  it('passes through a bare single-token command with no prefix_args (codex/claude shape)', () => {
    const recorded: Array<{ name: string; rawCommand: string }> = [];
    const out = normalizeProviderCommand(
      'codex',
      'codex',
      undefined,
      (name, rawCommand) => { recorded.push({ name, rawCommand }); },
    );
    expect(out.command).toBe('codex');
    expect(out.prefix_args).toBeUndefined();
    expect(recorded).toEqual([]);
  });

  it('normalizes the legacy whitespace-string shape and signals the migration', () => {
    const recorded: Array<{ name: string; rawCommand: string }> = [];
    const out = normalizeProviderCommand(
      'copilot',
      'gh copilot --',
      undefined,
      (name, rawCommand) => { recorded.push({ name, rawCommand }); },
    );
    expect(out.command).toBe('gh');
    expect(out.prefix_args).toEqual(['copilot', '--']);
    expect(recorded).toEqual([{ name: 'copilot', rawCommand: 'gh copilot --' }]);
  });

  it('rejects the ambiguous shape (whitespace command AND prefix_args set)', () => {
    expect(() =>
      normalizeProviderCommand(
        'copilot',
        'gh copilot --',
        ['copilot', '--'],
        () => undefined,
      ),
    ).toThrow(/both a whitespace-containing command.*prefix_args.*mutually exclusive/i);
  });

  it('preserves absolute paths containing spaces as a single argv token (path-separator disambiguates from legacy)', () => {
    // Absolute POSIX paths with internal spaces are legitimate
    // (e.g. macOS /Applications/Tool With Space/...) under
    // shell:false. The disambiguation rule (round-2 fix) keys on
    // the presence of a path separator (`/`): commands containing
    // `/` are paths and pass through unchanged; whitespace alone
    // no longer triggers the legacy split. No deprecation warning
    // fires for path-shaped commands.
    const recorded: Array<{ name: string; rawCommand: string }> = [];
    const out = normalizeProviderCommand(
      'codex',
      '/Applications/Tool With Space/bin/codex',
      undefined,
      (name, rawCommand) => { recorded.push({ name, rawCommand }); },
    );
    expect(out.command).toBe('/Applications/Tool With Space/bin/codex');
    expect(out.prefix_args).toBeUndefined();
    // Path shape — not legacy — so no warning callback fired.
    expect(recorded).toEqual([]);
  });

  it('preserves absolute paths containing spaces together with explicit prefix_args (no ambiguous-shape rejection)', () => {
    // Path + prefix_args is the documented new shape for an
    // absolute-path executable carrying leading argv. The
    // ambiguous-shape rejection must NOT fire here: that rule is
    // only for bare-name legacy collisions.
    const recorded: Array<{ name: string; rawCommand: string }> = [];
    const out = normalizeProviderCommand(
      'codex',
      '/Applications/Tool With Space/bin/codex',
      ['--flag'],
      (name, rawCommand) => { recorded.push({ name, rawCommand }); },
    );
    expect(out.command).toBe('/Applications/Tool With Space/bin/codex');
    expect(out.prefix_args).toEqual(['--flag']);
    expect(recorded).toEqual([]);
  });

  it('preserves relative paths (with or without spaces) as a single argv token', () => {
    // Relative paths contain `/` but do not start with `/` — the
    // path-separator rule covers them too. Both forms (with and
    // without internal whitespace) passthrough unchanged.
    const recordedClean: Array<{ name: string; rawCommand: string }> = [];
    const outClean = normalizeProviderCommand(
      'tool',
      './local/tool',
      undefined,
      (name, rawCommand) => { recordedClean.push({ name, rawCommand }); },
    );
    expect(outClean.command).toBe('./local/tool');
    expect(outClean.prefix_args).toBeUndefined();
    expect(recordedClean).toEqual([]);

    const recordedSpace: Array<{ name: string; rawCommand: string }> = [];
    const outSpace = normalizeProviderCommand(
      'tool',
      './local/tool with space',
      undefined,
      (name, rawCommand) => { recordedSpace.push({ name, rawCommand }); },
    );
    expect(outSpace.command).toBe('./local/tool with space');
    expect(outSpace.prefix_args).toBeUndefined();
    expect(recordedSpace).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DEP0190 — loadConfig integration (deprecation warning + dual acceptance)
//
// Pins the on-disk -> in-memory normalization for the new and legacy
// provider-command shapes, including the warning frequency contract.
// ---------------------------------------------------------------------------

describe('loadConfig — DEP0190 provider command normalization', () => {
  it('accepts the new shape (single-token command + prefix_args) with NO deprecation warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const dir = writeConfigDir({
        pipeline: {
          providers: {
            codex: { enabled: true, command: 'codex' },
            claude: { enabled: true, command: 'claude' },
            copilot: {
              enabled: true,
              command: 'gh',
              prefix_args: ['copilot', '--'],
            },
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
      expect(cfg.pipeline?.providers['copilot']?.command).toBe('gh');
      expect(cfg.pipeline?.providers['copilot']?.prefix_args).toEqual(['copilot', '--']);
      // No DEP0190-style warning fired.
      const dep0190Calls = warnSpy.mock.calls.filter(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('DEP0190'),
      );
      expect(dep0190Calls).toEqual([]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('normalizes the legacy whitespace-string shape into split form', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const dir = writeConfigDir({
        pipeline: {
          providers: {
            codex: { enabled: true, command: 'codex' },
            claude: { enabled: true, command: 'claude' },
            copilot: { enabled: true, command: 'gh copilot --' },
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
      // Downstream consumers see the split shape only.
      expect(cfg.pipeline?.providers['copilot']?.command).toBe('gh');
      expect(cfg.pipeline?.providers['copilot']?.prefix_args).toEqual(['copilot', '--']);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('emits the deprecation warning exactly once per loadConfig call (not once per provider)', () => {
    // Two legacy-shape providers in the same config should still
    // result in ONE console.warn line — not two — naming both.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const dir = writeConfigDir({
        pipeline: {
          providers: {
            // Two legacy-shape providers.
            copilot: { enabled: true, command: 'gh copilot --' },
            // A second one: a hypothetical operator-defined provider.
            // We name it after an existing key to exercise the
            // multi-provider warning aggregation.
            custom: { enabled: true, command: 'my-cli sub --' } as never,
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
      // Both normalized correctly.
      expect(cfg.pipeline?.providers['copilot']?.command).toBe('gh');
      expect(cfg.pipeline?.providers['copilot']?.prefix_args).toEqual(['copilot', '--']);
      expect(cfg.pipeline?.providers['custom']?.command).toBe('my-cli');
      expect(cfg.pipeline?.providers['custom']?.prefix_args).toEqual(['sub', '--']);
      // Exactly one warn call mentioning DEP0190, naming both
      // providers.
      const dep0190Calls = warnSpy.mock.calls.filter(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('DEP0190'),
      );
      expect(dep0190Calls).toHaveLength(1);
      const message = dep0190Calls[0]![0] as string;
      expect(message).toContain("'copilot'");
      expect(message).toContain("'custom'");
      expect(message).toContain('specs/dep0190-shell-removal.md');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('emits NO deprecation warning when every provider uses the new shape (per-load frequency contract)', () => {
    // Even the copilot default migration target carries the new
    // shape internally, so a clean config with new-shape entries
    // must not emit any DEP0190 warning at all.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const dir = writeConfigDir({
        pipeline: {
          providers: {
            codex: { enabled: true, command: 'codex' },
            claude: { enabled: true, command: 'claude' },
            copilot: { enabled: false, command: 'gh', prefix_args: ['copilot', '--'] },
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
      loadConfig(dir);
      const dep0190Calls = warnSpy.mock.calls.filter(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('DEP0190'),
      );
      expect(dep0190Calls).toEqual([]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('rejects the ambiguous shape (whitespace command AND prefix_args set on the same provider)', () => {
    const dir = writeConfigDir({
      pipeline: {
        providers: {
          codex: { enabled: true, command: 'codex' },
          claude: { enabled: true, command: 'claude' },
          copilot: {
            enabled: true,
            // Both a whitespace-containing command AND prefix_args
            // — ambiguous. Loader must refuse.
            command: 'gh copilot --',
            prefix_args: ['copilot', '--'],
          },
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
    // The loader's catch block in `loadConfig` redirects parse/throw
    // errors to console.error + process.exit(1). We need to assert
    // on that surface here. Spy on process.exit so the test doesn't
    // actually exit, and spy on console.error to capture the
    // message.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      loadConfig(dir);
      // Exit was called.
      expect(exitSpy).toHaveBeenCalledWith(1);
      // The error message names the conflict.
      const errorCalls = errSpy.mock.calls.map((c) => c.join(' '));
      const composed = errorCalls.join(' | ');
      expect(composed).toMatch(/copilot/i);
      expect(composed).toMatch(/mutually exclusive|whitespace-containing command/i);
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
