#!/usr/bin/env tsx
/**
 * Factory — Completion Gate
 *
 * Pre-commit enforcement: blocks commits that advance packet-scoped
 * implementation work without a corresponding completion record.
 *
 * Rule (FI-7 — Commit-time completion enforcement):
 *   A commit MUST NOT include non-factory implementation files while
 *   any started packet lacks a completion record.
 *
 * Allowed exceptions:
 *   1. Factory-only commits: all staged files match infrastructure patterns
 *   2. Infrastructure commits: no implementation files staged
 *
 * Infrastructure patterns are configured in factory.config.json.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, isInfrastructureFile, resolveArtifactRoot } from './config.js';
import type { FactoryConfig } from './config.js';
import * as fmt from './output.js';

// ---------------------------------------------------------------------------
// Types (exported for testing)
// ---------------------------------------------------------------------------

export interface PacketInfo {
  readonly id: string;
  readonly started_at: string | null;
  readonly status: string | null;
}

export interface GateInput {
  readonly stagedFiles: ReadonlyArray<string>;
  readonly packets: ReadonlyArray<PacketInfo>;
  readonly completionIds: ReadonlySet<string>;
  readonly config: FactoryConfig;
}

export interface GateResult {
  readonly blocked: boolean;
  readonly reason: string;
  readonly incompletePackets: ReadonlyArray<string>;
  readonly implementationFiles: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Core gate logic (pure, testable)
// ---------------------------------------------------------------------------

export function evaluateCompletionGate(input: GateInput): GateResult {
  // Find packets that are started but have no completion
  const incompletePackets: string[] = [];
  for (const packet of input.packets) {
    if (
      packet.started_at !== null &&
      packet.status !== 'abandoned' &&
      packet.status !== 'deferred' &&
      !input.completionIds.has(packet.id)
    ) {
      incompletePackets.push(packet.id);
    }
  }

  if (incompletePackets.length === 0) {
    return {
      blocked: false,
      reason: 'No incomplete packets — commit allowed.',
      incompletePackets: [],
      implementationFiles: [],
    };
  }

  // Find staged files that are implementation work
  const implementationFiles: string[] = [];
  for (const file of input.stagedFiles) {
    if (!isInfrastructureFile(file, input.config)) {
      implementationFiles.push(file);
    }
  }

  if (implementationFiles.length === 0) {
    return {
      blocked: false,
      reason: 'Only factory/infrastructure files staged — commit allowed.',
      incompletePackets,
      implementationFiles: [],
    };
  }

  const packetList = incompletePackets.map((id) => `  - ${id}`).join('\n');
  const fileList = implementationFiles.slice(0, 10).map((f) => `  - ${f}`).join('\n');
  const truncated = implementationFiles.length > 10
    ? `\n  ... and ${String(implementationFiles.length - 10)} more`
    : '';

  return {
    blocked: true,
    reason:
      `FI-7 violation: Implementation files are staged but the following packet(s) are started without completion:\n` +
      `\n${packetList}\n` +
      `\nStaged implementation files:\n${fileList}${truncated}\n` +
      `\nTo fix:\n` +
      `  1. Create completion record(s): npx tsx tools/complete.ts <packet-id>\n` +
      `  2. Stage the completion: git add completions/<packet-id>.json\n` +
      `  3. Re-run your commit\n` +
      `\nAlternatively, if this commit is unrelated to the active packet:\n` +
      `  - Ensure the incomplete packet is completed first\n` +
      `  - Or mark it as deferred: add "status": "deferred" to the packet JSON`,
    incompletePackets,
    implementationFiles,
  };
}

// ---------------------------------------------------------------------------
// I/O layer
// ---------------------------------------------------------------------------

function readPacketInfos(artifactRoot: string): PacketInfo[] {
  const dir = join(artifactRoot, 'packets');
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const results: PacketInfo[] = [];

  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), 'utf-8');
      const data = JSON.parse(raw) as Record<string, unknown>;
      results.push({
        id: typeof data['id'] === 'string' ? data['id'] : '',
        started_at: typeof data['started_at'] === 'string' ? data['started_at'] : null,
        status: typeof data['status'] === 'string' ? data['status'] : null,
      });
    } catch {
      // Skip unparseable files
    }
  }

  return results;
}

function readCompletionIds(artifactRoot: string): Set<string> {
  const dir = join(artifactRoot, 'completions');
  if (!existsSync(dir)) return new Set();

  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const ids = new Set<string>();

  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), 'utf-8');
      const data = JSON.parse(raw) as Record<string, unknown>;
      if (typeof data['packet_id'] === 'string') {
        ids.add(data['packet_id']);
      }
    } catch {
      // Skip unparseable
    }
  }

  return ids;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function main(): void {
  const config = loadConfig();
  const artifactRoot = resolveArtifactRoot(undefined, config);

  // Get staged files from git
  let stagedFiles: string[];
  try {
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const output = execSync('git diff --cached --name-only', {
      cwd: artifactRoot,
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim();
    stagedFiles = output.length > 0 ? output.split('\n') : [];
  } catch {
    console.log('completion-gate: Could not read staged files. Skipping gate.');
    process.exit(0);
  }

  if (stagedFiles.length === 0) {
    process.exit(0);
  }

  const packets = readPacketInfos(artifactRoot);
  const completionIds = readCompletionIds(artifactRoot);

  const result = evaluateCompletionGate({
    stagedFiles,
    packets,
    completionIds,
    config,
  });

  if (result.blocked) {
    console.error(`\n${fmt.divider()}`);
    console.error(`${fmt.sym.blocked} ${fmt.error('COMPLETION GATE BLOCKED')}`);
    console.error(`${fmt.divider()}\n`);
    console.error(result.reason);
    console.error(`\n${fmt.divider()}\n`);
    process.exit(1);
  }
}

// Only run main when executed directly
const isDirectExecution = process.argv[1]?.endsWith('completion-gate.ts') ||
  process.argv[1]?.endsWith('completion-gate.js');
if (isDirectExecution) {
  main();
}
