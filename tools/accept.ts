#!/usr/bin/env tsx
/**
 * Factory — Acceptance Record Generator
 *
 * Creates an acceptance record for a completed packet.
 * This is a human-authority action — FI-3 forbids agent-authored acceptances.
 *
 * Usage:
 *   npx tsx tools/accept.ts <packet-id> [--notes "..."]
 *
 * Behavior:
 *   1. Validates the packet exists
 *   2. Validates a completion exists (FI-4)
 *   3. Validates no existing acceptance (FI-2)
 *   4. Writes acceptances/<packet-id>.json
 *   5. Re-runs factory:validate to confirm the result is clean
 *
 * Identity: { kind: "cli", id: "accept-tool" }
 * The "cli" kind is allowed under FI-3 because a human invoked the command.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { loadConfig, findProjectRoot, resolveArtifactRoot } from './config.js';

const config = loadConfig();
const PROJECT_ROOT = findProjectRoot();
const ARTIFACT_ROOT = resolveArtifactRoot(PROJECT_ROOT, config);

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const packetId = args[0];
const notesIdx = args.indexOf('--notes');
const notes = notesIdx !== -1 ? args[notesIdx + 1] : null;

if (packetId == null || packetId === '' || packetId.startsWith('--')) {
  console.error('Usage: npx tsx tools/accept.ts <packet-id> [--notes "..."]');
  console.error('');
  console.error('Creates an acceptance record for a completed packet.');
  console.error('This is a human-authority action (FI-3).');
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

const completionPath = join(ARTIFACT_ROOT, 'completions', `${packetId}.json`);
if (!existsSync(completionPath)) {
  console.error(`ERROR: No completion found: completions/${packetId}.json`);
  console.error('FI-4 requires a completion before acceptance. Run complete.ts first.');
  process.exit(1);
}

const acceptancePath = join(ARTIFACT_ROOT, 'acceptances', `${packetId}.json`);
if (existsSync(acceptancePath)) {
  console.error(`ERROR: Acceptance already exists: acceptances/${packetId}.json`);
  console.error('FI-2 forbids duplicate acceptances.');
  process.exit(1);
}

// Read packet for display and gate checks
const packet = JSON.parse(readFileSync(packetPath, 'utf-8')) as Record<string, unknown>;
const title = typeof packet['title'] === 'string' ? packet['title'] : packetId;
const changeClass = typeof packet['change_class'] === 'string' ? packet['change_class'] : 'unknown';
const featureId = typeof packet['feature_id'] === 'string' ? packet['feature_id'] : null;

// Gate: architectural dev packets require their QA counterpart to be complete
const packetKind = typeof packet['kind'] === 'string' ? packet['kind'] : 'dev';
if (changeClass === 'architectural' && packetKind === 'dev') {
  // Find the QA packet that verifies this dev packet
  const packetsDir = join(ARTIFACT_ROOT, 'packets');
  const allPacketFiles = existsSync(packetsDir)
    ? readdirSync(packetsDir).filter((f) => f.endsWith('.json'))
    : [];
  let qaPacketId: string | null = null;
  for (const f of allPacketFiles) {
    const p = JSON.parse(readFileSync(join(packetsDir, f), 'utf-8')) as Record<string, unknown>;
    if (p['kind'] === 'qa' && p['verifies'] === packetId) {
      qaPacketId = typeof p['id'] === 'string' ? p['id'] : f.replace('.json', '');
      break;
    }
  }
  if (qaPacketId === null) {
    console.error(`ERROR: Architectural packet '${packetId}' has no QA counterpart.`);
    console.error('  A QA packet with verifies: "' + packetId + '" must exist.');
    process.exit(1);
  }
  const qaCompletionPath = join(ARTIFACT_ROOT, 'completions', `${qaPacketId}.json`);
  if (!existsSync(qaCompletionPath)) {
    console.error(`ERROR: Architectural packet '${packetId}' requires QA verification before acceptance.`);
    console.error(`  QA packet: ${qaPacketId}`);
    console.error(`  QA completion not found: completions/${qaPacketId}.json`);
    process.exit(1);
  }
}

console.log(`\nAccepting packet: ${title}`);
console.log(`  ID:           ${packetId}`);
console.log(`  Change class: ${changeClass}`);

// ---------------------------------------------------------------------------
// Write acceptance record
// ---------------------------------------------------------------------------

const acceptance: Record<string, unknown> = {
  packet_id: packetId,
  accepted_at: new Date().toISOString(),
  accepted_by: {
    kind: 'cli',
    id: 'accept-tool',
  },
};

if (notes !== null) {
  acceptance['notes'] = notes;
}

writeFileSync(acceptancePath, JSON.stringify(acceptance, null, 2) + '\n', 'utf-8');
console.log(`\nAcceptance written: acceptances/${packetId}.json`);

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
  console.error('\nFactory validation failed after creating acceptance. Check the output above.');
  process.exit(1);
}

console.log('\n\u2713 Acceptance created and validated successfully.');
