/**
 * Tests for topoSort — the generic dependency-aware ordering primitive
 * used by the pipeline.
 *
 * The contract being tested mirrors the behavior of the original
 * packet-only `topoSort` in `tools/run.ts` exactly:
 *   - Empty input returns empty.
 *   - Linear deps order from leaves first.
 *   - Diamond deps converge correctly.
 *   - Cycles do not crash or infinite-loop (no rejection in this phase).
 *   - Deps pointing outside the input set are silently ignored.
 */

import { describe, it, expect } from 'vitest';
import { topoSort } from '../pipeline/topo.js';

interface Node {
  readonly id: string;
  readonly deps: ReadonlyArray<string>;
}

const getId = (n: Node) => n.id;
const getDeps = (n: Node) => n.deps;
const ids = (ns: ReadonlyArray<Node>) => ns.map(getId);

describe('topoSort', () => {
  it('returns empty array for empty input', () => {
    expect(topoSort<Node>([], getId, getDeps)).toEqual([]);
  });

  it('returns single node unchanged', () => {
    const a: Node = { id: 'a', deps: [] };
    expect(ids(topoSort([a], getId, getDeps))).toEqual(['a']);
  });

  it('orders linear chain dependencies first (leaves before dependents)', () => {
    // c depends on b, b depends on a -> a, b, c regardless of input order
    const a: Node = { id: 'a', deps: [] };
    const b: Node = { id: 'b', deps: ['a'] };
    const c: Node = { id: 'c', deps: ['b'] };
    expect(ids(topoSort([c, b, a], getId, getDeps))).toEqual(['a', 'b', 'c']);
  });

  it('resolves diamond dependencies with each node after its prerequisites', () => {
    // d depends on b and c; b and c each depend on a.
    const a: Node = { id: 'a', deps: [] };
    const b: Node = { id: 'b', deps: ['a'] };
    const c: Node = { id: 'c', deps: ['a'] };
    const d: Node = { id: 'd', deps: ['b', 'c'] };
    const out = ids(topoSort([d, c, b, a], getId, getDeps));
    expect(out.indexOf('a')).toBeLessThan(out.indexOf('b'));
    expect(out.indexOf('a')).toBeLessThan(out.indexOf('c'));
    expect(out.indexOf('b')).toBeLessThan(out.indexOf('d'));
    expect(out.indexOf('c')).toBeLessThan(out.indexOf('d'));
    expect(out).toHaveLength(4);
  });

  it('does not crash or infinite-loop on a cycle', () => {
    // a -> b -> a is a 2-cycle. The original implementation marks
    // visited eagerly so the back-edge becomes a no-op. Result still
    // contains both nodes; neither is dropped.
    const a: Node = { id: 'a', deps: ['b'] };
    const b: Node = { id: 'b', deps: ['a'] };
    const out = topoSort([a, b], getId, getDeps);
    expect(out).toHaveLength(2);
    const out2 = ids(out).slice().sort();
    expect(out2).toEqual(['a', 'b']);
  });

  it('does not crash on a self-loop', () => {
    const a: Node = { id: 'a', deps: ['a'] };
    expect(ids(topoSort([a], getId, getDeps))).toEqual(['a']);
  });

  it('places nodes whose deps are outside the input set after their entry order', () => {
    // 'a' depends on 'external' which is not in the input; the
    // unknown dep is silently skipped. 'b' has no deps. The original
    // contract emits results in the order the outer loop reaches
    // each node, which is input order: a, b.
    const a: Node = { id: 'a', deps: ['external'] };
    const b: Node = { id: 'b', deps: [] };
    expect(ids(topoSort([a, b], getId, getDeps))).toEqual(['a', 'b']);
  });

  it('is generic — works on a different shape of node', () => {
    interface Spec { readonly name: string; readonly needs: ReadonlyArray<string> }
    const x: Spec = { name: 'x', needs: [] };
    const y: Spec = { name: 'y', needs: ['x'] };
    const out = topoSort<Spec>([y, x], (s) => s.name, (s) => s.needs);
    expect(out.map((s) => s.name)).toEqual(['x', 'y']);
  });

  it('handles missing deps array via getDeps that returns empty', () => {
    interface PacketLike { readonly id: string; readonly dependencies?: ReadonlyArray<string> }
    const a: PacketLike = { id: 'a' };
    const b: PacketLike = { id: 'b', dependencies: ['a'] };
    const out = topoSort<PacketLike>(
      [b, a],
      (p) => p.id,
      (p) => p.dependencies ?? [],
    );
    expect(out.map((p) => p.id)).toEqual(['a', 'b']);
  });
});
