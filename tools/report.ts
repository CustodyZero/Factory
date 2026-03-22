#!/usr/bin/env tsx
/**
 * Factory — QA Report Generator
 *
 * Produces a feature-level QA report after all packets in a feature
 * are complete. The agent acts as QA reviewer, assessing each packet's
 * deliverable against its declared intent.
 *
 * Usage:
 *   npx tsx tools/report.ts <feature-id> < assessments.json
 *   echo '{ ... }' | npx tsx tools/report.ts <feature-id>
 *
 * Input (JSON on stdin):
 *   {
 *     "packets": [
 *       {
 *         "packet_id": "setup-vite",
 *         "intent_satisfied": true,
 *         "intent_summary": "what was intended vs delivered",
 *         "contracts_verified": ["list of invariants checked"],
 *         "risks": ["anything reviewer should examine"]
 *       }
 *     ],
 *     "summary": "feature-level QA assessment",
 *     "recommendation": "accept" | "accept_with_reservations" | "reject",
 *     "reservations": ["if any"]
 *   }
 *
 * Behavior:
 *   1. Validates the feature exists and all packets are complete
 *   2. Validates no existing report (one report per feature)
 *   3. Validates the input covers all packets in the feature
 *   4. Writes reports/<feature-id>.json
 *   5. Re-runs factory:validate
 *
 * The report is an agent-authored QA artifact. It informs but does
 * not replace human acceptance authority (FI-3 still applies).
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
const featureId = args[0];

if (featureId == null || featureId === '' || featureId.startsWith('--')) {
  console.error('Usage: npx tsx tools/report.ts <feature-id> < assessments.json');
  console.error('');
  console.error('Produces a QA report for a completed feature.');
  console.error('Reads per-packet assessments from stdin as JSON.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Validate preconditions
// ---------------------------------------------------------------------------

const featurePath = join(FACTORY_ROOT, 'features', `${featureId}.json`);
if (!existsSync(featurePath)) {
  console.error(`ERROR: Feature not found: features/${featureId}.json`);
  process.exit(1);
}

const feature = JSON.parse(readFileSync(featurePath, 'utf-8')) as Record<string, unknown>;
const featurePackets = Array.isArray(feature['packets']) ? feature['packets'] as string[] : [];

if (featurePackets.length === 0) {
  console.error(`ERROR: Feature '${featureId}' has no packets.`);
  process.exit(1);
}

// Check all packets are complete
const missingCompletions: string[] = [];
for (const packetId of featurePackets) {
  const completionPath = join(FACTORY_ROOT, 'completions', `${packetId}.json`);
  if (!existsSync(completionPath)) {
    missingCompletions.push(packetId);
  }
}

if (missingCompletions.length > 0) {
  console.error(`ERROR: Not all packets are complete. Missing completions for:`);
  for (const id of missingCompletions) {
    console.error(`  - ${id}`);
  }
  console.error('\nAll packets must be completed before producing a QA report.');
  process.exit(1);
}

const reportPath = join(FACTORY_ROOT, 'reports', `${featureId}.json`);
if (existsSync(reportPath)) {
  console.error(`ERROR: Report already exists: reports/${featureId}.json`);
  console.error('Delete the existing report first if re-producing.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Read assessments from stdin
// ---------------------------------------------------------------------------

let stdinData: string;
try {
  stdinData = readFileSync(0, 'utf-8').trim();
} catch {
  console.error('ERROR: Could not read from stdin. Pipe assessments JSON into this command.');
  process.exit(1);
}

if (stdinData.length === 0) {
  console.error('ERROR: No input received on stdin. Pipe assessments JSON into this command.');
  process.exit(1);
}

interface PacketAssessment {
  packet_id: string;
  intent_satisfied: boolean;
  intent_summary: string;
  contracts_verified: string[];
  risks: string[];
}

interface AssessmentInput {
  packets: PacketAssessment[];
  summary: string;
  recommendation: 'accept' | 'accept_with_reservations' | 'reject';
  reservations?: string[];
}

let input: AssessmentInput;
try {
  input = JSON.parse(stdinData) as AssessmentInput;
} catch (e) {
  console.error(`ERROR: Failed to parse stdin as JSON: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Validate input completeness
// ---------------------------------------------------------------------------

if (!Array.isArray(input.packets) || input.packets.length === 0) {
  console.error('ERROR: Input must include a non-empty "packets" array.');
  process.exit(1);
}

if (typeof input.summary !== 'string' || input.summary.length === 0) {
  console.error('ERROR: Input must include a non-empty "summary" string.');
  process.exit(1);
}

const validRecommendations = ['accept', 'accept_with_reservations', 'reject'];
if (!validRecommendations.includes(input.recommendation)) {
  console.error(`ERROR: "recommendation" must be one of: ${validRecommendations.join(', ')}`);
  process.exit(1);
}

// Check all feature packets are covered
const assessedIds = new Set(input.packets.map((p) => p.packet_id));
const missingAssessments: string[] = [];
for (const packetId of featurePackets) {
  if (!assessedIds.has(packetId)) {
    missingAssessments.push(packetId);
  }
}

if (missingAssessments.length > 0) {
  console.error('ERROR: Assessment is missing for the following packets:');
  for (const id of missingAssessments) {
    console.error(`  - ${id}`);
  }
  console.error('\nThe QA report must cover every packet in the feature.');
  process.exit(1);
}

// Validate each packet assessment has required fields
for (const pa of input.packets) {
  const prefix = `packets[${pa.packet_id}]`;
  if (typeof pa.packet_id !== 'string' || pa.packet_id.length === 0) {
    console.error(`ERROR: ${prefix}: packet_id is required.`);
    process.exit(1);
  }
  if (typeof pa.intent_satisfied !== 'boolean') {
    console.error(`ERROR: ${prefix}: intent_satisfied must be a boolean.`);
    process.exit(1);
  }
  if (typeof pa.intent_summary !== 'string' || pa.intent_summary.length === 0) {
    console.error(`ERROR: ${prefix}: intent_summary is required.`);
    process.exit(1);
  }
  if (!Array.isArray(pa.contracts_verified)) {
    console.error(`ERROR: ${prefix}: contracts_verified must be an array.`);
    process.exit(1);
  }
  if (!Array.isArray(pa.risks)) {
    console.error(`ERROR: ${prefix}: risks must be an array.`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Write report
// ---------------------------------------------------------------------------

const report: Record<string, unknown> = {
  feature_id: featureId,
  produced_at: new Date().toISOString(),
  produced_by: config.completed_by_default,
  packets: input.packets,
  summary: input.summary,
  recommendation: input.recommendation,
};

if (input.reservations != null && input.reservations.length > 0) {
  report['reservations'] = input.reservations;
}

writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf-8');
console.log(`\nQA report written: reports/${featureId}.json`);
console.log(`  Feature: ${featureId}`);
console.log(`  Packets assessed: ${String(input.packets.length)}`);
console.log(`  Recommendation: ${input.recommendation}`);

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
  console.error('\nFactory validation failed after creating report. Check the output above.');
  process.exit(1);
}

console.log('\n\u2713 QA report created and validated successfully.');
console.log('  The report is ready for human review. Architectural packets require');
console.log('  human acceptance before the feature can be delivered.');
