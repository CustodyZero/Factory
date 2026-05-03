/**
 * Factory — Pipeline / Orchestrator / Resolution (pure logic)
 *
 * Phase 5 / 5.7 (post-checkpoint decomposition). The pre-execution
 * resolution gates that the orchestrator runs BEFORE invoking any
 * agent: arg-to-spec resolution, cycle detection, and missing-target
 * dependency detection.
 *
 * This module is pure — no filesystem writes, no event emission, no
 * config dependencies. `_resolveAll` reads the artifact tree via
 * `resolveRunArg` (the same I/O-bound helper the orchestrator used
 * inline before the split); the cycle and missing-dep helpers are
 * pure functions over the resolved set.
 *
 * The underscore-prefixed exports are exported for testing —
 * `tools/test/orchestrator.test.ts` pins their behavior independently
 * of the public driver. Renaming or removing an underscore-prefixed
 * export still requires a matching test update; they are NOT private
 * to this module.
 */

import { resolveRunArg } from '../resolve_arg.js';

// ---------------------------------------------------------------------------
// Resolution: each CLI arg -> ResolvedSpec node for the topo graph
// ---------------------------------------------------------------------------

export interface ResolvedSpec {
  readonly id: string;
  /** depends_on as declared in the spec (always [] for legacy intent inputs). */
  readonly dependsOn: ReadonlyArray<string>;
  readonly intentPath: string;
  readonly source: 'spec' | 'intent';
}

export interface ResolveAllOk {
  readonly ok: true;
  readonly resolved: ReadonlyArray<ResolvedSpec>;
}

export interface ResolveAllError {
  readonly ok: false;
  readonly error: string;
}

/**
 * Resolve every CLI arg via `resolveRunArg`, deduping repeated args by
 * id. Bails on the first resolution error. Results are returned in the
 * order each unique id first appeared in `args` (the topo sort below
 * is order-independent, but we want a stable trace).
 *
 * Exported for testing.
 */
export function _resolveAll(
  args: ReadonlyArray<string>,
  artifactRoot: string,
  projectRoot: string,
): ResolveAllOk | ResolveAllError {
  if (args.length === 0) {
    return { ok: false, error: 'No spec or intent ids supplied' };
  }
  const seen = new Set<string>();
  const out: ResolvedSpec[] = [];
  for (const arg of args) {
    if (seen.has(arg)) continue;
    seen.add(arg);
    const r = resolveRunArg(arg, artifactRoot, projectRoot);
    if (!r.ok) {
      return { ok: false, error: r.error };
    }
    out.push({
      id: arg,
      dependsOn: r.dependsOn ?? [],
      intentPath: r.intentPath,
      source: r.source,
    });
  }
  return { ok: true, resolved: out };
}

// ---------------------------------------------------------------------------
// Cycle detection — runs BEFORE any agent invocation.
//
// Pattern adapted from the validateSpecCycles helper in
// pipeline/integrity.ts. The integrity layer reports cycles for spec-
// validation purposes; here we need a yes/no answer that lets the
// orchestrator bail before doing any work.
// ---------------------------------------------------------------------------

export interface CycleReport {
  readonly cycles: ReadonlyArray<ReadonlyArray<string>>;
}

/** Exported for testing — pin cycle-detection behavior independently of runOrchestrator. */
export function _detectCycles(
  resolved: ReadonlyArray<ResolvedSpec>,
): CycleReport {
  const graph = new Map<string, ReadonlyArray<string>>();
  for (const s of resolved) graph.set(s.id, s.dependsOn);

  const visited = new Set<string>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const reported = new Set<string>();

  function dfs(node: string): void {
    visited.add(node);
    onStack.add(node);
    stack.push(node);
    for (const dep of graph.get(node) ?? []) {
      if (!graph.has(dep)) continue; // missing target — handled elsewhere
      if (!visited.has(dep)) {
        dfs(dep);
      } else if (onStack.has(dep)) {
        // Back-edge: dep is somewhere on the current DFS stack.
        const cycleStart = stack.indexOf(dep);
        const cycleMembers = stack.slice(cycleStart);
        // Self-loop: stack has [..., dep]; cycleStart finds dep, members = [dep].
        // We still report this as a cycle.
        const cycleKey = cycleMembers.slice().sort().join('|');
        if (!reported.has(cycleKey)) {
          reported.add(cycleKey);
          cycles.push([...cycleMembers, dep]);
        }
      }
    }
    onStack.delete(node);
    stack.pop();
  }

  for (const id of graph.keys()) {
    if (!visited.has(id)) dfs(id);
  }

  return { cycles };
}

/**
 * Render a cycle as `a -> b -> c -> a` for operator-facing error
 * messages. Used by the driver when bailing on cyclic input.
 */
export function formatCycle(cycle: ReadonlyArray<string>): string {
  return cycle.join(' -> ');
}

// ---------------------------------------------------------------------------
// Missing transitive dependency detection
// ---------------------------------------------------------------------------

export interface MissingDep {
  readonly specId: string;
  readonly missingId: string;
}

/** Exported for testing — pin missing-dep detection independently of runOrchestrator. */
export function _findMissingDeps(
  resolved: ReadonlyArray<ResolvedSpec>,
): ReadonlyArray<MissingDep> {
  const ids = new Set(resolved.map((s) => s.id));
  const missing: MissingDep[] = [];
  for (const s of resolved) {
    for (const dep of s.dependsOn) {
      if (!ids.has(dep)) missing.push({ specId: s.id, missingId: dep });
    }
  }
  return missing;
}
