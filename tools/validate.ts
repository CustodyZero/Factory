#!/usr/bin/env tsx
/**
 * Factory — Validation Script
 *
 * Structural and semantic validation of all factory artifacts.
 *
 * Validation layers:
 *   1. Schema validation — required fields, types, patterns (packets, completions, acceptances, rejections, evidence, features)
 *   2. Referential integrity — cross-references between artifacts (including feature → packet references)
 *   3. Authority rules — FI-3 enforcement
 *   4. Change class consistency — heuristic warnings
 *   5. Invariant enforcement — FI-1 through FI-6
 *
 * Exit codes:
 *   0 — all validations pass
 *   1 — errors found
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { findProjectRoot, loadConfig, resolveArtifactRoot } from './config.js';
import { resolveSpecPath } from './plan.js';
import * as fmt from './output.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Severity = 'error' | 'warning';

interface ValidationResult {
  readonly file: string;
  readonly severity: Severity;
  readonly error_type: string;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = findProjectRoot();
const ARTIFACT_ROOT = resolveArtifactRoot(PROJECT_ROOT);
const VALID_CHANGE_CLASSES = ['trivial', 'local', 'cross_cutting', 'architectural'] as const;
const VALID_IDENTITY_KINDS = ['human', 'agent', 'cli', 'ui'] as const;
const VALID_FEATURE_STATUSES = ['draft', 'planned', 'approved', 'executing', 'completed', 'delivered'] as const;
const HUMAN_ONLY_KINDS = ['human', 'cli', 'ui'] as const;
const KEBAB_CASE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJsonFiles(subdir: string): Array<{ filename: string; filepath: string; data: unknown; raw: string }> {
  const dir = join(ARTIFACT_ROOT, subdir);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const results: Array<{ filename: string; filepath: string; data: unknown; raw: string }> = [];

  for (const file of files) {
    const filepath = join(dir, file);
    try {
      const raw = readFileSync(filepath, 'utf-8');
      const data: unknown = JSON.parse(raw);
      results.push({ filename: file, filepath: `${subdir}/${file}`, data, raw });
    } catch (e) {
      results.push({
        filename: file,
        filepath: `${subdir}/${file}`,
        data: null,
        raw: '',
      });
    }
  }

  return results;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((item) => typeof item === 'string');
}

function isValidISO8601(s: unknown): boolean {
  if (typeof s !== 'string') return false;
  const d = new Date(s);
  return !isNaN(d.getTime());
}

function isValidIdentity(v: unknown, allowedKinds: ReadonlyArray<string>): { valid: boolean; reason?: string } {
  if (!isObject(v)) return { valid: false, reason: 'identity must be an object' };
  if (typeof v['kind'] !== 'string') return { valid: false, reason: 'identity.kind must be a string' };
  if (!allowedKinds.includes(v['kind'])) return { valid: false, reason: `identity.kind '${v['kind']}' not in [${allowedKinds.join(', ')}]` };
  if (typeof v['id'] !== 'string' || v['id'].length === 0) return { valid: false, reason: 'identity.id must be a non-empty string' };
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Schema validation (Layer 1)
// ---------------------------------------------------------------------------

function validatePacketSchema(filepath: string, data: unknown): ValidationResult[] {
  const results: ValidationResult[] = [];
  const e = (msg: string) => results.push({ file: filepath, severity: 'error', error_type: 'schema', message: msg });

  if (!isObject(data)) { e('packet must be a JSON object'); return results; }

  if (typeof data['id'] !== 'string' || !KEBAB_CASE_RE.test(data['id'])) {
    e("'id' must be a kebab-case string");
  }
  const expectedFilename = `${data['id']}.json`;
  if (basename(filepath) !== expectedFilename && typeof data['id'] === 'string') {
    e(`filename must match id: expected '${expectedFilename}', got '${basename(filepath)}'`);
  }

  if (typeof data['title'] !== 'string' || data['title'].length === 0) e("'title' is required and must be non-empty");
  if (typeof data['intent'] !== 'string' || data['intent'].length === 0) e("'intent' is required and must be non-empty");

  if (typeof data['change_class'] !== 'string' || !(VALID_CHANGE_CLASSES as readonly string[]).includes(data['change_class'])) {
    e(`'change_class' must be one of: ${VALID_CHANGE_CLASSES.join(', ')}`);
  }

  if (!isObject(data['scope'])) {
    e("'scope' must be an object");
  } else {
    if (!isStringArray(data['scope']['packages'])) e("'scope.packages' must be an array of strings");
  }

  if (typeof data['owner'] !== 'string' || data['owner'].length === 0) e("'owner' is required");
  if (!isValidISO8601(data['created_at'])) e("'created_at' must be a valid ISO 8601 timestamp");

  if (data['started_at'] != null && !isValidISO8601(data['started_at'])) {
    e("'started_at' must be a valid ISO 8601 timestamp or null");
  }

  if (data['dependencies'] != null && !isStringArray(data['dependencies'])) {
    e("'dependencies' must be an array of strings");
  }

  if (data['environment_dependencies'] != null && !isStringArray(data['environment_dependencies'])) {
    e("'environment_dependencies' must be an array of strings");
  }

  if (data['status'] != null && data['status'] !== null) {
    const validStatuses = [
      'draft', 'ready', 'implementing',
      'review_requested', 'changes_requested', 'review_approved',
      'completed', 'abandoned', 'deferred',
    ];
    if (typeof data['status'] !== 'string' || !validStatuses.includes(data['status'])) {
      e(`'status' must be null or one of: ${validStatuses.join(', ')}`);
    }
    // Review states are only valid for dev packets
    const reviewStates = ['review_requested', 'changes_requested', 'review_approved'];
    if (reviewStates.includes(data['status'] as string) && data['kind'] !== 'dev') {
      e(`Review status '${data['status']}' is only valid for dev packets`);
    }
  }

  if (data['feature_id'] != null && data['feature_id'] !== null && typeof data['feature_id'] !== 'string') {
    e("'feature_id' must be a string or null");
  }

  // kind and verifies validation
  const validKinds = ['dev', 'qa'];
  if (typeof data['kind'] !== 'string' || !validKinds.includes(data['kind'])) {
    e("'kind' must be 'dev' or 'qa'");
  }
  if (data['kind'] === 'qa') {
    if (typeof data['verifies'] !== 'string' || !KEBAB_CASE_RE.test(data['verifies'])) {
      e("QA packet must have 'verifies' set to a valid packet ID");
    }
  } else if (data['verifies'] != null && data['verifies'] !== null) {
    e("Dev packet must not have 'verifies' set");
  }

  // acceptance_criteria validation
  if (!Array.isArray(data['acceptance_criteria']) || data['acceptance_criteria'].length === 0) {
    e("'acceptance_criteria' must be a non-empty array of strings");
  } else if (!data['acceptance_criteria'].every((c: unknown) => typeof c === 'string' && c.length > 0)) {
    e("each acceptance criterion must be a non-empty string");
  } else if (data['acceptance_criteria'].some((c: unknown) => typeof c === 'string' && c.startsWith('[MIGRATION]'))) {
    results.push({ file: filepath, severity: 'warning', error_type: 'migration', message: "acceptance_criteria contains [MIGRATION] placeholder — replace with real criteria" });
  }

  if (data['instructions'] != null && !isStringArray(data['instructions'])) {
    e("'instructions' must be an array of strings");
  }

  if (data['tags'] != null && !isStringArray(data['tags'])) {
    e("'tags' must be an array of strings");
  }

  return results;
}

function validateCompletionSchema(filepath: string, data: unknown): ValidationResult[] {
  const results: ValidationResult[] = [];
  const e = (msg: string) => results.push({ file: filepath, severity: 'error', error_type: 'schema', message: msg });

  if (!isObject(data)) { e('completion must be a JSON object'); return results; }

  if (typeof data['packet_id'] !== 'string' || !KEBAB_CASE_RE.test(data['packet_id'])) {
    e("'packet_id' must be a kebab-case string");
  }
  if (!isValidISO8601(data['completed_at'])) e("'completed_at' must be a valid ISO 8601 timestamp");

  const idCheck = isValidIdentity(data['completed_by'], VALID_IDENTITY_KINDS as unknown as string[]);
  if (!idCheck.valid) e(`'completed_by': ${idCheck.reason}`);

  if (typeof data['summary'] !== 'string' || data['summary'].length === 0) e("'summary' is required and must be non-empty");

  if (!isObject(data['verification'])) {
    e("'verification' must be an object");
  } else {
    const v = data['verification'];
    if (typeof v['tests_pass'] !== 'boolean') e("'verification.tests_pass' must be a boolean");
    if (typeof v['build_pass'] !== 'boolean') e("'verification.build_pass' must be a boolean");
    if (typeof v['lint_pass'] !== 'boolean') e("'verification.lint_pass' must be a boolean");
    if (typeof v['ci_pass'] !== 'boolean') e("'verification.ci_pass' must be a boolean");
  }

  return results;
}

function validateAcceptanceSchema(filepath: string, data: unknown): ValidationResult[] {
  const results: ValidationResult[] = [];
  const e = (msg: string) => results.push({ file: filepath, severity: 'error', error_type: 'schema', message: msg });

  if (!isObject(data)) { e('acceptance must be a JSON object'); return results; }

  if (typeof data['packet_id'] !== 'string' || !KEBAB_CASE_RE.test(data['packet_id'])) {
    e("'packet_id' must be a kebab-case string");
  }
  if (!isValidISO8601(data['accepted_at'])) e("'accepted_at' must be a valid ISO 8601 timestamp");

  const idCheck = isValidIdentity(data['accepted_by'], HUMAN_ONLY_KINDS as unknown as string[]);
  if (!idCheck.valid) e(`'accepted_by': ${idCheck.reason}`);

  return results;
}

function validateRejectionSchema(filepath: string, data: unknown): ValidationResult[] {
  const results: ValidationResult[] = [];
  const e = (msg: string) => results.push({ file: filepath, severity: 'error', error_type: 'schema', message: msg });

  if (!isObject(data)) { e('rejection must be a JSON object'); return results; }

  if (typeof data['packet_id'] !== 'string' || !KEBAB_CASE_RE.test(data['packet_id'])) {
    e("'packet_id' must be a kebab-case string");
  }
  if (!isValidISO8601(data['rejected_at'])) e("'rejected_at' must be a valid ISO 8601 timestamp");

  const idCheck = isValidIdentity(data['rejected_by'], HUMAN_ONLY_KINDS as unknown as string[]);
  if (!idCheck.valid) e(`'rejected_by': ${idCheck.reason}`);

  if (typeof data['reason'] !== 'string' || data['reason'].length === 0) {
    e("'reason' is required and must be non-empty");
  }

  return results;
}

function validateEvidenceSchema(filepath: string, data: unknown): ValidationResult[] {
  const results: ValidationResult[] = [];
  const e = (msg: string) => results.push({ file: filepath, severity: 'error', error_type: 'schema', message: msg });

  if (!isObject(data)) { e('evidence must be a JSON object'); return results; }

  if (typeof data['dependency_key'] !== 'string' || data['dependency_key'].length === 0) {
    e("'dependency_key' is required and must be non-empty");
  }
  if (!isValidISO8601(data['verified_at'])) e("'verified_at' must be a valid ISO 8601 timestamp");

  const idCheck = isValidIdentity(data['verified_by'], HUMAN_ONLY_KINDS as unknown as string[]);
  if (!idCheck.valid) e(`'verified_by': ${idCheck.reason}`);

  const validMethods = ['manual', 'automated', 'ci'];
  if (typeof data['verification_method'] !== 'string' || !validMethods.includes(data['verification_method'])) {
    e(`'verification_method' must be one of: ${validMethods.join(', ')}`);
  }

  if (typeof data['description'] !== 'string' || data['description'].length === 0) {
    e("'description' is required and must be non-empty");
  }

  if (data['expires_at'] != null && !isValidISO8601(data['expires_at'])) {
    e("'expires_at' must be a valid ISO 8601 timestamp or null");
  }

  return results;
}

function validateFeatureSchema(filepath: string, data: unknown): ValidationResult[] {
  const results: ValidationResult[] = [];
  const e = (msg: string) => results.push({ file: filepath, severity: 'error', error_type: 'schema', message: msg });

  if (!isObject(data)) { e('feature must be a JSON object'); return results; }

  if (typeof data['id'] !== 'string' || !KEBAB_CASE_RE.test(data['id'])) {
    e("'id' must be a kebab-case string");
  }
  const expectedFilename = `${data['id']}.json`;
  if (basename(filepath) !== expectedFilename && typeof data['id'] === 'string') {
    e(`filename must match id: expected '${expectedFilename}', got '${basename(filepath)}'`);
  }

  if (typeof data['intent'] !== 'string' || data['intent'].length === 0) e("'intent' is required and must be non-empty");

  if (!Array.isArray(data['acceptance_criteria']) || data['acceptance_criteria'].length === 0) {
    e("'acceptance_criteria' must be a non-empty array of strings");
  } else if (!data['acceptance_criteria'].every((c: unknown) => typeof c === 'string' && c.length > 0)) {
    e("each acceptance criterion must be a non-empty string");
  } else if (data['acceptance_criteria'].some((c: unknown) => typeof c === 'string' && c.startsWith('[MIGRATION]'))) {
    results.push({ file: filepath, severity: 'warning', error_type: 'migration', message: "acceptance_criteria contains [MIGRATION] placeholder — replace with real criteria" });
  }

  if (typeof data['status'] !== 'string' || !(VALID_FEATURE_STATUSES as readonly string[]).includes(data['status'])) {
    e(`'status' must be one of: ${VALID_FEATURE_STATUSES.join(', ')}`);
  }

  if (!isStringArray(data['packets'])) {
    e("'packets' must be an array of strings");
  }

  const createdByCheck = isValidIdentity(data['created_by'], VALID_IDENTITY_KINDS as unknown as string[]);
  if (!createdByCheck.valid) e(`'created_by': ${createdByCheck.reason}`);

  if (data['created_at'] != null && !isValidISO8601(data['created_at'])) {
    e("'created_at' must be a valid ISO 8601 timestamp");
  }

  if (data['approved_at'] != null && data['approved_at'] !== null && !isValidISO8601(data['approved_at'])) {
    e("'approved_at' must be a valid ISO 8601 timestamp or null");
  }

  if (data['intent_id'] != null && data['intent_id'] !== null && typeof data['intent_id'] !== 'string') {
    e("'intent_id' must be a string or null");
  }

  if (data['planned_by'] != null && data['planned_by'] !== null) {
    const plannedByCheck = isValidIdentity(data['planned_by'], VALID_IDENTITY_KINDS as unknown as string[]);
    if (!plannedByCheck.valid) e(`'planned_by': ${plannedByCheck.reason}`);
  }

  if (data['planned_at'] != null && data['planned_at'] !== null && !isValidISO8601(data['planned_at'])) {
    e("'planned_at' must be a valid ISO 8601 timestamp or null");
  }

  return results;
}

function validateIntentSchema(filepath: string, data: unknown): ValidationResult[] {
  const results: ValidationResult[] = [];
  const e = (msg: string) => results.push({ file: filepath, severity: 'error', error_type: 'schema', message: msg });

  if (!isObject(data)) { e('intent must be a JSON object'); return results; }

  if (typeof data['id'] !== 'string' || !KEBAB_CASE_RE.test(data['id'])) {
    e("'id' must be a kebab-case string");
  }
  const expectedFilename = `${data['id']}.json`;
  if (basename(filepath) !== expectedFilename && typeof data['id'] === 'string') {
    e(`filename must match id: expected '${expectedFilename}', got '${basename(filepath)}'`);
  }

  if (typeof data['title'] !== 'string' || data['title'].length === 0) e("'title' is required and must be non-empty");

  const hasInlineSpec = typeof data['spec'] === 'string' && (data['spec'] as string).length > 0;
  const hasSpecPath = typeof data['spec_path'] === 'string' && (data['spec_path'] as string).length > 0;
  if (data['spec'] != null && typeof data['spec'] !== 'string') {
    e("'spec' must be a string if present");
  }
  if (data['spec_path'] != null && typeof data['spec_path'] !== 'string') {
    e("'spec_path' must be a string if present");
  }
  if (hasInlineSpec && hasSpecPath) {
    e("'spec' and 'spec_path' are mutually exclusive — provide exactly one");
  } else if (!hasInlineSpec && !hasSpecPath) {
    e("either 'spec' or 'spec_path' is required");
  } else if (hasSpecPath) {
    const specPath = data['spec_path'] as string;
    const resolved = resolveSpecPath(PROJECT_ROOT, specPath);
    if (!resolved.ok) {
      e(resolved.error);
    } else if (!existsSync(resolved.absolutePath)) {
      e(`'spec_path' points to a file that does not exist: '${specPath}'`);
    } else {
      try {
        const contents = readFileSync(resolved.absolutePath, 'utf-8');
        if (contents.length === 0) {
          e(`'spec_path' points to an empty file: '${specPath}'`);
        }
      } catch (err) {
        e(`'spec_path' could not be read: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const validIntentStatuses = ['proposed', 'approved', 'planned', 'superseded', 'delivered'];
  if (typeof data['status'] !== 'string' || !validIntentStatuses.includes(data['status'])) {
    e(`'status' must be one of: ${validIntentStatuses.join(', ')}`);
  }

  if (data['constraints'] != null && !isStringArray(data['constraints'])) {
    e("'constraints' must be an array of strings");
  }

  if (data['feature_id'] != null && data['feature_id'] !== null && typeof data['feature_id'] !== 'string') {
    e("'feature_id' must be a string or null");
  }

  const createdByCheck = isValidIdentity(data['created_by'], VALID_IDENTITY_KINDS as unknown as string[]);
  if (!createdByCheck.valid) e(`'created_by': ${createdByCheck.reason}`);

  if (!isValidISO8601(data['created_at'])) {
    e("'created_at' must be a valid ISO 8601 timestamp");
  }

  if (data['planned_at'] != null && data['planned_at'] !== null && !isValidISO8601(data['planned_at'])) {
    e("'planned_at' must be a valid ISO 8601 timestamp or null");
  }

  if (data['approved_at'] != null && data['approved_at'] !== null && !isValidISO8601(data['approved_at'])) {
    e("'approved_at' must be a valid ISO 8601 timestamp or null");
  }

  return results;
}

// ---------------------------------------------------------------------------
// Referential integrity (Layer 2) + Invariants (Layer 5)
// ---------------------------------------------------------------------------

interface ArtifactIndex {
  packetIds: Set<string>;
  completionPacketIds: Set<string>;
  acceptancePacketIds: Set<string>;
  rejectionPacketIds: Set<string>;
  evidenceKeys: Set<string>;
  allDeclaredDeps: Set<string>;
  packets: Array<{ id: string; kind: string; verifies: string | null; change_class: string; packages: string[]; dependencies: string[]; started_at: string | null; status: string | null; environment_dependencies: string[]; acceptance_criteria: string[]; feature_id: string | null }>;
  completions: Array<{ packet_id: string; completed_by_id: string }>;
  acceptances: Array<{ packet_id: string; accepted_by_kind: string }>;
  rejections: Array<{ packet_id: string; rejected_by_kind: string }>;
  features: Array<{ id: string; status: string; packets: string[] }>;
  intents: Array<{ id: string; status: string; feature_id: string | null }>;
}

function buildIndex(
  packets: Array<{ data: unknown }>,
  completions: Array<{ data: unknown }>,
  acceptances: Array<{ data: unknown }>,
  rejections: Array<{ data: unknown }>,
  evidence: Array<{ data: unknown }>,
  features: Array<{ data: unknown }>,
  intents: Array<{ data: unknown }>,
): ArtifactIndex {
  const index: ArtifactIndex = {
    packetIds: new Set(),
    completionPacketIds: new Set(),
    acceptancePacketIds: new Set(),
    rejectionPacketIds: new Set(),
    evidenceKeys: new Set(),
    allDeclaredDeps: new Set(),
    packets: [],
    completions: [],
    acceptances: [],
    rejections: [],
    features: [],
    intents: [],
  };

  for (const { data } of packets) {
    if (isObject(data) && typeof data['id'] === 'string') {
      index.packetIds.add(data['id']);
      const scope = isObject(data['scope']) ? data['scope'] : {};
      const pkgs = isStringArray(scope['packages']) ? scope['packages'] : [];
      const startedAt = typeof data['started_at'] === 'string' ? data['started_at'] : null;
      const packetStatus = typeof data['status'] === 'string' ? data['status'] : null;
      const kind = typeof data['kind'] === 'string' ? data['kind'] : 'dev';
      const verifies = typeof data['verifies'] === 'string' ? data['verifies'] : null;
      const packetDeps = isStringArray(data['dependencies']) ? data['dependencies'] : [];
      const envDeps = isStringArray(data['environment_dependencies']) ? data['environment_dependencies'] : [];
      const acceptanceCriteria = isStringArray(data['acceptance_criteria']) ? data['acceptance_criteria'] : [];
      const featureId = typeof data['feature_id'] === 'string' ? data['feature_id'] : null;
      index.packets.push({
        id: data['id'],
        kind,
        verifies,
        change_class: typeof data['change_class'] === 'string' ? data['change_class'] : '',
        packages: pkgs,
        dependencies: packetDeps,
        started_at: startedAt,
        status: packetStatus,
        environment_dependencies: envDeps,
        acceptance_criteria: acceptanceCriteria,
        feature_id: featureId,
      });
      for (const d of envDeps) index.allDeclaredDeps.add(d);
    }
  }

  for (const { data } of completions) {
    if (isObject(data) && typeof data['packet_id'] === 'string') {
      index.completionPacketIds.add(data['packet_id']);
      const by = isObject(data['completed_by']) ? data['completed_by'] : {};
      index.completions.push({
        packet_id: data['packet_id'],
        completed_by_id: typeof by['id'] === 'string' ? by['id'] : '',
      });
    }
  }

  for (const { data } of acceptances) {
    if (isObject(data) && typeof data['packet_id'] === 'string') {
      index.acceptancePacketIds.add(data['packet_id']);
      const by = isObject(data['accepted_by']) ? data['accepted_by'] : {};
      index.acceptances.push({
        packet_id: data['packet_id'],
        accepted_by_kind: typeof by['kind'] === 'string' ? by['kind'] : '',
      });
    }
  }

  for (const { data } of rejections) {
    if (isObject(data) && typeof data['packet_id'] === 'string') {
      index.rejectionPacketIds.add(data['packet_id']);
      const by = isObject(data['rejected_by']) ? data['rejected_by'] : {};
      index.rejections.push({
        packet_id: data['packet_id'],
        rejected_by_kind: typeof by['kind'] === 'string' ? by['kind'] : '',
      });
    }
  }

  for (const { data } of evidence) {
    if (isObject(data) && typeof data['dependency_key'] === 'string') {
      index.evidenceKeys.add(data['dependency_key']);
    }
  }

  for (const { data } of features) {
    if (isObject(data) && typeof data['id'] === 'string') {
      const featurePackets = isStringArray(data['packets']) ? data['packets'] : [];
      const featureStatus = typeof data['status'] === 'string' ? data['status'] : '';
      index.features.push({ id: data['id'], status: featureStatus, packets: featurePackets });
    }
  }

  for (const { data } of intents) {
    if (isObject(data) && typeof data['id'] === 'string') {
      index.intents.push({
        id: data['id'],
        status: typeof data['status'] === 'string' ? data['status'] : '',
        feature_id: typeof data['feature_id'] === 'string' ? data['feature_id'] : null,
      });
    }
  }

  return index;
}

function validateIntegrity(index: ArtifactIndex): ValidationResult[] {
  const results: ValidationResult[] = [];

  // Orphaned completions
  for (const pid of index.completionPacketIds) {
    if (!index.packetIds.has(pid)) {
      results.push({
        file: `completions/${pid}.json`,
        severity: 'error',
        error_type: 'referential',
        message: `Orphaned completion: packet '${pid}' does not exist`,
      });
    }
  }

  // FI-4: Acceptance without completion
  for (const pid of index.acceptancePacketIds) {
    if (!index.completionPacketIds.has(pid)) {
      results.push({
        file: `acceptances/${pid}.json`,
        severity: 'error',
        error_type: 'invariant',
        message: `FI-4 violation: acceptance for '${pid}' but no completion exists`,
      });
    }
    if (!index.packetIds.has(pid)) {
      results.push({
        file: `acceptances/${pid}.json`,
        severity: 'error',
        error_type: 'referential',
        message: `Orphaned acceptance: packet '${pid}' does not exist`,
      });
    }
  }

  // Orphaned rejections
  for (const pid of index.rejectionPacketIds) {
    if (!index.packetIds.has(pid)) {
      results.push({
        file: `rejections/${pid}.json`,
        severity: 'error',
        error_type: 'referential',
        message: `Orphaned rejection: packet '${pid}' does not exist`,
      });
    }
  }

  // FI-3: Agent-authored acceptances
  for (const acc of index.acceptances) {
    if (acc.accepted_by_kind === 'agent') {
      results.push({
        file: `acceptances/${acc.packet_id}.json`,
        severity: 'error',
        error_type: 'authority',
        message: `FI-3 violation: agent-authored acceptance for '${acc.packet_id}'`,
      });
    }
  }

  // FI-3: Agent-authored rejections
  for (const rej of index.rejections) {
    if (rej.rejected_by_kind === 'agent') {
      results.push({
        file: `rejections/${rej.packet_id}.json`,
        severity: 'error',
        error_type: 'authority',
        message: `FI-3 violation: agent-authored rejection for '${rej.packet_id}'`,
      });
    }
  }

  // Change class consistency heuristic (Layer 4) — warning only
  for (const p of index.packets) {
    if (p.packages.length > 1 && (p.change_class === 'trivial' || p.change_class === 'local')) {
      results.push({
        file: `packets/${p.id}.json`,
        severity: 'warning',
        error_type: 'consistency',
        message: `Packet '${p.id}' touches ${p.packages.length} packages but change_class is '${p.change_class}' — consider 'cross_cutting'`,
      });
    }
  }

  // Orphaned evidence
  for (const key of index.evidenceKeys) {
    if (!index.allDeclaredDeps.has(key)) {
      results.push({
        file: `evidence/${key}.json`,
        severity: 'warning',
        error_type: 'referential',
        message: `Evidence for '${key}' but no packet declares this dependency`,
      });
    }
  }

  // Feature referential integrity: feature.packets must reference existing packet IDs
  for (const f of index.features) {
    for (const pid of f.packets) {
      if (!index.packetIds.has(pid)) {
        results.push({
          file: `features/${f.id}.json`,
          severity: 'error',
          error_type: 'referential',
          message: `Feature '${f.id}' references packet '${pid}' which does not exist`,
        });
      }
    }
  }

  // Packet feature_id integrity: if declared, the feature must exist and include the packet
  for (const p of index.packets) {
    if (p.feature_id === null) continue;
    const feature = index.features.find((f) => f.id === p.feature_id);
    if (feature === undefined) {
      results.push({
        file: `packets/${p.id}.json`,
        severity: 'error',
        error_type: 'referential',
        message: `Packet '${p.id}' declares feature_id '${p.feature_id}' but that feature does not exist`,
      });
      continue;
    }
    if (!feature.packets.includes(p.id)) {
      results.push({
        file: `packets/${p.id}.json`,
        severity: 'error',
        error_type: 'referential',
        message: `Packet '${p.id}' declares feature_id '${p.feature_id}' but the feature does not list this packet`,
      });
    }
  }

  // Intent linkage integrity
  for (const intent of index.intents) {
    if (intent.feature_id === null) {
      if (intent.status === 'planned' || intent.status === 'delivered') {
        results.push({
          file: `intents/${intent.id}.json`,
          severity: 'error',
          error_type: 'referential',
          message: `Intent '${intent.id}' is '${intent.status}' but has no linked feature_id`,
        });
      }
      continue;
    }

    const feature = index.features.find((candidate) => candidate.id === intent.feature_id);
    if (feature === undefined) {
      results.push({
        file: `intents/${intent.id}.json`,
        severity: 'error',
        error_type: 'referential',
        message: `Intent '${intent.id}' references feature '${intent.feature_id}' which does not exist`,
      });
      continue;
    }

    if (intent.status === 'proposed') {
      results.push({
        file: `intents/${intent.id}.json`,
        severity: 'error',
        error_type: 'invariant',
        message: `Intent '${intent.id}' is still 'proposed' but already links feature '${intent.feature_id}'`,
      });
    }

    if (intent.status === 'approved' && feature.status === 'draft') {
      results.push({
        file: `intents/${intent.id}.json`,
        severity: 'error',
        error_type: 'invariant',
        message: `Intent '${intent.id}' is 'approved' but linked feature '${feature.id}' is still 'draft'. Planner output must be at least 'planned'.`,
      });
    }

    if (intent.status === 'delivered' && feature.status !== 'completed' && feature.status !== 'delivered') {
      results.push({
        file: `intents/${intent.id}.json`,
        severity: 'error',
        error_type: 'invariant',
        message: `Intent '${intent.id}' is 'delivered' but feature '${feature.id}' is '${feature.status}'`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // QA packet structural checks
  // -------------------------------------------------------------------------
  for (const p of index.packets) {
    if (p.kind === 'qa' && p.verifies !== null) {
      if (!index.packetIds.has(p.verifies)) {
        results.push({
          file: `packets/${p.id}.json`,
          severity: 'error',
          error_type: 'referential',
          message: `QA packet '${p.id}' verifies '${p.verifies}' which does not exist`,
        });
      } else {
        const target = index.packets.find((t) => t.id === p.verifies);
        if (target !== undefined && target.kind !== 'dev') {
          results.push({
            file: `packets/${p.id}.json`,
            severity: 'error',
            error_type: 'referential',
            message: `QA packet '${p.id}' verifies '${p.verifies}' which is not a dev packet`,
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // FI-7: QA packet completion identity must differ from dev packet identity
  // -------------------------------------------------------------------------
  const completionIdentityMap = new Map<string, string>();
  for (const c of index.completions) {
    completionIdentityMap.set(c.packet_id, c.completed_by_id);
  }

  for (const p of index.packets) {
    if (p.kind !== 'qa' || p.verifies === null) continue;
    const qaIdentity = completionIdentityMap.get(p.id);
    const devIdentity = completionIdentityMap.get(p.verifies);
    if (qaIdentity !== undefined && devIdentity !== undefined && qaIdentity === devIdentity) {
      results.push({
        file: `completions/${p.id}.json`,
        severity: 'error',
        error_type: 'invariant',
        message: `FI-7 violation: QA packet '${p.id}' completed by '${qaIdentity}' — same identity as dev packet '${p.verifies}'. Reviewer must differ from implementer.`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // FI-8: Every dev packet in a feature must have a QA counterpart
  // -------------------------------------------------------------------------
  const qaVerifiesMap = new Set<string>();
  for (const p of index.packets) {
    if (p.kind === 'qa' && p.verifies !== null) {
      qaVerifiesMap.add(p.verifies);
    }
  }
  for (const f of index.features) {
    const featurePacketSet = new Set(f.packets);
    for (const pid of f.packets) {
      const packet = index.packets.find((p) => p.id === pid);
      if (packet === undefined) continue;
      if (packet.kind !== 'dev') continue;
      if (packet.status === 'abandoned' || packet.status === 'deferred') continue;
      // Check that a QA packet verifying this dev packet exists in the same feature
      const hasQa = index.packets.some((p) =>
        p.kind === 'qa' && p.verifies === pid && featurePacketSet.has(p.id),
      );
      if (!hasQa) {
        results.push({
          file: `features/${f.id}.json`,
          severity: 'error',
          error_type: 'invariant',
          message: `FI-8 violation: dev packet '${pid}' in feature '${f.id}' has no QA counterpart. Add a QA packet with verifies: "${pid}".`,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // FI-9: No cyclic packet dependencies
  // -------------------------------------------------------------------------
  const depGraph = new Map<string, string[]>();
  for (const p of index.packets) {
    depGraph.set(p.id, p.dependencies);
  }

  function hasCycle(startId: string): boolean {
    const visited = new Set<string>();
    const stack = new Set<string>();
    function dfs(id: string): boolean {
      if (stack.has(id)) return true;
      if (visited.has(id)) return false;
      visited.add(id);
      stack.add(id);
      for (const dep of depGraph.get(id) ?? []) {
        if (dfs(dep)) return true;
      }
      stack.delete(id);
      return false;
    }
    return dfs(startId);
  }

  const reportedCycles = new Set<string>();
  for (const p of index.packets) {
    if (reportedCycles.has(p.id)) continue;
    if (hasCycle(p.id)) {
      results.push({
        file: `packets/${p.id}.json`,
        severity: 'error',
        error_type: 'invariant',
        message: `FI-9 violation: packet '${p.id}' is part of a dependency cycle`,
      });
      reportedCycles.add(p.id);
    }
  }

  // -------------------------------------------------------------------------
  // FI-10: Feature status transitions must be valid
  // -------------------------------------------------------------------------
  const STATUS_ORDER: Record<string, number> = {
    draft: 0,
    planned: 1,
    approved: 2,
    executing: 3,
    completed: 4,
    delivered: 5,
  };

  for (const f of index.features) {
    const order = STATUS_ORDER[f.status];
    if (order === undefined) continue;

    // completed requires all packets to have completions
    if (f.status === 'completed' || f.status === 'delivered') {
      for (const pid of f.packets) {
        if (!index.completionPacketIds.has(pid)) {
          const packet = index.packets.find((p) => p.id === pid);
          if (packet !== undefined && packet.status !== 'abandoned' && packet.status !== 'deferred') {
            results.push({
              file: `features/${f.id}.json`,
              severity: 'error',
              error_type: 'invariant',
              message: `FI-10 violation: feature '${f.id}' is '${f.status}' but packet '${pid}' has no completion`,
            });
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // FI-5.5: Completions require an explicit packet start
  // -------------------------------------------------------------------------
  for (const p of index.packets) {
    if (index.completionPacketIds.has(p.id) && p.started_at === null) {
      results.push({
        file: `completions/${p.id}.json`,
        severity: 'error',
        error_type: 'invariant',
        message: `Packet '${p.id}' has a completion record but was never started. ` +
          `Run tools/start.ts before implementation so the factory can track active work truthfully.`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // FI-6: No progression without completion
  // -------------------------------------------------------------------------
  const startedPackets = index.packets
    .filter((p) => p.started_at !== null && p.status !== 'abandoned' && p.status !== 'deferred')
    .sort((a, b) => (a.started_at ?? '').localeCompare(b.started_at ?? ''));

  if (startedPackets.length > 0) {
    let latestCompletedStartedAt: string | null = null;
    for (const p of startedPackets) {
      if (index.completionPacketIds.has(p.id) && p.started_at !== null) {
        if (latestCompletedStartedAt === null || p.started_at > latestCompletedStartedAt) {
          latestCompletedStartedAt = p.started_at;
        }
      }
    }

    if (latestCompletedStartedAt !== null) {
      for (const p of startedPackets) {
        if (
          !index.completionPacketIds.has(p.id) &&
          p.started_at !== null &&
          p.started_at < latestCompletedStartedAt
        ) {
          results.push({
            file: `packets/${p.id}.json`,
            severity: 'error',
            error_type: 'invariant',
            message: `FI-6 violation: packet '${p.id}' is started but incomplete, while newer packets have completions. ` +
              `Work must not progress past an incomplete packet. ` +
              `Fix: create a completion record, or mark this packet as abandoned/deferred.`,
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // QA evidence enforcement: completed QA packets with environment_dependencies
  // must have all evidence records present
  // -------------------------------------------------------------------------
  for (const p of index.packets) {
    if (p.kind === 'qa' && p.environment_dependencies.length > 0 && index.completionPacketIds.has(p.id)) {
      for (const dep of p.environment_dependencies) {
        if (!index.evidenceKeys.has(dep)) {
          results.push({
            file: `completions/${p.id}.json`,
            severity: 'error',
            error_type: 'invariant',
            message: `QA packet '${p.id}' has environment_dependency '${dep}' but no evidence record exists. ` +
              `QA completions require evidence for all declared environment dependencies.`,
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // QA runtime verification must declare environment dependencies so evidence
  // can be enforced at completion time.
  // -------------------------------------------------------------------------
  const RUNTIME_HINTS = /\b(render|display|show|launch|screenshot|ui|ipc|window|desktop|browser|click|navigate|visual)\b/i;
  const MIGRATION_MARKER = /\[MIGRATION\]/;
  for (const p of index.packets) {
    if (p.kind !== 'qa') continue;
    if (p.environment_dependencies.length > 0) continue; // already declared, enforcement handles it
    if (p.acceptance_criteria.some((c) => MIGRATION_MARKER.test(c))) continue; // migrated, not yet reviewed
    const runtimeCriteria = p.acceptance_criteria.filter((c) => RUNTIME_HINTS.test(c));
    if (runtimeCriteria.length > 0) {
      results.push({
        file: `packets/${p.id}.json`,
        severity: 'error',
        error_type: 'invariant',
        message: `QA packet '${p.id}' has acceptance criteria that suggest runtime verification ` +
          `but declares no environment_dependencies. Add environment_dependencies ` +
          `so the factory can enforce evidence collection. ` +
          `Criteria: "${runtimeCriteria[0]}"${runtimeCriteria.length > 1 ? ` (+${String(runtimeCriteria.length - 1)} more)` : ''}`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Supervisor dispatch enforcement: if supervisor state exists, started feature
  // packets must have been dispatched by the supervisor before work began.
  // -------------------------------------------------------------------------
  const localSupervisorStatePath = join(ARTIFACT_ROOT, 'supervisor', 'state.json');
  if (existsSync(localSupervisorStatePath)) {
    try {
      const rawSupervisor = JSON.parse(readFileSync(localSupervisorStatePath, 'utf-8')) as Record<string, unknown>;
      const featureTracking = isObject(rawSupervisor['features'])
        ? rawSupervisor['features'] as Record<string, unknown>
        : {};

      for (const p of index.packets) {
        if (p.started_at === null || p.feature_id === null) continue;
        const tracked = featureTracking[p.feature_id];
        if (!isObject(tracked)) continue;
        const activeDispatchesRaw = Array.isArray(tracked['active_dispatches']) ? tracked['active_dispatches'] : [];
        const activeDispatchPacketIds = activeDispatchesRaw
          .filter(isObject)
          .map((dispatch) => typeof dispatch['packet_id'] === 'string' ? dispatch['packet_id'] : null)
          .filter((packetId): packetId is string => packetId !== null);
        const authorizedPacketIds = activeDispatchPacketIds.length > 0
          ? activeDispatchPacketIds
          : (isStringArray(tracked['packets_spawned']) ? tracked['packets_spawned'] : []);
        if (!authorizedPacketIds.includes(p.id)) {
          results.push({
            file: `packets/${p.id}.json`,
            severity: 'error',
            error_type: 'invariant',
            message: `Packet '${p.id}' is started under supervisor mode but was never dispatched by supervisor feature '${p.feature_id}'. ` +
              `Only packets returned by supervise.ts ready_packets may be started.`,
          });
        }
      }
    } catch {
      // supervisor state parse issues are handled in main()
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const allResults: ValidationResult[] = [];

  // Read all artifacts
  const packets = readJsonFiles('packets');
  const completions = readJsonFiles('completions');
  const acceptances = readJsonFiles('acceptances');
  const rejections = readJsonFiles('rejections');
  const evidence = readJsonFiles('evidence');
  const features = readJsonFiles('features');
  const intents = readJsonFiles('intents');

  // Check for parse failures
  for (const collection of [
    { name: 'packets', items: packets },
    { name: 'completions', items: completions },
    { name: 'acceptances', items: acceptances },
    { name: 'rejections', items: rejections },
    { name: 'evidence', items: evidence },
    { name: 'features', items: features },
    { name: 'intents', items: intents },
  ]) {
    for (const item of collection.items) {
      if (item.data === null) {
        allResults.push({
          file: item.filepath,
          severity: 'error',
          error_type: 'schema',
          message: 'Failed to parse JSON',
        });
      }
    }
  }

  // Schema validation (Layer 1)
  for (const p of packets) {
    if (p.data != null) allResults.push(...validatePacketSchema(p.filepath, p.data));
  }
  for (const c of completions) {
    if (c.data != null) allResults.push(...validateCompletionSchema(c.filepath, c.data));
  }
  for (const a of acceptances) {
    if (a.data != null) allResults.push(...validateAcceptanceSchema(a.filepath, a.data));
  }
  for (const r of rejections) {
    if (r.data != null) allResults.push(...validateRejectionSchema(r.filepath, r.data));
  }
  for (const e of evidence) {
    if (e.data != null) allResults.push(...validateEvidenceSchema(e.filepath, e.data));
  }
  for (const f of features) {
    if (f.data != null) allResults.push(...validateFeatureSchema(f.filepath, f.data));
  }
  for (const i of intents) {
    if (i.data != null) allResults.push(...validateIntentSchema(i.filepath, i.data));
  }

  // Referential integrity + invariants (Layers 2-5)
  const index = buildIndex(packets, completions, acceptances, rejections, evidence, features, intents);
  allResults.push(...validateIntegrity(index));

  // FI-1: Check for duplicate completions
  const completionCounts = new Map<string, number>();
  for (const c of completions) {
    if (isObject(c.data) && typeof c.data['packet_id'] === 'string') {
      const pid = c.data['packet_id'];
      completionCounts.set(pid, (completionCounts.get(pid) ?? 0) + 1);
    }
  }
  for (const [pid, count] of completionCounts) {
    if (count > 1) {
      allResults.push({
        file: `completions/${pid}.json`,
        severity: 'error',
        error_type: 'invariant',
        message: `FI-1 violation: ${count} completion records for packet '${pid}'`,
      });
    }
  }

  // FI-2: Check for duplicate acceptances
  const acceptanceCounts = new Map<string, number>();
  for (const a of acceptances) {
    if (isObject(a.data) && typeof a.data['packet_id'] === 'string') {
      const pid = a.data['packet_id'];
      acceptanceCounts.set(pid, (acceptanceCounts.get(pid) ?? 0) + 1);
    }
  }
  for (const [pid, count] of acceptanceCounts) {
    if (count > 1) {
      allResults.push({
        file: `acceptances/${pid}.json`,
        severity: 'error',
        error_type: 'invariant',
        message: `FI-2 violation: ${count} acceptance records for packet '${pid}'`,
      });
    }
  }

  // Supervisor state validation (if supervisor/state.json exists)
  const supervisorStatePath = join(ARTIFACT_ROOT, 'supervisor', 'state.json');
  if (existsSync(supervisorStatePath)) {
    try {
      const rawSupervisor = JSON.parse(readFileSync(supervisorStatePath, 'utf-8')) as Record<string, unknown>;

      // Basic schema checks
      if (typeof rawSupervisor['version'] !== 'number') {
        allResults.push({ file: 'supervisor/state.json', severity: 'error', error_type: 'schema', message: "'version' must be a number" });
      }
      if (typeof rawSupervisor['updated_at'] !== 'string') {
        allResults.push({ file: 'supervisor/state.json', severity: 'error', error_type: 'schema', message: "'updated_at' must be a string" });
      }
      if (!isObject(rawSupervisor['updated_by'])) {
        allResults.push({ file: 'supervisor/state.json', severity: 'error', error_type: 'schema', message: "'updated_by' must be an object" });
      }
      if (!isObject(rawSupervisor['features'])) {
        allResults.push({ file: 'supervisor/state.json', severity: 'error', error_type: 'schema', message: "'features' must be an object" });
      }
      if (!Array.isArray(rawSupervisor['pending_escalations'])) {
        allResults.push({ file: 'supervisor/state.json', severity: 'error', error_type: 'schema', message: "'pending_escalations' must be an array" });
      }
      if (!Array.isArray(rawSupervisor['audit_log'])) {
        allResults.push({ file: 'supervisor/state.json', severity: 'error', error_type: 'schema', message: "'audit_log' must be an array" });
      }

      // SI-1: Check that tracked features reference real features
      if (isObject(rawSupervisor['features'])) {
        const featureIndex = new Set(features.map((f) => {
          const d = f.data as Record<string, unknown> | null;
          return d !== null && typeof d['id'] === 'string' ? d['id'] : '';
        }).filter((id) => id !== ''));
        const supervisorFeatures = rawSupervisor['features'] as Record<string, unknown>;

        for (const key of Object.keys(supervisorFeatures)) {
          if (!featureIndex.has(key)) {
            allResults.push({
              file: 'supervisor/state.json',
              severity: 'warning',
              error_type: 'referential',
              message: `SI-1: supervisor tracks feature '${key}' which does not exist in features/`,
            });
          }
          const tracking = supervisorFeatures[key];
          if (isObject(tracking) && !Array.isArray(tracking['active_dispatches'])) {
            allResults.push({
              file: 'supervisor/state.json',
              severity: 'error',
              error_type: 'schema',
              message: `feature '${key}' must define active_dispatches as an array`,
            });
          }
          if (isObject(tracking) && Array.isArray(tracking['active_dispatches'])) {
            for (const dispatch of tracking['active_dispatches']) {
              if (!isObject(dispatch)) {
                allResults.push({ file: 'supervisor/state.json', severity: 'error', error_type: 'schema', message: `feature '${key}' has a non-object active_dispatch entry` });
                continue;
              }
              const packetId = typeof dispatch['packet_id'] === 'string' ? dispatch['packet_id'] : null;
              const featureId = typeof dispatch['feature_id'] === 'string' ? dispatch['feature_id'] : null;
              const dispatchIdValue = typeof dispatch['dispatch_id'] === 'string' ? dispatch['dispatch_id'] : null;
              if (packetId === null || featureId === null || dispatchIdValue === null) {
                allResults.push({ file: 'supervisor/state.json', severity: 'error', error_type: 'schema', message: `feature '${key}' has an invalid active_dispatch entry` });
                continue;
              }
              const feature = index.features.find((f) => f.id === key);
              if (feature === undefined || featureId !== key || !feature.packets.includes(packetId)) {
                allResults.push({ file: 'supervisor/state.json', severity: 'error', error_type: 'invariant', message: `active dispatch '${dispatchIdValue}' does not match feature '${key}' packet membership` });
              }
              if (!index.packetIds.has(packetId)) {
                allResults.push({ file: 'supervisor/state.json', severity: 'error', error_type: 'referential', message: `active dispatch '${dispatchIdValue}' references missing packet '${packetId}'` });
              }
            }
          }
        }
      }
    } catch {
      allResults.push({ file: 'supervisor/state.json', severity: 'error', error_type: 'schema', message: 'Failed to parse supervisor state JSON' });
    }

    const supervisorMemoryPath = join(ARTIFACT_ROOT, 'supervisor', 'memory.md');
    if (!existsSync(supervisorMemoryPath)) {
      allResults.push({
        file: 'supervisor/memory.md',
        severity: 'warning',
        error_type: 'referential',
        message: 'Supervisor state exists but supervisor/memory.md is missing',
      });
    }
  }

  // Orchestrator state validation (if supervisor/orchestrator-state.json exists)
  const orchestratorStatePath = join(ARTIFACT_ROOT, 'supervisor', 'orchestrator-state.json');
  if (existsSync(orchestratorStatePath)) {
    try {
      const rawOrchestrator = JSON.parse(readFileSync(orchestratorStatePath, 'utf-8')) as Record<string, unknown>;
      if (typeof rawOrchestrator['version'] !== 'number') {
        allResults.push({ file: 'supervisor/orchestrator-state.json', severity: 'error', error_type: 'schema', message: "'version' must be a number" });
      }
      if (typeof rawOrchestrator['updated_at'] !== 'string') {
        allResults.push({ file: 'supervisor/orchestrator-state.json', severity: 'error', error_type: 'schema', message: "'updated_at' must be a string" });
      }
      if (!isObject(rawOrchestrator['updated_by'])) {
        allResults.push({ file: 'supervisor/orchestrator-state.json', severity: 'error', error_type: 'schema', message: "'updated_by' must be an object" });
      }
      if (!isObject(rawOrchestrator['provider_health'])) {
        allResults.push({ file: 'supervisor/orchestrator-state.json', severity: 'error', error_type: 'schema', message: "'provider_health' must be an object" });
      }
      if (!isObject(rawOrchestrator['cache'])) {
        allResults.push({ file: 'supervisor/orchestrator-state.json', severity: 'error', error_type: 'schema', message: "'cache' must be an object" });
      }
      if (!Array.isArray(rawOrchestrator['recent_runs'])) {
        allResults.push({ file: 'supervisor/orchestrator-state.json', severity: 'error', error_type: 'schema', message: "'recent_runs' must be an array" });
      }

      if (isObject(rawOrchestrator['provider_health'])) {
        for (const [provider, value] of Object.entries(rawOrchestrator['provider_health'])) {
          if (provider !== 'codex' && provider !== 'claude') {
            allResults.push({ file: 'supervisor/orchestrator-state.json', severity: 'error', error_type: 'schema', message: `unsupported provider_health key '${provider}'` });
            continue;
          }
          if (!isObject(value)) {
            allResults.push({ file: 'supervisor/orchestrator-state.json', severity: 'error', error_type: 'schema', message: `provider_health['${provider}'] must be an object` });
            continue;
          }
          if (typeof value['available'] !== 'boolean') {
            allResults.push({ file: 'supervisor/orchestrator-state.json', severity: 'error', error_type: 'schema', message: `provider_health['${provider}'].available must be a boolean` });
          }
        }
      }

      if (Array.isArray(rawOrchestrator['recent_runs'])) {
        for (const run of rawOrchestrator['recent_runs']) {
          if (!isObject(run)) {
            allResults.push({ file: 'supervisor/orchestrator-state.json', severity: 'error', error_type: 'schema', message: 'recent_runs entries must be objects' });
            continue;
          }
          const provider = typeof run['provider'] === 'string' ? run['provider'] : null;
          const featureId = typeof run['feature_id'] === 'string' ? run['feature_id'] : null;
          const dispatchIdValue = typeof run['dispatch_id'] === 'string' ? run['dispatch_id'] : null;
          if (provider !== null && provider !== 'codex' && provider !== 'claude') {
            allResults.push({ file: 'supervisor/orchestrator-state.json', severity: 'error', error_type: 'schema', message: `recent run references unsupported provider '${provider}'` });
          }
          if (featureId !== null && !index.features.some((feature) => feature.id === featureId)) {
            allResults.push({ file: 'supervisor/orchestrator-state.json', severity: 'warning', error_type: 'referential', message: `recent run references feature '${featureId}' which does not exist` });
          }
          if (dispatchIdValue !== null && !/^dispatch-/.test(dispatchIdValue)) {
            allResults.push({ file: 'supervisor/orchestrator-state.json', severity: 'error', error_type: 'schema', message: `recent run has invalid dispatch_id '${dispatchIdValue}'` });
          }
        }
      }
    } catch {
      allResults.push({ file: 'supervisor/orchestrator-state.json', severity: 'error', error_type: 'schema', message: 'Failed to parse orchestrator state JSON' });
    }
  }

  // Report
  const errors = allResults.filter((r) => r.severity === 'error');
  const warnings = allResults.filter((r) => r.severity === 'warning');

  const summary = `${packets.length} packets, ${completions.length} completions, ${acceptances.length} acceptances, ${rejections.length} rejections, ${evidence.length} evidence records, ${features.length} features, ${intents.length} intents`;

  if (allResults.length === 0) {
    console.log(`${fmt.sym.ok} ${fmt.success('Factory validation: PASS')}`);
    console.log(`  ${summary}`);
    process.exit(0);
  }

  if (errors.length > 0) {
    console.log(`${fmt.sym.fail} ${fmt.error(`Factory validation: FAIL (${errors.length} error(s), ${warnings.length} warning(s))`)}`);
  } else {
    console.log(`${fmt.sym.warn} ${fmt.warn(`Factory validation: PASS with warnings (${warnings.length} warning(s))`)}`);
  }

  console.log(`  ${summary}`);
  console.log('');

  for (const r of allResults) {
    const prefix = r.severity === 'error' ? fmt.error('ERROR') : fmt.warn('WARN ');
    console.log(`  ${prefix} [${r.error_type}] ${r.file}: ${r.message}`);
  }

  process.exit(errors.length > 0 ? 1 : 0);
}

main();
