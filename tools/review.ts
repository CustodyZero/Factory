#!/usr/bin/env tsx
/**
 * Factory — Code Review Decision
 *
 * Records a code review decision on a dev packet that is in
 * 'review_requested' status. Transitions the packet to either
 * 'review_approved' or 'changes_requested'.
 *
 * Usage:
 *   npx tsx tools/review.ts <packet-id> --approve
 *   npx tsx tools/review.ts <packet-id> --request-changes
 *
 * Behavior:
 *   1. Validates the packet exists and is a dev packet
 *   2. Validates status is 'review_requested'
 *   3. Sets status to 'review_approved' or 'changes_requested'
 *
 * Review feedback lives in git (branch diffs, git notes, etc.) — not
 * in factory artifacts. This tool only manages the lifecycle transition.
 *
 * After --approve:
 *   The developer calls complete.ts to create the completion record.
 *
 * After --request-changes:
 *   The developer addresses feedback, then calls request-review.ts again.
 *   This increments review_iteration for the next round.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, findProjectRoot, resolveArtifactRoot } from './config.js';

const config = loadConfig();
const PROJECT_ROOT = findProjectRoot();
const ARTIFACT_ROOT = resolveArtifactRoot(PROJECT_ROOT, config);

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const packetId = positional[0];
const approveFlag = args.includes('--approve');
const changesFlag = args.includes('--request-changes');

if (packetId == null || packetId === '' || packetId.startsWith('--')) {
  console.error('Usage: npx tsx tools/review.ts <packet-id> --approve|--request-changes');
  console.error('');
  console.error('Records a code review decision on a dev packet.');
  console.error('');
  console.error('Options:');
  console.error('  --approve           Mark the code review as approved');
  console.error('  --request-changes   Request changes from the developer');
  process.exit(1);
}

if (!approveFlag && !changesFlag) {
  console.error('ERROR: Must specify either --approve or --request-changes.');
  process.exit(1);
}

if (approveFlag && changesFlag) {
  console.error('ERROR: Cannot specify both --approve and --request-changes.');
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
  console.error(`ERROR: Only dev packets go through code review.`);
  console.error(`  Packet '${packetId}' has kind '${String(packet['kind'])}'.`);
  process.exit(1);
}

// Must be in review_requested status
const status = typeof packet['status'] === 'string' ? packet['status'] : null;
if (status !== 'review_requested') {
  console.error(`ERROR: Packet '${packetId}' has status '${String(status)}'.`);
  console.error(`  Only packets in 'review_requested' status can be reviewed.`);
  if (status === 'implementing' || status === 'changes_requested') {
    console.error(`  The developer must call request-review.ts first.`);
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Apply decision
// ---------------------------------------------------------------------------

const decision = approveFlag ? 'review_approved' : 'changes_requested';
packet['status'] = decision;

writeFileSync(packetPath, JSON.stringify(packet, null, 2) + '\n', 'utf-8');

const iteration = typeof packet['review_iteration'] === 'number' ? packet['review_iteration'] : 0;

console.log(`Review decision: ${packetId}`);
console.log(`  status: ${decision}`);
console.log(`  review_iteration: ${iteration}`);
if (approveFlag) {
  console.log(`  Next step: npx tsx tools/complete.ts ${packetId}`);
} else {
  console.log(`  Next step: developer addresses feedback, then npx tsx tools/request-review.ts ${packetId}`);
}
