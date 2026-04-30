/**
 * Factory — Pipeline / Topological Sort
 *
 * Pure, generic topological sort used by the pipeline to order
 * packets (and, in later phases, specs) by their declared
 * dependencies.
 *
 * Behavioral contract (preserved verbatim from the original
 * `topoSort` in `tools/run.ts`, which only operated on packets):
 *
 *   - Output is a stable depth-first post-order: each node appears
 *     after the dependencies that are present in the input set.
 *   - Dependencies that point at IDs not present in the input set
 *     are silently ignored (the dependent node is then placed as
 *     soon as the visit reaches it, which in practice puts
 *     "external-dep" packets near the end of the order).
 *   - Cycles do not throw and do not infinite-loop. Because we
 *     mark a node visited the moment we enter it, a back-edge to
 *     an in-progress ancestor is a no-op and the cycle resolves.
 *     (Explicit cycle detection / rejection is a Phase 5 concern,
 *     not Phase 1.)
 *   - Unknown IDs (those returned by getDeps but absent from the
 *     input) are silently skipped — same as the original.
 *
 * The function is generic over node shape so the same primitive
 * can later sort spec graphs.
 */

export function topoSort<T>(
  nodes: ReadonlyArray<T>,
  getId: (node: T) => string,
  getDeps: (node: T) => ReadonlyArray<string>,
): T[] {
  const idSet = new Set(nodes.map(getId));
  const visited = new Set<string>();
  const result: T[] = [];
  const nodeMap = new Map<string, T>();
  for (const n of nodes) nodeMap.set(getId(n), n);

  function visit(id: string): void {
    if (visited.has(id)) return;
    visited.add(id);
    const node = nodeMap.get(id);
    if (node === undefined) return;
    for (const dep of getDeps(node)) {
      if (idSet.has(dep)) visit(dep);
    }
    result.push(node);
  }

  for (const n of nodes) visit(getId(n));
  return result;
}
