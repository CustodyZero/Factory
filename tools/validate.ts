#!/usr/bin/env tsx
/**
 * Factory — Validation Script
 *
 * Structural and semantic validation of factory artifacts.
 *
 * Validation layers:
 *   1. Schema validation — required fields, types, patterns
 *   2. Referential integrity — cross-references between artifacts
 *   3. Invariant enforcement — FI-1, FI-4, FI-7, FI-8, FI-9
 *
 * Exit codes:
 *   0 — all validations pass
 *   1 — errors found
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { findProjectRoot, resolveArtifactRoot } from './config.js';
import { resolveSpecPath } from './plan.js';
import { parseSpec, SpecParseError } from './pipeline/spec_parse.js';
import type { ParsedSpec } from './pipeline/spec_parse.js';
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
    const validStatuses = ['draft', 'ready', 'implementing', 'review_requested', 'changes_requested', 'review_approved', 'completed', 'abandoned', 'deferred'];
    if (typeof data['status'] !== 'string' || !validStatuses.includes(data['status'])) {
      e(`'status' must be null or one of: ${validStatuses.join(', ')}`);
    }
    const reviewStates = ['review_requested', 'changes_requested', 'review_approved'];
    if (reviewStates.includes(data['status'] as string) && data['kind'] !== 'dev') {
      e(`Review status '${data['status']}' is only valid for dev packets`);
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
// Spec validation (Phase 4 of single-entry-pipeline)
// ---------------------------------------------------------------------------

/**
 * One entry per `.md` file under `specs/` at the project root.
 * `parsed` is null when the parser threw; the error is captured separately
 * so cycle detection and other downstream checks can still run on the
 * specs that DID parse.
 */
interface DiscoveredSpec {
  readonly filename: string;     // e.g. 'foo.md'
  readonly stem: string;         // e.g. 'foo'
  readonly filepath: string;     // e.g. 'specs/foo.md' (relative for reporting)
  readonly parsed: ParsedSpec | null;
}

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

/**
 * Detect cycles in the spec dependency graph.
 *
 * Specs that failed to parse are skipped (their errors were already
 * reported by validateSpecFile). Each cycle is reported once: we walk
 * the graph from each unvisited node, and on detecting a back-edge we
 * record the cycle members.
 */
function validateSpecCycles(specs: DiscoveredSpec[]): ValidationResult[] {
  const results: ValidationResult[] = [];
  const graph = new Map<string, ReadonlyArray<string>>();
  const fileById = new Map<string, string>();
  for (const s of specs) {
    if (s.parsed === null) continue;
    graph.set(s.parsed.frontmatter.id, s.parsed.frontmatter.depends_on ?? []);
    fileById.set(s.parsed.frontmatter.id, s.filepath);
  }

  // Detect missing-target dependencies as a separate (referential) error.
  for (const [id, deps] of graph) {
    for (const dep of deps) {
      if (!graph.has(dep)) {
        results.push({
          file: fileById.get(id) ?? `specs/${id}.md`,
          severity: 'error',
          error_type: 'referential',
          message: `Spec '${id}' depends_on '${dep}' but no spec with that id exists`,
        });
      }
    }
  }

  // Tarjan-style DFS for cycle detection. Reports each strongly-connected
  // member the first time we find a back-edge that includes it.
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const reported = new Set<string>();

  function dfs(node: string): void {
    visited.add(node);
    onStack.add(node);
    stack.push(node);
    for (const dep of graph.get(node) ?? []) {
      if (!graph.has(dep)) continue; // missing target, already reported
      if (!visited.has(dep)) {
        dfs(dep);
      } else if (onStack.has(dep)) {
        const cycleStart = stack.indexOf(dep);
        const cycleMembers = stack.slice(cycleStart);
        const cycleStr = [...cycleMembers, dep].join(' -> ');
        for (const m of cycleMembers) {
          if (reported.has(m)) continue;
          reported.add(m);
          results.push({
            file: fileById.get(m) ?? `specs/${m}.md`,
            severity: 'error',
            error_type: 'invariant',
            message: `Cyclic spec dependency: ${cycleStr}`,
          });
        }
      }
    }
    onStack.delete(node);
    stack.pop();
  }

  for (const id of graph.keys()) {
    if (!visited.has(id)) dfs(id);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Referential integrity + invariants
// ---------------------------------------------------------------------------

interface ArtifactIndex {
  packetIds: Set<string>;
  completionPacketIds: Set<string>;
  packets: Array<{ id: string; kind: string; verifies: string | null; dependencies: string[]; started_at: string | null; status: string | null; feature_id: string | null }>;
  completions: Array<{ packet_id: string; completed_by_id: string }>;
  features: Array<{ id: string; status: string; packets: string[] }>;
  intents: Array<{ id: string; status: string; feature_id: string | null }>;
}

function buildIndex(
  packets: Array<{ data: unknown }>,
  completions: Array<{ data: unknown }>,
  features: Array<{ data: unknown }>,
  intents: Array<{ data: unknown }>,
): ArtifactIndex {
  const index: ArtifactIndex = {
    packetIds: new Set(),
    completionPacketIds: new Set(),
    packets: [],
    completions: [],
    features: [],
    intents: [],
  };

  for (const { data } of packets) {
    if (isObject(data) && typeof data['id'] === 'string') {
      index.packetIds.add(data['id']);
      index.packets.push({
        id: data['id'],
        kind: typeof data['kind'] === 'string' ? data['kind'] : 'dev',
        verifies: typeof data['verifies'] === 'string' ? data['verifies'] : null,
        dependencies: isStringArray(data['dependencies']) ? data['dependencies'] : [],
        started_at: typeof data['started_at'] === 'string' ? data['started_at'] : null,
        status: typeof data['status'] === 'string' ? data['status'] : null,
        feature_id: typeof data['feature_id'] === 'string' ? data['feature_id'] : null,
      });
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

  for (const { data } of features) {
    if (isObject(data) && typeof data['id'] === 'string') {
      index.features.push({
        id: data['id'],
        status: typeof data['status'] === 'string' ? data['status'] : '',
        packets: isStringArray(data['packets']) ? data['packets'] : [],
      });
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
      results.push({ file: `completions/${pid}.json`, severity: 'error', error_type: 'referential', message: `Orphaned completion: packet '${pid}' does not exist` });
    }
  }

  // Feature -> packet referential integrity
  for (const f of index.features) {
    for (const pid of f.packets) {
      if (!index.packetIds.has(pid)) {
        results.push({ file: `features/${f.id}.json`, severity: 'error', error_type: 'referential', message: `Feature '${f.id}' references packet '${pid}' which does not exist` });
      }
    }
  }

  // Packet -> feature integrity
  for (const p of index.packets) {
    if (p.feature_id === null) continue;
    const feature = index.features.find((f) => f.id === p.feature_id);
    if (feature === undefined) {
      results.push({ file: `packets/${p.id}.json`, severity: 'error', error_type: 'referential', message: `Packet '${p.id}' declares feature_id '${p.feature_id}' but that feature does not exist` });
    } else if (!feature.packets.includes(p.id)) {
      results.push({ file: `packets/${p.id}.json`, severity: 'error', error_type: 'referential', message: `Packet '${p.id}' declares feature_id '${p.feature_id}' but the feature does not list this packet` });
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
  for (const p of index.packets) {
    if (p.kind === 'qa' && p.verifies !== null) {
      if (!index.packetIds.has(p.verifies)) {
        results.push({ file: `packets/${p.id}.json`, severity: 'error', error_type: 'referential', message: `QA packet '${p.id}' verifies '${p.verifies}' which does not exist` });
      } else {
        const target = index.packets.find((t) => t.id === p.verifies);
        if (target !== undefined && target.kind !== 'dev') {
          results.push({ file: `packets/${p.id}.json`, severity: 'error', error_type: 'referential', message: `QA packet '${p.id}' verifies '${p.verifies}' which is not a dev packet` });
        }
      }
    }
  }

  // FI-1: No duplicate completions
  const completionCounts = new Map<string, number>();
  for (const c of index.completions) {
    completionCounts.set(c.packet_id, (completionCounts.get(c.packet_id) ?? 0) + 1);
  }
  for (const [pid, count] of completionCounts) {
    if (count > 1) {
      results.push({ file: `completions/${pid}.json`, severity: 'error', error_type: 'invariant', message: `FI-1 violation: ${count} completion records for packet '${pid}'` });
    }
  }

  // FI-7: QA completion identity must differ from dev completion identity
  const completionIdentityMap = new Map<string, string>();
  for (const c of index.completions) {
    completionIdentityMap.set(c.packet_id, c.completed_by_id);
  }
  for (const p of index.packets) {
    if (p.kind !== 'qa' || p.verifies === null) continue;
    const qaIdentity = completionIdentityMap.get(p.id);
    const devIdentity = completionIdentityMap.get(p.verifies);
    if (qaIdentity !== undefined && devIdentity !== undefined && qaIdentity === devIdentity) {
      results.push({ file: `completions/${p.id}.json`, severity: 'error', error_type: 'invariant', message: `FI-7 violation: QA packet '${p.id}' completed by '${qaIdentity}' — same identity as dev packet '${p.verifies}'` });
    }
  }

  // FI-8: Every dev packet in a feature must have a QA counterpart
  for (const f of index.features) {
    const featurePacketSet = new Set(f.packets);
    for (const pid of f.packets) {
      const packet = index.packets.find((p) => p.id === pid);
      if (packet === undefined || packet.kind !== 'dev') continue;
      if (packet.status === 'abandoned' || packet.status === 'deferred') continue;
      const hasQa = index.packets.some((p) => p.kind === 'qa' && p.verifies === pid && featurePacketSet.has(p.id));
      if (!hasQa) {
        results.push({ file: `features/${f.id}.json`, severity: 'error', error_type: 'invariant', message: `FI-8 violation: dev packet '${pid}' in feature '${f.id}' has no QA counterpart` });
      }
    }
  }

  // FI-9: No cyclic packet dependencies
  const depGraph = new Map<string, string[]>();
  for (const p of index.packets) depGraph.set(p.id, p.dependencies);

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
      results.push({ file: `packets/${p.id}.json`, severity: 'error', error_type: 'invariant', message: `FI-9 violation: packet '${p.id}' is part of a dependency cycle` });
      reportedCycles.add(p.id);
    }
  }

  // Feature completion consistency
  for (const f of index.features) {
    if (f.status === 'completed' || f.status === 'delivered') {
      for (const pid of f.packets) {
        if (!index.completionPacketIds.has(pid)) {
          const packet = index.packets.find((p) => p.id === pid);
          if (packet !== undefined && packet.status !== 'abandoned' && packet.status !== 'deferred') {
            results.push({ file: `features/${f.id}.json`, severity: 'error', error_type: 'invariant', message: `Feature '${f.id}' is '${f.status}' but packet '${pid}' has no completion` });
          }
        }
      }
    }
  }

  // Intent linkage
  for (const intent of index.intents) {
    if (intent.feature_id !== null) {
      const feature = index.features.find((f) => f.id === intent.feature_id);
      if (feature === undefined) {
        results.push({ file: `intents/${intent.id}.json`, severity: 'error', error_type: 'referential', message: `Intent '${intent.id}' references feature '${intent.feature_id}' which does not exist` });
      }
    }
  }

  return results;
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

  // Schema validation
  for (const p of packets) { if (p.data != null) allResults.push(...validatePacketSchema(p.filepath, p.data)); }
  for (const c of completions) { if (c.data != null) allResults.push(...validateCompletionSchema(c.filepath, c.data)); }
  for (const f of features) { if (f.data != null) allResults.push(...validateFeatureSchema(f.filepath, f.data)); }
  for (const i of intents) { if (i.data != null) allResults.push(...validateIntentSchema(i.filepath, i.data)); }
  for (const s of specs) { allResults.push(...validateSpecFile(s)); }

  // Integrity + invariants
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
