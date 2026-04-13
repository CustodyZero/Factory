#!/usr/bin/env tsx
/**
 * Factory — Request Code Review
 *
 * Transitions a dev packet from 'implementing' (or 'changes_requested')
 * to 'review_requested'. Captures the current git branch and increments
 * the review iteration counter.
 *
 * Usage:
 *   npx tsx tools/request-review.ts <packet-id>
 *   npx tsx tools/request-review.ts <packet-id> --branch <branch-name>
 *
 * Behavior:
 *   1. Validates the packet exists and is a dev packet
 *   2. Validates status is 'implementing' or 'changes_requested'
 *   3. Captures the current git branch (or uses --branch override)
 *   4. Sets status to 'review_requested'
 *   5. Sets the branch field on the packet
 *   6. Increments review_iteration (on re-requests after changes_requested)
 *
 * This is the developer's tool for signaling "my code is ready for review".
 * The supervisor or orchestrator then dispatches a code_reviewer agent.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { loadConfig, findProjectRoot, resolveArtifactRoot } from './config.js';
import * as fmt from './output.js';

const config = loadConfig();
const PROJECT_ROOT = findProjectRoot();
const ARTIFACT_ROOT = resolveArtifactRoot(PROJECT_ROOT, config);

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const packetId = positional[0];
const branchIdx = args.indexOf('--branch');
const branchOverride = branchIdx !== -1 ? args[branchIdx + 1] : undefined;

if (packetId == null || packetId === '' || packetId.startsWith('--')) {
  console.error('Usage: npx tsx tools/request-review.ts <packet-id> [--branch <branch-name>]');
  console.error('');
  console.error('Transitions a dev packet to review_requested status.');
  console.error('The code_reviewer persona is then dispatched to review the branch.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Validate preconditions
// ---------------------------------------------------------------------------

const packetPath = join(ARTIFACT_ROOT, 'packets', `${packetId}.json`);
if (!existsSync(packetPath)) {
  console.error(`ERROR: Packet not found: packets/${packetId}.json`);
  process.exit(1);
}

const packet = JSON.parse(readFileSync(packetPath, 'utf-8')) as Record<string, unknown>;

// Must be a dev packet
if (packet['kind'] !== 'dev') {
  console.error(`ERROR: Only dev packets can request code review.`);
  console.error(`  Packet '${packetId}' has kind '${String(packet['kind'])}'.`);
  console.error(`  QA packets do not go through code review.`);
  process.exit(1);
}

// Must be in implementing or changes_requested status
const status = typeof packet['status'] === 'string' ? packet['status'] : null;
const validStatuses = ['implementing', 'changes_requested'];
if (!validStatuses.includes(status as string)) {
  console.error(`ERROR: Packet '${packetId}' has status '${String(status)}'.`);
  console.error(`  Only packets in 'implementing' or 'changes_requested' status can request review.`);
  if (status === 'review_requested') {
    console.error(`  This packet is already awaiting review.`);
  } else if (status === 'review_approved') {
    console.error(`  This packet is already approved. Run complete.ts to finalize.`);
  }
  process.exit(1);
}

// Must have been started
if (typeof packet['started_at'] !== 'string' || packet['started_at'].length === 0) {
  console.error(`ERROR: Packet '${packetId}' has not been started.`);
  console.error(`  Run: npx tsx tools/start.ts ${packetId}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Capture branch
// ---------------------------------------------------------------------------

let branch: string;
if (branchOverride !== undefined && branchOverride.length > 0) {
  branch = branchOverride;
} else {
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim();
  } catch {
    console.error('ERROR: Could not determine current git branch.');
    console.error('  Use --branch <branch-name> to specify manually.');
    process.exit(1);
  }
}

if (branch === 'HEAD') {
  console.error('ERROR: Detached HEAD state. Cannot determine branch name.');
  console.error('  Use --branch <branch-name> to specify manually.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Update packet
// ---------------------------------------------------------------------------

const wasChangesRequested = status === 'changes_requested';
const currentIteration = typeof packet['review_iteration'] === 'number' ? packet['review_iteration'] : 0;

packet['status'] = 'review_requested';
packet['branch'] = branch;
if (wasChangesRequested) {
  packet['review_iteration'] = currentIteration + 1;
} else if (packet['review_iteration'] === undefined) {
  packet['review_iteration'] = 0;
}

writeFileSync(packetPath, JSON.stringify(packet, null, 2) + '\n', 'utf-8');

console.log(`${fmt.sym.ok} ${fmt.success('Review requested:')} ${fmt.bold(packetId)}`);
console.log(`  status: ${fmt.info('review_requested')}`);
console.log(`  branch: ${fmt.info(branch)}`);
console.log(`  review_iteration: ${packet['review_iteration']}`);
if (wasChangesRequested) {
  console.log(`  (re-request after changes — iteration incremented)`);
}
