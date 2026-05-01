#!/usr/bin/env tsx
/**
 * Factory — Completion Record Generator (CLI)
 *
 * Creates a completion record for a packet after running verification.
 * Runs build, lint, and tests (from factory.config.json), collects
 * changed files from git, and writes completions/<packet-id>.json.
 *
 * Usage:
 *   npx tsx tools/complete.ts <packet-id> [--summary "..."] [--identity <id>]
 *
 * Phase 3 of specs/single-entry-pipeline.md moved the implementation to
 * tools/lifecycle/complete.ts so run.ts can call it via import. This file
 * remains as the agent-facing CLI: argument parsing, output rendering,
 * the post-completion validation hook, and exit codes.
 *
 * Re-exports completePacket and the option/result types for backward
 * compatibility with any caller that imported them from this path before
 * Phase 3.
 *
 * Idempotency:
 *   If a completion record already exists, this script prints
 *   "Packet '<id>' is already complete. No action taken." and exits 0
 *   WITHOUT re-running build/lint/test. The FI-1 invariant is preserved
 *   in the library function (refuses to overwrite); the CLI just renders
 *   that signal.
 */

import { execSync } from 'node:child_process';
import { completePacket } from './lifecycle/complete.js';
import type { CompleteOptions, CompleteResult } from './lifecycle/complete.js';
import { loadConfig, findProjectRoot } from './config.js';
import * as fmt from './output.js';

export { completePacket };
export type { CompleteOptions, CompleteResult };

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  const packetId = args[0];
  const summaryIdx = args.indexOf('--summary');
  const customSummary = summaryIdx !== -1 ? args[summaryIdx + 1] : undefined;
  const identityIdx = args.indexOf('--identity');
  const identityOverride = identityIdx !== -1 ? args[identityIdx + 1] : undefined;

  if (packetId == null || packetId === '' || packetId.startsWith('--')) {
    console.error('Usage: npx tsx tools/complete.ts <packet-id> [--summary "..."] [--identity <id>]');
    process.exit(1);
  }

  try {
    const result = completePacket({ packetId, summary: customSummary, identity: identityOverride });

    if (result.already_complete) {
      console.log(`Packet '${packetId}' is already complete. No action taken.`);
      process.exit(0);
    }

    console.log(`\nCreating completion for: ${packetId}\n`);
    console.log(`\nCompletion written: completions/${packetId}.json`);
    console.log(`  Packet status updated to: completed`);

    if (!result.ci_pass) {
      console.log(`\n${fmt.sym.warn} ${fmt.warn('Verification did not fully pass.')}`);
    }

    // Re-validate
    const config = loadConfig();
    console.log('\nRe-validating factory...');
    try {
      execSync(config.validation.command, { cwd: findProjectRoot(), encoding: 'utf-8', timeout: 30_000, stdio: 'inherit' });
    } catch {
      console.error('\nFactory validation failed after creating completion.');
      process.exit(1);
    }

    console.log(`\n${fmt.sym.ok} ${fmt.success('Completion created and validated successfully.')}`);
  } catch (e) {
    console.error(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

const isDirectExecution = process.argv[1]?.endsWith('complete.ts') || process.argv[1]?.endsWith('complete.js');
if (isDirectExecution) {
  main();
}
