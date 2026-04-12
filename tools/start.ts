#!/usr/bin/env tsx
/**
 * Factory — Packet Start / Claim
 *
 * Explicitly marks a packet as started before implementation begins.
 * This gives the factory a concrete claim point instead of relying on
 * agents to edit packet JSON manually.
 *
 * Usage:
 *   npx tsx tools/start.ts <packet-id>
 *
 * Behavior:
 *   1. Validates the packet exists and is not completed
 *   2. Sets started_at if it is currently null
 *   3. Leaves already-started packets unchanged (idempotent)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, findProjectRoot, resolveArtifactRoot } from './config.js';

interface SupervisorFeatureTracking {
  readonly packets_spawned?: ReadonlyArray<string>;
  readonly active_dispatches?: ReadonlyArray<{ readonly packet_id?: string }>;
}

interface SupervisorState {
  readonly features?: Readonly<Record<string, SupervisorFeatureTracking>>;
}

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
  console.error('Completed packets cannot be started again without deleting the completion.');
  process.exit(1);
}

const raw = readFileSync(packetPath, 'utf-8');
const packet = JSON.parse(raw) as Record<string, unknown>;
const status = typeof packet['status'] === 'string' ? packet['status'] : null;
const featureId = typeof packet['feature_id'] === 'string' ? packet['feature_id'] : null;

if (status === 'abandoned' || status === 'deferred') {
  console.error(`ERROR: Packet '${packetId}' is marked '${status}' and cannot be started.`);
  process.exit(1);
}

if (typeof packet['started_at'] === 'string' && packet['started_at'].length > 0) {
  console.log(`Packet already started: ${packetId}`);
  console.log(`  started_at: ${packet['started_at']}`);
  process.exit(0);
}

const supervisorStatePath = join(ARTIFACT_ROOT, 'supervisor', 'state.json');
if (featureId !== null && existsSync(supervisorStatePath)) {
  try {
    const supervisorState = JSON.parse(readFileSync(supervisorStatePath, 'utf-8')) as SupervisorState;
    const featureTracking = supervisorState.features?.[featureId];
    const activeDispatches = featureTracking?.active_dispatches ?? [];
    const activePacketIds = activeDispatches
      .map((dispatch) => dispatch.packet_id)
      .filter((value): value is string => typeof value === 'string');
    const packetsSpawned = featureTracking?.packets_spawned ?? [];
    const authorizedPacketIds = activePacketIds.length > 0 ? activePacketIds : packetsSpawned;
    if (featureTracking !== undefined && !authorizedPacketIds.includes(packetId)) {
      console.error(`ERROR: Packet '${packetId}' belongs to feature '${featureId}' but has not been dispatched by the supervisor.`);
      console.error('Run the supervisor tick and only start packets returned in ready_packets.');
      process.exit(1);
    }
  } catch {
    console.error('ERROR: Failed to read supervisor/state.json while checking packet dispatch.');
    process.exit(1);
  }
}

const now = new Date().toISOString();
packet['started_at'] = now;
packet['status'] = 'implementing';
writeFileSync(packetPath, JSON.stringify(packet, null, 2) + '\n', 'utf-8');

console.log(`Packet started: ${packetId}`);
console.log(`  started_at: ${now}`);
console.log(`  status: implementing`);
