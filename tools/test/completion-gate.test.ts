/**
 * Tests for the completion gate — the pure evaluation logic.
 */

import { describe, it, expect } from 'vitest';
import { evaluateCompletionGate } from '../completion-gate.js';
import type { GateInput, PacketInfo } from '../completion-gate.js';
import type { FactoryConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testConfig: FactoryConfig = {
  project_name: 'test-project',
  verification: { build: 'echo build', lint: 'echo lint', test: 'echo test' },
  validation: { command: 'echo validate' },
  infrastructure_patterns: [
    'factory/',
    'tools/',
    '.githooks/',
    '.github/',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.json',
    'turbo.json',
    '.gitignore',
    '.eslintrc.json',
    '.eslintignore',
    'CLAUDE.md',
    'AGENTS.md',
    'README.md',
    'LICENSE',
  ],
  completed_by_default: { kind: 'agent', id: 'test' },
};

function makePacket(id: string, started_at: string | null = '2026-03-20T00:00:00Z', status: string | null = null): PacketInfo {
  return { id, started_at, status };
}

function makeInput(overrides: Partial<Omit<GateInput, 'config'>> = {}): GateInput {
  return {
    stagedFiles: overrides.stagedFiles ?? [],
    packets: overrides.packets ?? [],
    completionIds: overrides.completionIds ?? new Set(),
    config: testConfig,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('evaluateCompletionGate', () => {
  it('CG-U1: passes when no packets exist', () => {
    const result = evaluateCompletionGate(makeInput({
      stagedFiles: ['packages/kernel/src/foo.ts'],
      packets: [],
    }));
    expect(result.blocked).toBe(false);
    expect(result.incompletePackets).toEqual([]);
  });

  it('CG-U2: passes when all started packets have completions', () => {
    const result = evaluateCompletionGate(makeInput({
      stagedFiles: ['packages/kernel/src/foo.ts'],
      packets: [makePacket('s10'), makePacket('s11')],
      completionIds: new Set(['s10', 's11']),
    }));
    expect(result.blocked).toBe(false);
  });

  it('CG-U3: passes for factory-only commits even with incomplete packets', () => {
    const result = evaluateCompletionGate(makeInput({
      stagedFiles: [
        'factory/packets/s12.json',
        'factory/completions/s10.json',
      ],
      packets: [makePacket('s10')],
      completionIds: new Set(),
    }));
    expect(result.blocked).toBe(false);
    expect(result.implementationFiles).toEqual([]);
  });

  it('CG-U4: blocks when incomplete packet exists and implementation files staged', () => {
    const result = evaluateCompletionGate(makeInput({
      stagedFiles: ['packages/kernel/src/types/module.ts'],
      packets: [makePacket('s10')],
      completionIds: new Set(),
    }));
    expect(result.blocked).toBe(true);
    expect(result.incompletePackets).toContain('s10');
    expect(result.implementationFiles).toContain('packages/kernel/src/types/module.ts');
    expect(result.reason).toContain('FI-7');
  });

  it('CG-U5: lists all incomplete packets when blocking', () => {
    const result = evaluateCompletionGate(makeInput({
      stagedFiles: ['packages/cli/src/commands/foo.ts'],
      packets: [makePacket('s10'), makePacket('s11'), makePacket('s12')],
      completionIds: new Set(['s10']),
    }));
    expect(result.blocked).toBe(true);
    expect(result.incompletePackets).toContain('s11');
    expect(result.incompletePackets).toContain('s12');
    expect(result.incompletePackets).not.toContain('s10');
  });

  it('CG-U6: ignores not-started packets (no started_at)', () => {
    const result = evaluateCompletionGate(makeInput({
      stagedFiles: ['packages/kernel/src/foo.ts'],
      packets: [makePacket('s10', null)],
      completionIds: new Set(),
    }));
    expect(result.blocked).toBe(false);
  });

  it('CG-U7: ignores abandoned packets', () => {
    const result = evaluateCompletionGate(makeInput({
      stagedFiles: ['packages/kernel/src/foo.ts'],
      packets: [makePacket('s10', '2026-03-20T00:00:00Z', 'abandoned')],
      completionIds: new Set(),
    }));
    expect(result.blocked).toBe(false);
  });

  it('CG-U8: ignores deferred packets', () => {
    const result = evaluateCompletionGate(makeInput({
      stagedFiles: ['packages/kernel/src/foo.ts'],
      packets: [makePacket('s10', '2026-03-20T00:00:00Z', 'deferred')],
      completionIds: new Set(),
    }));
    expect(result.blocked).toBe(false);
  });

  it('CG-U9: .githooks files do not count as implementation', () => {
    const result = evaluateCompletionGate(makeInput({
      stagedFiles: ['.githooks/pre-commit'],
      packets: [makePacket('s10')],
      completionIds: new Set(),
    }));
    expect(result.blocked).toBe(false);
  });

  it('CG-U10: .github files do not count as implementation', () => {
    const result = evaluateCompletionGate(makeInput({
      stagedFiles: ['.github/workflows/ci.yml'],
      packets: [makePacket('s10')],
      completionIds: new Set(),
    }));
    expect(result.blocked).toBe(false);
  });

  it('CG-U11: tools/ files do not count as implementation', () => {
    const result = evaluateCompletionGate(makeInput({
      stagedFiles: ['tools/factory/status.ts'],
      packets: [makePacket('s10')],
      completionIds: new Set(),
    }));
    expect(result.blocked).toBe(false);
  });

  it('CG-U12: root config files do not count as implementation', () => {
    const result = evaluateCompletionGate(makeInput({
      stagedFiles: ['package.json', 'pnpm-lock.yaml', 'tsconfig.json'],
      packets: [makePacket('s10')],
      completionIds: new Set(),
    }));
    expect(result.blocked).toBe(false);
  });

  it('CG-U13: non-infrastructure package.json counts as implementation', () => {
    const result = evaluateCompletionGate(makeInput({
      stagedFiles: ['packages/cli/package.json'],
      packets: [makePacket('s10')],
      completionIds: new Set(),
    }));
    expect(result.blocked).toBe(true);
  });

  it('CG-U14: mixed commit blocks if any implementation files present', () => {
    const result = evaluateCompletionGate(makeInput({
      stagedFiles: [
        'factory/packets/s10.json',
        'packages/kernel/src/foo.ts',
      ],
      packets: [makePacket('s10')],
      completionIds: new Set(),
    }));
    expect(result.blocked).toBe(true);
    expect(result.implementationFiles).toEqual(['packages/kernel/src/foo.ts']);
  });

  it('CG-U15: passes when implementation and completion are both staged', () => {
    const result = evaluateCompletionGate(makeInput({
      stagedFiles: [
        'packages/kernel/src/foo.ts',
        'factory/completions/s10.json',
      ],
      packets: [makePacket('s10')],
      completionIds: new Set(['s10']),
    }));
    expect(result.blocked).toBe(false);
  });

  it('CG-U16: passes with no staged files', () => {
    const result = evaluateCompletionGate(makeInput({
      stagedFiles: [],
      packets: [makePacket('s10')],
      completionIds: new Set(),
    }));
    expect(result.blocked).toBe(false);
  });
});
