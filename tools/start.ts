#!/usr/bin/env tsx
/**
 * Factory — Packet Start / Claim
 *
 * Marks a packet as started before implementation begins.
 *
 * Usage:
 *   npx tsx tools/start.ts <packet-id>
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, findProjectRoot, resolveArtifactRoot } from './config.js';
import * as fmt from './output.js';

const config = loadConfig();
const PROJECT_ROOT = findProjectRoot();
const ARTIFACT_ROOT = resolveArtifactRoot(PROJECT_ROOT, config);

const args = process.argv.slice(2);
const packetId = args[0];

if (packetId == null || packetId === '' || packetId.startsWith('--')) {
  console.error('Usage: npx tsx tools/start.ts <packet-id>');
  process.exit(1);
}

const packetPath = join(ARTIFACT_ROOT, 'packets', `${packetId}.json`);
if (!existsSync(packetPath)) {
  console.error(`ERROR: Packet not found: packets/${packetId}.json`);
  process.exit(1);
}

const completionPath = join(ARTIFACT_ROOT, 'completions', `${packetId}.json`);
if (existsSync(completionPath)) {
  console.error(`ERROR: Packet '${packetId}' already has a completion record.`);
  process.exit(1);
}

const raw = readFileSync(packetPath, 'utf-8');
const packet = JSON.parse(raw) as Record<string, unknown>;
const status = typeof packet['status'] === 'string' ? packet['status'] : null;

if (status === 'abandoned' || status === 'deferred') {
  console.error(`ERROR: Packet '${packetId}' is marked '${status}' and cannot be started.`);
  process.exit(1);
}

if (typeof packet['started_at'] === 'string' && packet['started_at'].length > 0) {
  console.log(`Packet already started: ${packetId}`);
  console.log(`  started_at: ${packet['started_at']}`);
  process.exit(0);
}

const now = new Date().toISOString();
packet['started_at'] = now;
packet['status'] = 'implementing';
writeFileSync(packetPath, JSON.stringify(packet, null, 2) + '\n', 'utf-8');

console.log(`${fmt.sym.ok} ${fmt.success('Packet started:')} ${fmt.bold(packetId)}`);
console.log(`  started_at: ${fmt.muted(now)}`);
console.log(`  status: ${fmt.info('implementing')}`);
