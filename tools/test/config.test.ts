/**
 * Tests for factory configuration utilities.
 */

import { describe, it, expect } from 'vitest';
import { resolveToolScriptPath, resolveFactoryRoot, resolveArtifactRoot } from '../config.js';
import type { FactoryConfig } from '../config.js';

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
    expect(result).toBe('/project/tools/plan.ts');
  });

  it('resolves to submodule dir when factory_dir is ".factory"', () => {
    const config = makeConfig({ factory_dir: '.factory' });
    const result = resolveToolScriptPath('plan.ts', '/project', config);
    expect(result).toBe('/project/.factory/tools/plan.ts');
  });

  it('resolves to submodule dir when factory_dir is "factory"', () => {
    const config = makeConfig({ factory_dir: 'factory' });
    const result = resolveToolScriptPath('supervise.ts', '/project', config);
    expect(result).toBe('/project/factory/tools/supervise.ts');
  });
});

describe('resolveFactoryRoot', () => {
  it('returns project root when factory_dir is "."', () => {
    const config = makeConfig({ factory_dir: '.' });
    expect(resolveFactoryRoot('/project', config)).toBe('/project');
  });

  it('returns submodule path when factory_dir is ".factory"', () => {
    const config = makeConfig({ factory_dir: '.factory' });
    expect(resolveFactoryRoot('/project', config)).toBe('/project/.factory');
  });
});

describe('resolveArtifactRoot', () => {
  it('returns project root when artifact_dir is "."', () => {
    const config = makeConfig({ artifact_dir: '.' });
    expect(resolveArtifactRoot('/project', config)).toBe('/project');
  });

  it('returns artifact subdir when artifact_dir is "factory"', () => {
    const config = makeConfig({ artifact_dir: 'factory' });
    expect(resolveArtifactRoot('/project', config)).toBe('/project/factory');
  });
});
