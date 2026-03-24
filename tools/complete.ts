#!/usr/bin/env tsx
/**
 * Factory — Completion Record Generator
 *
 * Creates a completion record for a packet after successful verification.
 * Runs build, lint, and tests (configured in factory.config.json) to
 * populate verification fields truthfully.
 *
 * Usage:
 *   npx tsx tools/complete.ts <packet-id> [--summary "..."] [--identity <id>]
 *
 * Behavior:
 *   1. Validates the packet exists and has no existing completion
 *   2. Runs build, lint, and tests (records pass/fail for each)
 *   3. Collects changed files from git diff
 *   4. Writes completions/<packet-id>.json
 *   5. Re-runs factory:validate to confirm the result is clean
 *
 * This script exists to make completion the natural next step after
 * implementation, not an afterthought.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { loadConfig, findProjectRoot, resolveFactoryRoot } from './config.js';

const config = loadConfig();
const PROJECT_ROOT = findProjectRoot();
const FACTORY_ROOT = resolveFactoryRoot(PROJECT_ROOT, config);

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const packetId = args[0];
const summaryIdx = args.indexOf('--summary');
const customSummary = summaryIdx !== -1 ? args[summaryIdx + 1] : undefined;
const identityIdx = args.indexOf('--identity');
const identityOverride = identityIdx !== -1 ? args[identityIdx + 1] : undefined;

if (packetId == null || packetId === '' || packetId.startsWith('--')) {
  console.error('Usage: npx tsx tools/complete.ts <packet-id> [--summary "..."] [--identity <id>]');
  console.error('');
  console.error('Creates a completion record after running verification checks.');
  console.error('The completion record is the factory deliverable — not the packet.');
  console.error('');
  console.error('Options:');
  console.error('  --identity <id>  Override completed_by.id (e.g., "claude-qa" for QA agents)');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Validate preconditions
// ---------------------------------------------------------------------------

const packetPath = join(FACTORY_ROOT, 'packets', `${packetId}.json`);
if (!existsSync(packetPath)) {
  console.error(`ERROR: Packet not found: packets/${packetId}.json`);
  process.exit(1);
}

const completionPath = join(FACTORY_ROOT, 'completions', `${packetId}.json`);
if (existsSync(completionPath)) {
  console.error(`ERROR: Completion already exists: completions/${packetId}.json`);
  console.error('FI-1 forbids duplicate completions. Delete the existing one first if re-completing.');
  process.exit(1);
}

const packet = JSON.parse(readFileSync(packetPath, 'utf-8')) as Record<string, unknown>;
const title = typeof packet['title'] === 'string' ? packet['title'] : packetId;
console.log(`\nCreating completion for: ${title}`);
console.log(`Packet: ${packetId}\n`);

// ---------------------------------------------------------------------------
// Run verification (commands from factory.config.json)
// ---------------------------------------------------------------------------

interface VerificationStep {
  name: string;
  command: string;
  pass: boolean;
  output: string;
}

function runStep(name: string, command: string): VerificationStep {
  console.log(`  Running ${name}...`);
  try {
    const output = execSync(command, {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: 300_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(`  \u2713 ${name} passed`);
    return { name, command, pass: true, output };
  } catch (err: unknown) {
    const stderr = err instanceof Error && 'stderr' in err ? String((err as { stderr: unknown }).stderr) : '';
    console.log(`  \u2717 ${name} failed`);
    return { name, command, pass: false, output: stderr };
  }
}

const steps: VerificationStep[] = [
  runStep('build', config.verification.build),
  runStep('lint', config.verification.lint),
  runStep('tests', config.verification.test),
];

const buildPass = steps[0]?.pass ?? false;
const lintPass = steps[1]?.pass ?? false;
const testsPass = steps[2]?.pass ?? false;
const ciPass = buildPass && lintPass && testsPass;

// ---------------------------------------------------------------------------
// Collect changed files from git
// ---------------------------------------------------------------------------

let filesChanged: string[] = [];
try {
  const diffOutput = execSync('git diff --name-only HEAD~1', {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    timeout: 10_000,
  }).trim();
  if (diffOutput.length > 0) {
    filesChanged = diffOutput.split('\n');
  }
} catch {
  // Best-effort
}

// ---------------------------------------------------------------------------
// Build verification notes
// ---------------------------------------------------------------------------

const failedSteps = steps.filter((s) => !s.pass).map((s) => s.name);
const verificationNotes = failedSteps.length > 0
  ? `Verification failed for: ${failedSteps.join(', ')}`
  : `All verification passed. ${steps.map((s) => s.name).join(', ')} — all green.`;

// ---------------------------------------------------------------------------
// Write completion record
// ---------------------------------------------------------------------------

const summary = customSummary ?? `Completed implementation for packet ${packetId}.`;

const completion = {
  packet_id: packetId,
  completed_at: new Date().toISOString(),
  completed_by: identityOverride !== undefined
    ? { ...config.completed_by_default, id: identityOverride }
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

writeFileSync(completionPath, JSON.stringify(completion, null, 2) + '\n', 'utf-8');
console.log(`\nCompletion written: completions/${packetId}.json`);

if (!ciPass) {
  console.log('\n\u26a0 Verification did not fully pass. The completion record reflects this honestly.');
  console.log('  Fix the failures and re-create the completion if needed.');
}

// ---------------------------------------------------------------------------
// Re-validate
// ---------------------------------------------------------------------------

console.log('\nRe-validating factory...');
try {
  execSync(config.validation.command, {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: 'inherit',
  });
} catch {
  console.error('\nFactory validation failed after creating completion. Check the output above.');
  process.exit(1);
}

console.log('\n\u2713 Completion created and validated successfully.');
console.log('  Remember: the completion is the deliverable, not the packet.');
