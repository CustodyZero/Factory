import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FactoryConfig } from '../config.js';
import { loadMemoryContext, writeMemorySuggestionReport } from '../pipeline/memory.js';

function makeConfig(overrides: Partial<FactoryConfig> = {}): FactoryConfig {
  return {
    project_name: 'test',
    factory_dir: '.factory',
    artifact_dir: 'factory',
    memory: {
      root_dir: 'memory',
      cache_dir: 'cache',
      suggestion_dir: 'suggestions',
      max_additional_files: 4,
      max_file_bytes: 16_384,
      max_cache_entries: 20,
    },
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

describe('loadMemoryContext', () => {
  it('loads the index plus targeted category files and reuses cache on second read', () => {
    const root = mkdtempSync(join(tmpdir(), 'factory-memory-'));
    try {
      mkdirSync(join(root, 'factory', 'memory', 'project-conventions'), { recursive: true });
      mkdirSync(join(root, 'factory', 'memory', 'recurring-failures'), { recursive: true });
      writeFileSync(join(root, 'factory', 'memory', 'MEMORY.md'), '# Memory\n\n- core index\n', 'utf-8');
      writeFileSync(
        join(root, 'factory', 'memory', 'project-conventions', 'ui.md'),
        '# UI Convention\n\nUse command palette terminology for navigation.\n',
        'utf-8',
      );
      writeFileSync(
        join(root, 'factory', 'memory', 'recurring-failures', 'routing.md'),
        '# Failure\n\nRouting regressions have occurred around navigation changes.\n',
        'utf-8',
      );

      const config = makeConfig();
      const first = loadMemoryContext({
        persona: 'developer',
        projectRoot: root,
        config,
        title: 'Navigation update',
        acceptanceCriteria: ['Command palette opens the new route'],
        changeClass: 'local',
      });
      expect(first.cache_hit).toBe(false);
      expect(first.block).toContain('## Project Memory');
      expect(first.block).toContain('MEMORY.md');
      expect(first.block).toContain('project-conventions/ui.md');

      const second = loadMemoryContext({
        persona: 'developer',
        projectRoot: root,
        config,
        title: 'Navigation update',
        acceptanceCriteria: ['Command palette opens the new route'],
        changeClass: 'local',
      });
      expect(second.cache_hit).toBe(true);
      expect(second.block).toBe(first.block);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('writeMemorySuggestionReport', () => {
  it('writes a human-review suggestion artifact under memory/suggestions', () => {
    const root = mkdtempSync(join(tmpdir(), 'factory-memory-suggest-'));
    try {
      mkdirSync(join(root, 'factory', 'memory'), { recursive: true });
      const config = makeConfig();
      const output = writeMemorySuggestionReport({
        projectRoot: root,
        config,
        specId: 'nav-refresh',
        featureId: 'nav-refresh',
        status: 'failed',
        packets: [
          {
            id: 'nav-refresh-dev',
            title: 'Refresh navigation',
            change_class: 'cross_cutting',
            instructions: ['Preserve command palette behavior'],
            failure: { scenario: 'TestFailed', reason: 'navigation test broke' },
          },
        ],
      });
      expect(output).not.toBeNull();
      const content = readFileSync(output!, 'utf-8');
      expect(content).toContain('Memory suggestions for nav-refresh');
      expect(content).toContain('Preserve command palette behavior');
      expect(content).toContain('TestFailed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
