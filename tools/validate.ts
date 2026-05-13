#!/usr/bin/env tsx
/**
 * Factory — Validation Script
 *
 * Structural and semantic validation of factory artifacts.
 *
 * Validation layers:
 *   1. Schema validation — required fields, types, patterns (this file)
 *   2. Cross-artifact integrity (delegated to ./pipeline/integrity.ts):
 *      - Referential integrity between artifacts
 *      - Invariants FI-1, FI-7, FI-8, FI-9
 *      - Spec dependency cycles
 *
 * Exit codes:
 *   0 — all validations pass
 *   1 — errors found
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { findProjectRoot, loadConfig, resolveArtifactRoot, resolveCacheRoot, resolveMemoryRoot } from './config.js';
import { resolveSpecPath } from './plan.js';
import { parseSpec, SpecParseError } from './pipeline/spec_parse.js';
import type { ParsedSpec } from './pipeline/spec_parse.js';
import {
  buildIndex,
  validateIntegrity,
  validateSpecCycles,
  type DiscoveredSpec,
  type ValidationResult,
} from './pipeline/integrity.js';
import * as fmt from './output.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = findProjectRoot();
const CONFIG = loadConfig(PROJECT_ROOT);
const ARTIFACT_ROOT = resolveArtifactRoot(PROJECT_ROOT);
const VALID_CHANGE_CLASSES = ['trivial', 'local', 'cross_cutting', 'architectural'] as const;
const VALID_IDENTITY_KINDS = ['human', 'agent', 'cli', 'ui'] as const;
const VALID_FEATURE_STATUSES = ['planned', 'executing', 'completed', 'delivered'] as const;
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
    } catch {
      results.push({ filename: file, filepath: `${subdir}/${file}`, data: null, raw: '' });
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
  return !isNaN(new Date(s).getTime());
}

function isValidIdentity(v: unknown, allowedKinds: ReadonlyArray<string>): { valid: boolean; reason?: string } {
  if (!isObject(v)) return { valid: false, reason: 'identity must be an object' };
  if (typeof v['kind'] !== 'string') return { valid: false, reason: 'identity.kind must be a string' };
  if (!allowedKinds.includes(v['kind'])) return { valid: false, reason: `identity.kind '${v['kind']}' not in [${allowedKinds.join(', ')}]` };
  if (typeof v['id'] !== 'string' || v['id'].length === 0) return { valid: false, reason: 'identity.id must be a non-empty string' };
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

function validatePacketSchema(filepath: string, data: unknown): ValidationResult[] {
  const results: ValidationResult[] = [];
  const e = (msg: string) => results.push({ file: filepath, severity: 'error', error_type: 'schema', message: msg });

  if (!isObject(data)) { e('packet must be a JSON object'); return results; }

  if (typeof data['id'] !== 'string' || !KEBAB_CASE_RE.test(data['id'])) e("'id' must be a kebab-case string");
  const expectedFilename = `${data['id']}.json`;
  if (basename(filepath) !== expectedFilename && typeof data['id'] === 'string') {
    e(`filename must match id: expected '${expectedFilename}', got '${basename(filepath)}'`);
  }

  if (typeof data['title'] !== 'string' || data['title'].length === 0) e("'title' is required");
  if (typeof data['intent'] !== 'string' || data['intent'].length === 0) e("'intent' is required");

  if (typeof data['change_class'] === 'string' && !(VALID_CHANGE_CLASSES as readonly string[]).includes(data['change_class'])) {
    e(`'change_class' must be one of: ${VALID_CHANGE_CLASSES.join(', ')}`);
  }

  if (!isObject(data['scope'])) {
    e("'scope' must be an object");
  } else if (!isStringArray(data['scope']['packages'])) {
    e("'scope.packages' must be an array of strings");
  }

  if (typeof data['owner'] !== 'string' || data['owner'].length === 0) e("'owner' is required");
  if (!isValidISO8601(data['created_at'])) e("'created_at' must be a valid ISO 8601 timestamp");

  if (data['started_at'] != null && !isValidISO8601(data['started_at'])) {
    e("'started_at' must be a valid ISO 8601 timestamp or null");
  }
  if (data['dependencies'] != null && !isStringArray(data['dependencies'])) {
    e("'dependencies' must be an array of strings");
  }

  if (data['status'] != null && data['status'] !== null) {
    // 'failed' is a terminal status set by the recovery layer when a packet
    // escalates. It is mutually exclusive with 'completed' (a failed packet
    // has NO completion record). Keep this list in sync with packet.schema.json
    // §status.enum — both artifacts encode the same closed contract.
    const validStatuses = ['draft', 'ready', 'implementing', 'review_requested', 'changes_requested', 'review_approved', 'completed', 'failed', 'abandoned', 'deferred'];
    if (typeof data['status'] !== 'string' || !validStatuses.includes(data['status'])) {
      e(`'status' must be null or one of: ${validStatuses.join(', ')}`);
    }
    const reviewStates = ['review_requested', 'changes_requested', 'review_approved'];
    if (reviewStates.includes(data['status'] as string) && data['kind'] !== 'dev') {
      e(`Review status '${data['status']}' is only valid for dev packets`);
    }
  }

  // Optional `failure` object — stamped onto the packet by the recovery layer
  // when a packet escalates (develop_phase.ts / verify_phase.ts) or when a QA
  // packet cascades from a failed dev dependency. Required fields are
  // 'scenario' and 'reason'; 'attempts' and 'escalation_path' are written by
  // the code but are not strictly required (cascade writes attempts: 0,
  // escalation_path: null and that is honest). Keep in sync with the
  // `failure` property in packet.schema.json.
  if (data['failure'] != null) {
    if (!isObject(data['failure'])) {
      e("'failure' must be an object");
    } else {
      const f = data['failure'];
      if (typeof f['scenario'] !== 'string' || f['scenario'].length === 0) {
        e("'failure.scenario' must be a non-empty string");
      }
      if (typeof f['reason'] !== 'string' || f['reason'].length === 0) {
        e("'failure.reason' must be a non-empty string");
      }
      if (f['attempts'] != null && (typeof f['attempts'] !== 'number' || !Number.isInteger(f['attempts']) || f['attempts'] < 0)) {
        e("'failure.attempts' must be a non-negative integer when present");
      }
      if (f['escalation_path'] != null && typeof f['escalation_path'] !== 'string') {
        e("'failure.escalation_path' must be a string or null when present");
      }
    }
  }

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

  if (!Array.isArray(data['acceptance_criteria']) || data['acceptance_criteria'].length === 0) {
    e("'acceptance_criteria' must be a non-empty array of strings");
  } else if (!data['acceptance_criteria'].every((c: unknown) => typeof c === 'string' && c.length > 0)) {
    e("each acceptance criterion must be a non-empty string");
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

  if (typeof data['summary'] !== 'string' || data['summary'].length === 0) e("'summary' is required");

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

function validateFeatureSchema(filepath: string, data: unknown): ValidationResult[] {
  const results: ValidationResult[] = [];
  const e = (msg: string) => results.push({ file: filepath, severity: 'error', error_type: 'schema', message: msg });

  if (!isObject(data)) { e('feature must be a JSON object'); return results; }

  if (typeof data['id'] !== 'string' || !KEBAB_CASE_RE.test(data['id'])) e("'id' must be a kebab-case string");
  const expectedFilename = `${data['id']}.json`;
  if (basename(filepath) !== expectedFilename && typeof data['id'] === 'string') {
    e(`filename must match id: expected '${expectedFilename}', got '${basename(filepath)}'`);
  }

  if (typeof data['intent'] !== 'string' || data['intent'].length === 0) e("'intent' is required");

  if (!Array.isArray(data['acceptance_criteria']) || data['acceptance_criteria'].length === 0) {
    e("'acceptance_criteria' must be a non-empty array");
  }

  if (typeof data['status'] !== 'string' || !(VALID_FEATURE_STATUSES as readonly string[]).includes(data['status'])) {
    e(`'status' must be one of: ${VALID_FEATURE_STATUSES.join(', ')}`);
  }

  if (!isStringArray(data['packets'])) e("'packets' must be an array of strings");

  const createdByCheck = isValidIdentity(data['created_by'], VALID_IDENTITY_KINDS as unknown as string[]);
  if (!createdByCheck.valid) e(`'created_by': ${createdByCheck.reason}`);

  return results;
}

function validateIntentSchema(filepath: string, data: unknown): ValidationResult[] {
  const results: ValidationResult[] = [];
  const e = (msg: string) => results.push({ file: filepath, severity: 'error', error_type: 'schema', message: msg });

  if (!isObject(data)) { e('intent must be a JSON object'); return results; }

  if (typeof data['id'] !== 'string' || !KEBAB_CASE_RE.test(data['id'])) e("'id' must be a kebab-case string");
  const expectedFilename = `${data['id']}.json`;
  if (basename(filepath) !== expectedFilename && typeof data['id'] === 'string') {
    e(`filename must match id: expected '${expectedFilename}', got '${basename(filepath)}'`);
  }

  if (typeof data['title'] !== 'string' || data['title'].length === 0) e("'title' is required");

  const hasInlineSpec = typeof data['spec'] === 'string' && (data['spec'] as string).length > 0;
  const hasSpecPath = typeof data['spec_path'] === 'string' && (data['spec_path'] as string).length > 0;
  if (hasInlineSpec && hasSpecPath) {
    e("'spec' and 'spec_path' are mutually exclusive");
  } else if (!hasInlineSpec && !hasSpecPath) {
    e("either 'spec' or 'spec_path' is required");
  } else if (hasSpecPath) {
    const specPath = data['spec_path'] as string;
    const resolved = resolveSpecPath(PROJECT_ROOT, specPath);
    if (!resolved.ok) {
      e(resolved.error);
    } else if (!existsSync(resolved.absolutePath)) {
      e(`'spec_path' points to a file that does not exist: '${specPath}'`);
    }
  }

  const validIntentStatuses = ['proposed', 'approved', 'planned', 'superseded', 'delivered'];
  if (typeof data['status'] !== 'string' || !validIntentStatuses.includes(data['status'])) {
    e(`'status' must be one of: ${validIntentStatuses.join(', ')}`);
  }

  if (data['constraints'] != null && !isStringArray(data['constraints'])) {
    e("'constraints' must be an array of strings");
  }

  // depends_on (Phase 4 of single-entry-pipeline): additive optional field
  // copied through from the source spec's frontmatter. Default empty.
  if (data['depends_on'] != null) {
    if (!isStringArray(data['depends_on'])) {
      e("'depends_on' must be an array of strings");
    } else {
      for (const dep of data['depends_on']) {
        if (!KEBAB_CASE_RE.test(dep)) {
          e(`'depends_on' entry '${dep}' is not a kebab-case id`);
        }
      }
    }
  }

  const createdByCheck = isValidIdentity(data['created_by'], VALID_IDENTITY_KINDS as unknown as string[]);
  if (!createdByCheck.valid) e(`'created_by': ${createdByCheck.reason}`);

  if (!isValidISO8601(data['created_at'])) e("'created_at' must be a valid ISO 8601 timestamp");

  if (data['approved_at'] != null && data['approved_at'] !== null && !isValidISO8601(data['approved_at'])) {
    e("'approved_at' must be a valid ISO 8601 timestamp or null");
  }

  return results;
}

// ---------------------------------------------------------------------------
// Spec discovery + per-file validation (Phase 4 of single-entry-pipeline)
// ---------------------------------------------------------------------------

function readSpecFiles(): DiscoveredSpec[] {
  const dir = join(PROJECT_ROOT, 'specs');
  if (!existsSync(dir)) return [];
  // Only look at .md files at the top level. Subdirectories are not
  // factory specs (the spec_artifact_model decision pins the location
  // as specs/<id>.md, not specs/<group>/<id>.md).
  const entries = readdirSync(dir).filter((f) => {
    if (!f.endsWith('.md')) return false;
    try {
      return statSync(join(dir, f)).isFile();
    } catch {
      return false;
    }
  }).sort();
  const out: DiscoveredSpec[] = [];
  for (const filename of entries) {
    const filepath = `specs/${filename}`;
    const stem = filename.slice(0, -3);
    let parsed: ParsedSpec | null = null;
    try {
      parsed = parseSpec(readFileSync(join(dir, filename), 'utf-8'));
    } catch {
      // Captured; the per-spec validator below will re-run parseSpec
      // and surface the SpecParseError message verbatim.
      parsed = null;
    }
    out.push({ filename, stem, filepath, parsed });
  }
  return out;
}

function validateSpecFile(s: DiscoveredSpec): ValidationResult[] {
  const results: ValidationResult[] = [];
  const e = (msg: string) => results.push({
    file: s.filepath,
    severity: 'error',
    error_type: 'schema',
    message: msg,
  });

  // Re-parse so the parser's error message reaches the user as-is.
  let parsed: ParsedSpec;
  try {
    parsed = parseSpec(readFileSync(join(PROJECT_ROOT, s.filepath), 'utf-8'));
  } catch (err) {
    if (err instanceof SpecParseError) {
      e(err.message);
    } else {
      e(`Failed to read spec: ${err instanceof Error ? err.message : String(err)}`);
    }
    return results;
  }

  if (!KEBAB_CASE_RE.test(parsed.frontmatter.id)) {
    e(`'id' must be a kebab-case string: '${parsed.frontmatter.id}'`);
  }
  if (parsed.frontmatter.id !== s.stem) {
    e(`filename must match id: file is '${s.filename}' but id is '${parsed.frontmatter.id}'`);
  }
  if (parsed.frontmatter.depends_on !== undefined) {
    for (const dep of parsed.frontmatter.depends_on) {
      if (!KEBAB_CASE_RE.test(dep)) {
        e(`'depends_on' entry '${dep}' is not a kebab-case id`);
      }
    }
  }
  return results;
}

function validateMemoryLayout(): ValidationResult[] {
  const results: ValidationResult[] = [];
  const memoryRoot = resolveMemoryRoot(PROJECT_ROOT, CONFIG);
  const cacheRoot = resolveCacheRoot(PROJECT_ROOT, CONFIG);
  const memoryPath = relativePath(memoryRoot);
  const cachePath = relativePath(cacheRoot);
  const w = (file: string, msg: string) => results.push({ file, severity: 'warning', error_type: 'schema', message: msg });

  if (!existsSync(memoryRoot)) {
    w(memoryPath, 'memory root does not exist yet (setup creates it for host projects)');
    return results;
  }
  const indexPath = join(memoryRoot, 'MEMORY.md');
  if (!existsSync(indexPath)) {
    w(`${memoryPath}/MEMORY.md`, 'missing host-project memory index');
  }
  for (const category of ['architectural-facts', 'recurring-failures', 'project-conventions', 'code-patterns', CONFIG.memory.suggestion_dir]) {
    const dir = join(memoryRoot, category);
    if (!existsSync(dir)) {
      w(`${memoryPath}/${category}`, 'recommended memory category directory missing');
    }
  }
  if (existsSync(cacheRoot) && !statSync(cacheRoot).isDirectory()) {
    w(cachePath, 'cache path exists but is not a directory');
  }
  return results;
}

function relativePath(path: string): string {
  const rel = join('.', path.replace(`${PROJECT_ROOT}/`, ''));
  return rel.startsWith('./') ? rel.slice(2) : rel;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const allResults: ValidationResult[] = [];

  const packets = readJsonFiles('packets');
  const completions = readJsonFiles('completions');
  const features = readJsonFiles('features');
  const intents = readJsonFiles('intents');
  const specs = readSpecFiles();

  // Parse failures
  for (const collection of [
    { name: 'packets', items: packets },
    { name: 'completions', items: completions },
    { name: 'features', items: features },
    { name: 'intents', items: intents },
  ]) {
    for (const item of collection.items) {
      if (item.data === null) {
        allResults.push({ file: item.filepath, severity: 'error', error_type: 'schema', message: 'Failed to parse JSON' });
      }
    }
  }

  // Per-artifact schema validation
  for (const p of packets) { if (p.data != null) allResults.push(...validatePacketSchema(p.filepath, p.data)); }
  for (const c of completions) { if (c.data != null) allResults.push(...validateCompletionSchema(c.filepath, c.data)); }
  for (const f of features) { if (f.data != null) allResults.push(...validateFeatureSchema(f.filepath, f.data)); }
  for (const i of intents) { if (i.data != null) allResults.push(...validateIntentSchema(i.filepath, i.data)); }
  for (const s of specs) { allResults.push(...validateSpecFile(s)); }
  allResults.push(...validateMemoryLayout());

  // Cross-artifact integrity + invariants (delegated to integrity module)
  const index = buildIndex(packets, completions, features, intents);
  allResults.push(...validateIntegrity(index));
  allResults.push(...validateSpecCycles(specs));

  // Report
  const errors = allResults.filter((r) => r.severity === 'error');
  const warnings = allResults.filter((r) => r.severity === 'warning');
  const summary = `${packets.length} packets, ${completions.length} completions, ${features.length} features, ${intents.length} intents, ${specs.length} specs`;

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
