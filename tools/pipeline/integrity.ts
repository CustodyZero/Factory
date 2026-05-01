/**
 * Factory — Cross-cutting integrity validations.
 *
 * This module owns the RELATIONAL validations that operate across multiple
 * artifacts. Per-artifact schema validation lives in `tools/validate.ts`.
 *
 * The split is by surface area, not by mechanism:
 *
 *   - validate.ts: "is this single artifact well-formed?"
 *   - integrity.ts: "do these artifacts agree with each other?"
 *
 * Checks owned here:
 *   - Orphaned completions
 *   - Feature ↔ packet referential integrity
 *   - Packet → feature back-reference consistency
 *   - Intent → feature linkage status rules
 *   - QA packet structural checks (verifies-target exists and is a dev packet)
 *   - FI-1: unique completion per packet
 *   - FI-7: QA completion identity differs from dev completion identity
 *   - FI-8: every dev packet has a QA counterpart
 *   - FI-9: no cyclic packet dependencies
 *   - Feature completion consistency (status ⇒ all packets completed)
 *   - Intent linkage (feature_id resolves)
 *   - Spec dependency cycles + missing-target deps
 *
 * No I/O. The caller is responsible for loading artifacts and projecting
 * them into the typed snapshots this module operates on.
 */
import type { ParsedSpec } from './spec_parse.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Severity = 'error' | 'warning';

export interface ValidationResult {
  readonly file: string;
  readonly severity: Severity;
  readonly error_type: string;
  readonly message: string;
}

export interface PacketSnapshot {
  readonly id: string;
  readonly kind: string;
  readonly verifies: string | null;
  readonly dependencies: ReadonlyArray<string>;
  readonly started_at: string | null;
  readonly status: string | null;
  readonly feature_id: string | null;
}

export interface CompletionSnapshot {
  readonly packet_id: string;
  readonly completed_by_id: string;
}

export interface FeatureSnapshot {
  readonly id: string;
  readonly status: string;
  readonly packets: ReadonlyArray<string>;
}

export interface IntentSnapshot {
  readonly id: string;
  readonly status: string;
  readonly feature_id: string | null;
}

export interface ArtifactIndex {
  readonly packetIds: ReadonlySet<string>;
  readonly completionPacketIds: ReadonlySet<string>;
  readonly packets: ReadonlyArray<PacketSnapshot>;
  readonly completions: ReadonlyArray<CompletionSnapshot>;
  readonly features: ReadonlyArray<FeatureSnapshot>;
  readonly intents: ReadonlyArray<IntentSnapshot>;
}

/**
 * One entry per `.md` file under `specs/` at the project root.
 * `parsed` is null when the parser threw; the caller is responsible for
 * surfacing per-spec parse errors elsewhere (validate.ts does this in
 * validateSpecFile). Cycle detection skips unparsed specs.
 */
export interface DiscoveredSpec {
  readonly filename: string;     // e.g. 'foo.md'
  readonly stem: string;         // e.g. 'foo'
  readonly filepath: string;     // e.g. 'specs/foo.md' (relative for reporting)
  readonly parsed: ParsedSpec | null;
}

// ---------------------------------------------------------------------------
// Helpers (private)
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((item) => typeof item === 'string');
}

// ---------------------------------------------------------------------------
// Index construction
// ---------------------------------------------------------------------------

/**
 * Build the artifact snapshot from raw parsed JSON. This is intentionally
 * lenient: malformed entries are skipped, not rejected. Schema validation
 * is the layer above's job; this layer just needs typed projections to
 * reason over.
 */
export function buildIndex(
  packets: ReadonlyArray<{ data: unknown }>,
  completions: ReadonlyArray<{ data: unknown }>,
  features: ReadonlyArray<{ data: unknown }>,
  intents: ReadonlyArray<{ data: unknown }>,
): ArtifactIndex {
  const packetIds = new Set<string>();
  const completionPacketIds = new Set<string>();
  const packetSnapshots: PacketSnapshot[] = [];
  const completionSnapshots: CompletionSnapshot[] = [];
  const featureSnapshots: FeatureSnapshot[] = [];
  const intentSnapshots: IntentSnapshot[] = [];

  for (const { data } of packets) {
    if (isObject(data) && typeof data['id'] === 'string') {
      packetIds.add(data['id']);
      packetSnapshots.push({
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
      completionPacketIds.add(data['packet_id']);
      const by = isObject(data['completed_by']) ? data['completed_by'] : {};
      completionSnapshots.push({
        packet_id: data['packet_id'],
        completed_by_id: typeof by['id'] === 'string' ? by['id'] : '',
      });
    }
  }

  for (const { data } of features) {
    if (isObject(data) && typeof data['id'] === 'string') {
      featureSnapshots.push({
        id: data['id'],
        status: typeof data['status'] === 'string' ? data['status'] : '',
        packets: isStringArray(data['packets']) ? data['packets'] : [],
      });
    }
  }

  for (const { data } of intents) {
    if (isObject(data) && typeof data['id'] === 'string') {
      intentSnapshots.push({
        id: data['id'],
        status: typeof data['status'] === 'string' ? data['status'] : '',
        feature_id: typeof data['feature_id'] === 'string' ? data['feature_id'] : null,
      });
    }
  }

  return {
    packetIds,
    completionPacketIds,
    packets: packetSnapshots,
    completions: completionSnapshots,
    features: featureSnapshots,
    intents: intentSnapshots,
  };
}

// ---------------------------------------------------------------------------
// Cross-artifact integrity
// ---------------------------------------------------------------------------

/**
 * Run all cross-artifact integrity checks against the provided snapshot.
 * Order of returned results matches the original validate.ts emission order
 * to preserve CLI output exactly.
 */
export function validateIntegrity(index: ArtifactIndex): ValidationResult[] {
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

  // Intent linkage status rules
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
  const depGraph = new Map<string, ReadonlyArray<string>>();
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

  // Intent linkage (feature_id resolves)
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
// Spec dependency cycles + missing-target deps
// ---------------------------------------------------------------------------

const SPEC_KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Detect cycles in the spec dependency graph and report references to
 * specs that don't exist.
 *
 * Specs that failed to parse are skipped (their parse errors must be
 * surfaced by the caller separately). Each cycle member is reported once.
 */
export function validateSpecCycles(specs: ReadonlyArray<DiscoveredSpec>): ValidationResult[] {
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

  // DFS for cycle detection. Reports each member the first time we find a
  // back-edge that includes it.
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

// Re-export the kebab pattern in case future integrity checks need it.
// Currently unused outside tests; not part of the public surface.
export const SPEC_ID_PATTERN: RegExp = SPEC_KEBAB_RE;
