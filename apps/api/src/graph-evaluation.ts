// Ground truth for judging graph algorithms (ADR 0012), used by the tests and
// scripts/benchmark-graph-algorithms.mjs: graphs with planted communities, and
// link prediction on edges hidden from the algorithm. Personal graphs are too
// small and too private to hand-label; planted structure is the honest
// stand-in, and what it can't say about real graphs is stated where it's used.
import { seededRandom } from './ml/linalg.ts';
import type { Neighbor, PersonalGraphNode } from './personal-graph-algorithms.ts';

export interface PlantedGraph {
  adjacency: Array<Array<[number, number]>>;
  /** The community each node was planted in. */
  truth: Int32Array;
  edges: Array<[number, number]>;
}

/**
 * n nodes in k equal communities; each of n·degree/2 edges joins a random
 * node to one in its own community with probability 1 − mixing, otherwise to
 * any node (the planted-partition model). Duplicates and self-loops are
 * dropped, so the edge count is a little under the target.
 */
export function plantedPartition(n: number, k: number, degree: number, mixing: number, seed = 1): PlantedGraph {
  const random = seededRandom(seed);
  const truth = Int32Array.from({ length: n }, (_, i) => i % k);
  const members = Array.from({ length: k }, (_, c) =>
    Array.from({ length: Math.ceil((n - c) / k) }, (_, j) => c + j * k),
  );
  const seen = new Set<number>();
  const edges: Array<[number, number]> = [];
  for (let e = 0; e < (n * degree) / 2; e++) {
    const u = Math.floor(random() * n);
    const group = members[truth[u] ?? 0] ?? [];
    const v = random() < mixing ? Math.floor(random() * n) : (group[Math.floor(random() * group.length)] ?? u);
    if (u === v) continue;
    const [a, b] = u < v ? [u, v] : [v, u];
    if (seen.has(a * n + b)) continue;
    seen.add(a * n + b);
    edges.push([a, b]);
  }
  return { adjacency: toAdjacency(n, edges), truth, edges };
}

export function toAdjacency(n: number, edges: ReadonlyArray<readonly [number, number]>, weight = 1) {
  const adjacency = Array.from({ length: n }, () => [] as Array<[number, number]>);
  for (const [a, b] of edges) {
    adjacency[a]?.push([b, weight]);
    adjacency[b]?.push([a, weight]);
  }
  return adjacency;
}

/** Hides a fraction of edges (chosen by a seeded shuffle) for link prediction. */
export function holdOut(n: number, edges: ReadonlyArray<readonly [number, number]>, fraction: number, seed = 2) {
  const random = seededRandom(seed);
  const order = edges.map((e, i) => ({ e, r: random(), i })).sort((a, b) => a.r - b.r || a.i - b.i);
  const cut = Math.floor(edges.length * fraction);
  const hidden = order.slice(0, cut).map(x => x.e);
  const kept = order.slice(cut).map(x => x.e);
  return { adjacency: toAdjacency(n, kept), hidden, kept };
}

/**
 * Area under the ROC curve for telling hidden edges from random non-edges:
 * the chance a hidden edge scores above a non-edge, ties counting half.
 * 0.5 is guessing.
 */
export function linkPredictionAuc(
  n: number,
  allEdges: ReadonlyArray<readonly [number, number]>,
  hidden: ReadonlyArray<readonly [number, number]>,
  score: (a: number, b: number) => number,
  seed = 3,
): number {
  const random = seededRandom(seed);
  const present = new Set(allEdges.map(([a, b]) => (a < b ? a * n + b : b * n + a)));
  const negatives: Array<[number, number]> = [];
  while (negatives.length < hidden.length) {
    const a = Math.floor(random() * n);
    const b = Math.floor(random() * n);
    if (a === b || present.has(a < b ? a * n + b : b * n + a)) continue;
    negatives.push([a, b]);
  }
  const pos = hidden.map(([a, b]) => score(a, b));
  const neg = negatives.map(([a, b]) => score(a, b));
  // Rank-sum (Mann-Whitney U) in O((p + q) log(p + q)).
  const all = [...pos.map(s => ({ s, p: 1 })), ...neg.map(s => ({ s, p: 0 }))].sort((x, y) => x.s - y.s);
  let rankSum = 0;
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j < all.length && all[j]?.s === all[i]?.s) j++;
    const rank = (i + 1 + j) / 2;
    for (let t = i; t < j; t++) if (all[t]?.p) rankSum += rank;
    i = j;
  }
  const p = pos.length;
  const q = neg.length;
  return p && q ? (rankSum - (p * (p + 1)) / 2) / (p * q) : 0.5;
}

// personal-graph-v1's community detection and embeddings, kept unchanged as
// the baseline every later version is measured against (ADR 0009, 0012).
const MAX_COMMUNITY_ITERATIONS = 20;
const EMBEDDING_DIMENSIONS = 16;
const WALK_COUNT = 4;
const WALK_LENGTH = 8;
const CONTEXT_WINDOW = 2;

export function labelPropagation(
  nodes: readonly PersonalGraphNode[],
  adjacency: Map<string, Neighbor[]>,
): { labels: Map<string, string>; iterations: number } {
  const ids = nodes.map(node => node.id).sort((a, b) => a.localeCompare(b));
  const labels = new Map(ids.map(id => [id, id]));
  for (let iteration = 1; iteration <= MAX_COMMUNITY_ITERATIONS; iteration += 1) {
    let changed = false;
    for (const id of ids) {
      const totals = new Map<string, number>();
      for (const neighbor of adjacency.get(id) ?? []) {
        const label = labels.get(neighbor.id);
        if (label) totals.set(label, (totals.get(label) ?? 0) + neighbor.weight);
      }
      if (!totals.size) continue;
      const label = [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
      if (label && label !== labels.get(id)) {
        labels.set(id, label);
        changed = true;
      }
    }
    if (!changed) return { labels, iterations: iteration };
  }
  return { labels, iterations: MAX_COMMUNITY_ITERATIONS };
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function random01(seed: number): number {
  let value = seed | 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return (value >>> 0) / 0x1_0000_0000;
}

export function hashedWalkEmbeddings(
  nodes: readonly PersonalGraphNode[],
  adjacency: Map<string, Neighbor[]>,
): Map<string, number[]> {
  const vectors = new Map(nodes.map(node => [node.id, new Array<number>(EMBEDDING_DIMENSIONS).fill(0)]));
  for (const node of nodes) {
    const startSeed = hashString(node.id);
    for (let walk = 0; walk < WALK_COUNT; walk += 1) {
      const path = [node.id];
      let current = node.id;
      for (let step = 0; step < WALK_LENGTH; step += 1) {
        const neighbors = adjacency.get(current) ?? [];
        const total = neighbors.reduce((sum, neighbor) => sum + neighbor.weight, 0);
        if (!total) break;
        const needle = random01(startSeed ^ Math.imul(walk + 1, 0x9e3779b1) ^ Math.imul(step + 1, 0x85ebca6b)) * total;
        let cumulative = 0;
        const picked = neighbors.find(neighbor => {
          cumulative += neighbor.weight;
          return cumulative > needle;
        });
        current = picked?.id ?? neighbors.at(-1)?.id ?? current;
        path.push(current);
      }
      for (let index = 0; index < path.length; index += 1) {
        const vector = vectors.get(path[index] ?? '');
        if (!vector) continue;
        for (let distance = 1; distance <= CONTEXT_WINDOW; distance += 1) {
          const context = path[index + distance];
          if (!context) continue;
          const hash = hashString(context);
          const dimension = hash % EMBEDDING_DIMENSIONS;
          const sign = (hash & 0x80000000) === 0 ? 1 : -1;
          vector[dimension] = (vector[dimension] ?? 0) + sign / distance;
        }
      }
    }
  }
  for (const vector of vectors.values()) {
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (norm > 0) for (let i = 0; i < vector.length; i += 1) vector[i] = (vector[i] ?? 0) / norm;
  }
  return vectors;
}
