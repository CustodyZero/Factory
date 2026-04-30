#!/usr/bin/env tsx
/**
 * Factory — Completion Record Generator
 *
 * Creates a completion record for a packet after running verification.
 * Runs build, lint, and tests (from factory.config.json), collects
 * changed files from git, and writes completions/<packet-id>.json.
 *
 * Usage:
 *   npx tsx tools/complete.ts <packet-id> [--summary "..."] [--identity <id>]
 *
 * Idempotency:
 *   If a completion record already exists, this script prints
 *   "Packet '<id>' is already complete. No action taken." and exits 0
 *   WITHOUT re-running build/lint/test and WITHOUT modifying the
 *   completion file or packet file. The FI-1 invariant (one completion
 *   per packet) is preserved by refusing to OVERWRITE; the early-exit
 *   path simply returns success when the existing record already
 *   satisfies the request. Re-running verification on already-completed
 *   work would waste time and could produce different results.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { loadConfig, findProjectRoot, resolveArtifactRoot } from './config.js';
import * as fmt from './output.js';

// ---------------------------------------------------------------------------
// Exported function for programmatic use by run.ts
// ---------------------------------------------------------------------------

export interface CompleteOptions {
  readonly packetId: string;
  readonly summary?: string;
  readonly identity?: string;
  readonly projectRoot?: string;
}

export interface CompleteResult {
  readonly packet_id: string;
  readonly build_pass: boolean;
  readonly lint_pass: boolean;
  readonly tests_pass: boolean;
  readonly ci_pass: boolean;
  readonly files_changed: string[];
  readonly already_complete: boolean;
}

interface RawCompletion {
  readonly packet_id: string;
  readonly files_changed?: ReadonlyArray<string>;
  readonly verification?: {
    readonly tests_pass?: boolean;
    readonly build_pass?: boolean;
    readonly lint_pass?: boolean;
    readonly ci_pass?: boolean;
  };
}

export function completePacket(options: CompleteOptions): CompleteResult {
  const config = loadConfig(options.projectRoot);
  const projectRoot = options.projectRoot ?? findProjectRoot();
  const artifactRoot = resolveArtifactRoot(projectRoot, config);
  const { packetId } = options;

  const packetPath = join(artifactRoot, 'packets', `${packetId}.json`);
  if (!existsSync(packetPath)) {
    throw new Error(`Packet not found: packets/${packetId}.json`);
  }

  const completionPath = join(artifactRoot, 'completions', `${packetId}.json`);

  // Idempotency: if a completion record already exists, return its values
  // WITHOUT re-running verification. This must happen before any work to
  // avoid the cost (and potential nondeterminism) of re-running build/lint/
  // test on already-complete work. The FI-1 invariant is preserved: we do
  // NOT overwrite the existing file. The downstream writeFileSync below is
  // unreachable on the already-complete path; if execution somehow reaches
  // that point with the file still present, it would still refuse — but
  // the early return is the documented contract.
  if (existsSync(completionPath)) {
    const existing = JSON.parse(readFileSync(completionPath, 'utf-8')) as RawCompletion;
    const verification = existing.verification ?? {};
    return {
      packet_id: existing.packet_id,
      build_pass: verification.build_pass ?? false,
      lint_pass: verification.lint_pass ?? false,
      tests_pass: verification.tests_pass ?? false,
      ci_pass: verification.ci_pass ?? false,
      files_changed: [...(existing.files_changed ?? [])],
      already_complete: true,
    };
  }

  const packet = JSON.parse(readFileSync(packetPath, 'utf-8')) as Record<string, unknown>;
  const startedAt = typeof packet['started_at'] === 'string' ? packet['started_at'] : null;
  if (startedAt === null) {
    throw new Error(`Packet '${packetId}' has not been started.`);
  }

  // Run verification
  const buildPass = runVerification('build', config.verification.build, projectRoot);
  const lintPass = runVerification('lint', config.verification.lint, projectRoot);
  const testsPass = runVerification('tests', config.verification.test, projectRoot);
  const ciPass = buildPass && lintPass && testsPass;

  // Collect changed files
  let filesChanged: string[] = [];
  try {
    const diffOutput = execSync('git diff --name-only HEAD~1', {
      cwd: projectRoot, encoding: 'utf-8', timeout: 10_000,
    }).trim();
    if (diffOutput.length > 0) {
      filesChanged = diffOutput.split('\n');
    }
  } catch { /* best-effort */ }

  const summary = options.summary ?? `Completed implementation for packet ${packetId}.`;
  const failedSteps = [
    ...(buildPass ? [] : ['build']),
    ...(lintPass ? [] : ['lint']),
    ...(testsPass ? [] : ['tests']),
  ];
  const verificationNotes = failedSteps.length > 0
    ? `Verification failed for: ${failedSteps.join(', ')}`
    : 'All verification passed.';

  const completion = {
    packet_id: packetId,
    completed_at: new Date().toISOString(),
    completed_by: options.identity !== undefined
      ? { ...config.completed_by_default, id: options.identity }
      : config.completed_by_default,
    summary,
    files_changed: filesChanged,
    verification: {
      tests_pass: testsPass,
      build_pass: buildPass,
      lint_pass: lintPass,
      ci_pass: ciPass,
      notes: verificationNotes,
    },
  };

  // FI-1 last-line defense: refuse to overwrite an existing completion file.
  // This branch is unreachable in normal flow because of the early return at
  // the top of this function, but the check is preserved as a structural
  // safety net against any future refactor that changes the early return.
  if (existsSync(completionPath)) {
    throw new Error(`Completion already exists: completions/${packetId}.json (FI-1)`);
  }

  writeFileSync(completionPath, JSON.stringify(completion, null, 2) + '\n', 'utf-8');

  // Update packet status
  packet['status'] = 'completed';
  writeFileSync(packetPath, JSON.stringify(packet, null, 2) + '\n', 'utf-8');

  return {
    packet_id: packetId,
    build_pass: buildPass,
    lint_pass: lintPass,
    tests_pass: testsPass,
    ci_pass: ciPass,
    files_changed: filesChanged,
    already_complete: false,
  };
}

function runVerification(name: string, command: string, cwd: string): boolean {
  try {
    execSync(command, { cwd, encoding: 'utf-8', timeout: 300_000, stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

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
