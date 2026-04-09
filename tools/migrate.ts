#!/usr/bin/env tsx
/**
 * Factory — Migration Script
 *
 * Idempotent migration for pre-existing packets and features that lack
 * fields introduced by the dev/qa packet pair model:
 *   - packet.kind (defaults to "dev")
 *   - packet.acceptance_criteria (migration placeholder)
 *   - feature.acceptance_criteria (migration placeholder)
 *   - intents/ directory for planner-native flow
 *   - reports/orchestrator directory for orchestrator output capture
 *
 * Safe to run multiple times. Reports what it changed.
 *
 * Usage:
 *   npx tsx tools/migrate.ts          # migrate factory artifacts
 *   npx tsx tools/migrate.ts --dry    # preview changes without writing
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, resolveArtifactRoot } from './config.js';

const MIGRATION_MARKER = '[MIGRATION] Define acceptance criteria';
const isDryRun = process.argv.includes('--dry');

const config = loadConfig();
const ARTIFACT_ROOT = resolveArtifactRoot(undefined, config);

interface MigrationChange {
  readonly file: string;
  readonly field: string;
  readonly value: unknown;
}

const changes: MigrationChange[] = [];

function migrateJsonFile(dir: string, filename: string, migrations: (data: Record<string, unknown>, filepath: string) => void): void {
  const filepath = join(ARTIFACT_ROOT, dir, filename);
  const raw = readFileSync(filepath, 'utf-8');
  const data = JSON.parse(raw) as Record<string, unknown>;
  const before = JSON.stringify(data);

  migrations(data, `${dir}/${filename}`);

  const after = JSON.stringify(data);
  if (before !== after && !isDryRun) {
    writeFileSync(filepath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  }
}

function migratePackets(): void {
  const dir = join(ARTIFACT_ROOT, 'packets');
  if (!existsSync(dir)) return;

  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    migrateJsonFile('packets', file, (data, filepath) => {
      if (data['kind'] === undefined) {
        data['kind'] = 'dev';
        changes.push({ file: filepath, field: 'kind', value: 'dev' });
      }

      if (data['acceptance_criteria'] === undefined) {
        const marker = `${MIGRATION_MARKER} for this packet`;
        data['acceptance_criteria'] = [marker];
        changes.push({ file: filepath, field: 'acceptance_criteria', value: [marker] });
      }
    });
  }
}

function migrateFeatures(): void {
  const dir = join(ARTIFACT_ROOT, 'features');
  if (!existsSync(dir)) return;

  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    migrateJsonFile('features', file, (data, filepath) => {
      if (data['acceptance_criteria'] === undefined) {
        const marker = `${MIGRATION_MARKER} for this feature`;
        data['acceptance_criteria'] = [marker];
        changes.push({ file: filepath, field: 'acceptance_criteria', value: [marker] });
      }
    });
  }
}

function ensurePlannerArtifacts(): void {
  const dir = join(ARTIFACT_ROOT, 'intents');
  if (existsSync(dir)) {
    return;
  }

  changes.push({ file: 'intents/', field: 'directory', value: 'created' });
  if (!isDryRun) {
    mkdirSync(dir, { recursive: true });
  }
}

function ensureOrchestratorArtifacts(): void {
  const dir = join(ARTIFACT_ROOT, 'reports', 'orchestrator');
  if (existsSync(dir)) {
    return;
  }

  changes.push({ file: 'reports/orchestrator/', field: 'directory', value: 'created' });
  if (!isDryRun) {
    mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log('');
console.log('═'.repeat(59));
console.log(`  FACTORY MIGRATION${isDryRun ? ' (DRY RUN)' : ''}`);
console.log('═'.repeat(59));
console.log('');

migratePackets();
migrateFeatures();
ensurePlannerArtifacts();
ensureOrchestratorArtifacts();

if (changes.length === 0) {
  console.log('  No migration needed — all artifacts are up to date.');
} else {
  console.log(`  ${String(changes.length)} change(s)${isDryRun ? ' would be made' : ' applied'}:`);
  console.log('');
  for (const c of changes) {
    console.log(`    ${c.file}: ${c.field} = ${JSON.stringify(c.value)}`);
  }
}

console.log('');

if (!isDryRun && changes.length > 0) {
  console.log('  Migration complete. Run npx tsx tools/validate.ts to verify.');
  console.log('  Replace [MIGRATION] placeholders with real acceptance criteria.');
  console.log('  Planner-native flow is opt-in: existing features can continue without intent_id.');
  console.log('  New work can start from intents/<intent-id>.json and npx tsx tools/plan.ts <intent-id>.');
  console.log('  Orchestrator output is stored under reports/orchestrator/ when the native harness is used.');
}
