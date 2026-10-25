// Community detection for personal graphs (ADR 0012): Louvain modularity
// optimisation (Blondel, Guillaume, Lambiotte & Lefebvre 2008), deterministic,
// with each community split into its connected parts at the end. Louvain can
// leave a community internally disconnected (Traag, Waltman & van Eck 2019);
// splitting a community that has no edges between its parts always raises
// modularity, since Σtot² ≥ Σ parts' tot², so the split is safe.
//
// Graphs here are undirected and weighted, nodes 0..n-1. `adjacency[i]` lists
// [j, w] for every edge, both ways round; self-loops are not expected in the
// input (aggregation creates them internally).

import { valueAt } from './ml/linalg.ts';

export type Adjacency = ReadonlyArray<ReadonlyArray<readonly [number, number]>>;

const NO_NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [];
/** Row i's neighbours; one fallback here instead of one at every read. */
export const rowOf = (adjacency: Adjacency, i: number) => adjacency[i] ?? NO_NEIGHBOURS;

/** Q = (1/2m) Σ_c (Σin_c − Σtot_c² / 2m), resolution 1. 0 for a graph with no edges. */
export function modularity(adjacency: Adjacency, community: ArrayLike<number>): number {
  const n = adjacency.length;
  let twoM = 0;
  const inside = new Map<number, number>();
  const total = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const ci = valueAt(community, i);
    for (const [j, w] of rowOf(adjacency, i)) {
      twoM += w;
      total.set(ci, (total.get(ci) ?? 0) + w);
      if (valueAt(community, j) === ci) inside.set(ci, (inside.get(ci) ?? 0) + w);
    }
  }
  if (twoM === 0) return 0;
  let q = 0;
  for (const [c, t] of total) q += (inside.get(c) ?? 0) / twoM - (t / twoM) ** 2;
  return q;
}

/** One level of local moves. Returns each node's community (renumbered 0..k-1) and whether anything moved. */
function localMoves(
  adjacency: Adjacency,
  degree: Float64Array,
  twoM: number,
): { community: Int32Array; moved: boolean } {
  const n = adjacency.length;
  const community = Int32Array.from({ length: n }, (_, i) => i);
  const total = Float64Array.from(degree);
  const weightTo = new Float64Array(n);
  const touched: number[] = [];
  let moved = false;
  // Each pass visits nodes in index order (deterministic); stop once a pass moves nothing.
  for (let pass = 0; pass < 100; pass++) {
    let movedThisPass = false;
    for (let i = 0; i < n; i++) {
      const from = valueAt(community, i);
      const ki = valueAt(degree, i);
      for (const [j, w] of rowOf(adjacency, i)) {
        if (j === i) continue;
        const c = valueAt(community, j);
        if (weightTo[c] === 0) touched.push(c);
        weightTo[c] = valueAt(weightTo, c) + w;
      }
      total[from] = valueAt(total, from) - ki;
      // Gain of joining c, up to a positive factor: k_i,in(c) − Σtot(c) · k_i / 2m.
      const gain = (c: number) => valueAt(weightTo, c) - (valueAt(total, c) * ki) / twoM;
      let best = from;
      let bestGain = gain(from);
      for (const c of touched) {
        const g = gain(c);
        // A strictly better move only (1e-12 absorbs rounding), then the lower id: no flip-flopping.
        if (g > bestGain + 1e-12 || (Math.abs(g - bestGain) <= 1e-12 && c < best && best !== from)) {
          best = c;
          bestGain = g;
        }
      }
      total[best] = valueAt(total, best) + ki;
      if (best !== from) {
        community[i] = best;
        movedThisPass = true;
        moved = true;
      }
      for (const c of touched) weightTo[c] = 0;
      touched.length = 0;
    }
    if (!movedThisPass) break;
  }
  // Renumber in order of first appearance, so labels don't depend on which node a community grew from.
  const renumber = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const c = valueAt(community, i);
    let r = renumber.get(c);
    if (r === undefined) {
      r = renumber.size;
      renumber.set(c, r);
    }
    community[i] = r;
  }
  return { community, moved };
}

/** The graph of communities: edge weight between two is the sum between their members (self-loops inside). */
function aggregate(adjacency: Adjacency, community: Int32Array, k: number): Array<Array<[number, number]>> {
  const rows = Array.from({ length: k }, () => new Map<number, number>());
  adjacency.forEach((neighbors, i) => {
    const ci = valueAt(community, i);
    const row = rows[ci];
    if (!row) return;
    for (const [j, w] of neighbors) {
      const cj = valueAt(community, j);
      row.set(cj, (row.get(cj) ?? 0) + w);
    }
  });
  return rows.map(row => [...row].sort((a, b) => a[0] - b[0]));
}

/** Splits every community into its connected parts, using only edges inside it. */
export function connectedParts(adjacency: Adjacency, community: ArrayLike<number>): Int32Array {
  const n = adjacency.length;
  const out = new Int32Array(n).fill(-1);
  let next = 0;
  for (let start = 0; start < n; start++) {
    if (out[start] !== -1) continue;
    const c = community[start];
    out[start] = next;
    const stack = [start];
    for (let i = stack.pop(); i !== undefined; i = stack.pop()) {
      for (const [j] of rowOf(adjacency, i)) {
        if (out[j] === -1 && community[j] === c) {
          out[j] = next;
          stack.push(j);
        }
      }
    }
    next++;
  }
  return out;
}

/** Louvain communities, numbered 0..k-1 in order of each community's lowest node. */
export function louvain(adjacency: Adjacency): { community: Int32Array; levels: number; modularity: number } {
  const n = adjacency.length;
  let membership = Int32Array.from({ length: n }, (_, i) => i);
  let graph: Adjacency = adjacency;
  let levels = 0;
  const degreeOf = (g: Adjacency) => Float64Array.from(g, row => row.reduce((s, [, w]) => s + w, 0));
  const twoM = degreeOf(adjacency).reduce((s, d) => s + d, 0);
  if (twoM > 0)
    for (; levels < 32;) {
      const { community, moved } = localMoves(graph, degreeOf(graph), twoM);
      if (!moved) break;
      levels++;
      membership = membership.map(c => valueAt(community, c));
      const k = community.reduce((m, c) => Math.max(m, c + 1), 0);
      graph = aggregate(graph, community, k);
    }
  const community = connectedParts(adjacency, membership);
  return { community, levels, modularity: modularity(adjacency, community) };
}

/**
 * Normalized mutual information between two partitions, I / mean(H₁, H₂)
 * (Danon et al. 2005): 1 when they agree up to renaming, near 0 when unrelated.
 */
export function nmi(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length;
  if (n === 0 || b.length !== n) return 0;
  const ca = new Map<number, number>();
  const cb = new Map<number, number>();
  // Joint counts keyed by the pair, as nested maps (labels are any integers).
  const joint = new Map<number, Map<number, number>>();
  for (let i = 0; i < n; i++) {
    const x = valueAt(a, i);
    const y = valueAt(b, i);
    ca.set(x, (ca.get(x) ?? 0) + 1);
    cb.set(y, (cb.get(y) ?? 0) + 1);
    let row = joint.get(x);
    if (!row) {
      row = new Map();
      joint.set(x, row);
    }
    row.set(y, (row.get(y) ?? 0) + 1);
  }
  const entropy = (m: Map<number, number>) => [...m.values()].reduce((s, c) => s - (c / n) * Math.log(c / n), 0);
  let mutual = 0;
  for (const [x, row] of joint)
    for (const [y, c] of row) mutual += (c / n) * Math.log((c * n) / ((ca.get(x) ?? n) * (cb.get(y) ?? n)));
  const h = (entropy(ca) + entropy(cb)) / 2;
  return h === 0 ? 1 : mutual / h;
}
