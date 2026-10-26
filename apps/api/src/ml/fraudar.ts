// Fraudar (Hooi, Song, Beutel, Shah, Shin & Faloutsos, KDD 2016): find the
// densest block of a bipartite graph, sources x targets (who picked whose
// answers; who opened which questions), robust to camouflage. Accounts in a
// ring act on each other far more than chance; to look normal they also act
// on honest, popular targets. Weighting each edge by 1 / log(target degree + c)
// makes those camouflage edges to popular targets count little, so the ring
// still stands out (the paper's Theorem 2 bounds what camouflage can do).
//
// Greedy peeling: repeatedly remove the node whose removal loses the least
// suspiciousness (sum of edge weights it touches inside the block), and keep
// the subset with the best average, f(S) / |S|. With a priority queue,
// O(E log V); exact ties break by node index, so runs are deterministic.
// Several blocks are found by removing each one's edges and peeling again.

export interface BipartiteEdge {
  source: number;
  target: number;
  /** Times this source acted on this target (e.g. picks across questions). */
  count?: number;
}

export interface DenseBlock {
  sources: number[];
  targets: number[];
  /** Weighted edges inside the block per node: the density Fraudar maximizes. */
  density: number;
  /** Edges inside the block, unweighted. */
  edges: number;
}

/** The paper's column weight constant: log(degree + 5). */
const C = 5;

/** A binary min-heap of (priority, node) with decrease-key by lazy re-insertion. */
class Heap {
  private items: Array<{ p: number; n: number }> = [];
  push(p: number, n: number) {
    const a = this.items;
    a.push({ p, n });
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (less(a[parent], a[i])) break;
      swap(a, i, parent);
      i = parent;
    }
  }
  pop(): { p: number; n: number } | undefined {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length && last) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && less(a[l], a[m])) m = l;
        if (r < a.length && less(a[r], a[m])) m = r;
        if (m === i) break;
        swap(a, i, m);
        i = m;
      }
    }
    return top;
  }
}
const less = (x: { p: number; n: number } | undefined, y: { p: number; n: number } | undefined) =>
  !!x && !!y && (x.p < y.p || (x.p === y.p && x.n < y.n));
function swap(a: Array<{ p: number; n: number }>, i: number, j: number) {
  const t = a[i];
  const u = a[j];
  if (t && u) {
    a[i] = u;
    a[j] = t;
  }
}

/**
 * The densest block among the given edges, by Fraudar's greedy peeling.
 * `weighted: false` drops the camouflage-resistant column weights (plain
 * densest subgraph, Charikar 2000), for comparison.
 */
export function densestBlock(edges: readonly BipartiteEdge[], options: { weighted?: boolean } = {}): DenseBlock | null {
  if (edges.length === 0) return null;
  const weighted = options.weighted ?? true;
  let sources = 0;
  let targets = 0;
  for (const e of edges) {
    sources = Math.max(sources, e.source + 1);
    targets = Math.max(targets, e.target + 1);
  }
  // Nodes 0..sources-1 are sources; sources..sources+targets-1 are targets.
  const n = sources + targets;
  const targetDegree = new Float64Array(targets);
  for (const e of edges) targetDegree[e.target] = (targetDegree[e.target] ?? 0) + (e.count ?? 1);
  const weight = edges.map(e => (e.count ?? 1) * (weighted ? 1 / Math.log((targetDegree[e.target] ?? 0) + C) : 1));
  const adjacency: number[][] = Array.from({ length: n }, () => []);
  edges.forEach((e, k) => {
    adjacency[e.source]?.push(k);
    adjacency[sources + e.target]?.push(k);
  });
  const contribution = new Float64Array(n);
  edges.forEach((e, k) => {
    const w = weight[k] ?? 0;
    contribution[e.source] = (contribution[e.source] ?? 0) + w;
    contribution[sources + e.target] = (contribution[sources + e.target] ?? 0) + w;
  });
  const alive = new Uint8Array(n);
  let present = 0;
  for (let i = 0; i < n; i++)
    if ((adjacency[i]?.length ?? 0) > 0) {
      alive[i] = 1;
      present++;
    }
  const edgeAlive = new Uint8Array(edges.length).fill(1);
  let total = weight.reduce((s, w) => s + w, 0);
  const heap = new Heap();
  for (let i = 0; i < n; i++) if (alive[i]) heap.push(contribution[i] ?? 0, i);

  let best = total / present;
  let bestRemoved = 0;
  const order: number[] = [];
  while (present > 0) {
    const top = heap.pop();
    if (!top) break;
    const i = top.n;
    // A stale entry: the node is gone or its contribution has dropped since.
    if (!alive[i] || top.p !== contribution[i]) continue;
    alive[i] = 0;
    present--;
    order.push(i);
    total -= contribution[i] ?? 0;
    for (const k of adjacency[i] ?? []) {
      if (!edgeAlive[k]) continue;
      edgeAlive[k] = 0;
      const e = edges[k];
      if (!e) continue;
      const other = i === e.source ? sources + e.target : e.source;
      contribution[other] = (contribution[other] ?? 0) - (weight[k] ?? 0);
      if (alive[other]) heap.push(contribution[other] ?? 0, other);
    }
    if (present > 0 && total / present > best + 1e-12) {
      best = total / present;
      bestRemoved = order.length;
    }
  }
  // The block is every node not removed before the best point.
  const removed = new Set(order.slice(0, bestRemoved));
  const inBlock = (i: number) => (adjacency[i]?.length ?? 0) > 0 && !removed.has(i);
  const blockSources: number[] = [];
  const blockTargets: number[] = [];
  for (let i = 0; i < sources; i++) if (inBlock(i)) blockSources.push(i);
  for (let j = 0; j < targets; j++) if (inBlock(sources + j)) blockTargets.push(j);
  const s = new Set(blockSources);
  const t = new Set(blockTargets);
  const inside = edges.filter(e => s.has(e.source) && t.has(e.target)).length;
  return { sources: blockSources, targets: blockTargets, density: best, edges: inside };
}

/**
 * Up to `k` blocks: each found block's edges are removed before looking
 * again. Peeling keeps every node it didn't remove, so one peeled block can be
 * several groups with no edge between them (a large honest crowd plus a small
 * puppet cluster elsewhere in the graph); each connected part is returned as
 * its own block, so a small group is judged on its own and not hidden inside
 * a crowd.
 */
export function denseBlocks(
  edges: readonly BipartiteEdge[],
  k: number,
  options: { weighted?: boolean; minDensity?: number } = {},
): DenseBlock[] {
  const out: DenseBlock[] = [];
  let rest = [...edges];
  for (let b = 0; b < k && rest.length; b++) {
    const block = densestBlock(rest, options);
    if (!block || block.density < (options.minDensity ?? 0)) break;
    const s = new Set(block.sources);
    const t = new Set(block.targets);
    const inside = rest.filter(e => s.has(e.source) && t.has(e.target));
    out.push(...connectedParts(inside));
    rest = rest.filter(e => !(s.has(e.source) && t.has(e.target)));
  }
  return out;
}

/** The connected parts of a block's internal edges, largest first, ties by smallest source. */
function connectedParts(inside: readonly BipartiteEdge[]): DenseBlock[] {
  // Union-find over sources (as "s<id>") and targets ("t<id>").
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) ?? r;
    let y = x;
    while (y !== r) {
      const next = parent.get(y) ?? r;
      parent.set(y, r);
      y = next;
    }
    return r;
  };
  for (const e of inside) {
    const a = `s${e.source}`;
    const b = `t${e.target}`;
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const parts = new Map<string, BipartiteEdge[]>();
  for (const e of inside) {
    const root = find(`s${e.source}`);
    const list = parts.get(root) ?? [];
    list.push(e);
    parts.set(root, list);
  }
  return [...parts.values()]
    .map(list => {
      const sources = [...new Set(list.map(e => e.source))].sort((a, b) => a - b);
      const targets = [...new Set(list.map(e => e.target))].sort((a, b) => a - b);
      const count = list.reduce((sum, e) => sum + (e.count ?? 1), 0);
      return { sources, targets, density: count / (sources.length + targets.length), edges: list.length };
    })
    .sort(
      (a, b) =>
        b.sources.length + b.targets.length - (a.sources.length + a.targets.length) ||
        (a.sources[0] ?? 0) - (b.sources[0] ?? 0),
    );
}

/**
 * The accounts a block implicates. Fraudar's guarantee is about the sources
 * (the accounts acting); a block's targets can include popular honest
 * accounts the ring acted on as camouflage. A target is kept only when at
 * least `minShare` of everything acting on it comes from the block's sources:
 * a ring's beneficiary is acted on mostly by the ring, a popular honest
 * account mostly by everyone else.
 */
export function implicated(
  block: DenseBlock,
  edges: readonly BipartiteEdge[],
  minShare = 0.5,
): { sources: number[]; targets: number[] } {
  const inSources = new Set(block.sources);
  const fromBlock = new Map<number, number>();
  const all = new Map<number, number>();
  const blockTargets = new Set(block.targets);
  for (const e of edges) {
    if (!blockTargets.has(e.target)) continue;
    const c = e.count ?? 1;
    all.set(e.target, (all.get(e.target) ?? 0) + c);
    if (inSources.has(e.source)) fromBlock.set(e.target, (fromBlock.get(e.target) ?? 0) + c);
  }
  return {
    sources: block.sources,
    targets: block.targets.filter(t => (fromBlock.get(t) ?? 0) / (all.get(t) ?? 1) >= minShare),
  };
}
