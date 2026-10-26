// LambdaMART (Burges 2010, "From RankNet to LambdaRank to LambdaMART"): an
// ensemble of regression trees fitted, one after another, to the LambdaRank
// gradients, which push each pair of results apart by how much swapping them
// would change NDCG@k. It is the algorithm LightGBM and XGBoost run as
// "lambdarank"; here it is written out so it needs no native code, with the
// same essentials: feature histograms (quantile bins) for split finding,
// Newton steps for leaf values, L2 regularisation, shrinkage, and per-result
// weights for inverse-propensity correction of click data (Joachims et al. 2017).
// Deterministic: the same data and options give the same model.
import { valueAt } from './linalg.ts';

export interface RankingQuery {
  /** One row of features per result. */
  features: readonly (readonly number[])[];
  /** Graded relevance per result (0 = not relevant). */
  labels: readonly number[];
  /**
   * Per-result weight: an inverse propensity for a result judged from a
   * click, 1 otherwise. A pair is weighted by its more relevant result's.
   */
  weights?: readonly number[];
}

export interface LambdaMartOptions {
  trees?: number;
  learningRate?: number;
  maxDepth?: number;
  /** Least summed hessian in a leaf (LightGBM's min_sum_hessian_in_leaf). */
  minLeafWeight?: number;
  /** Fewest results in a leaf (LightGBM's min_data_in_leaf). */
  minLeafSize?: number;
  l2?: number;
  /** Quantile bins per feature for split finding. */
  bins?: number;
  /** NDCG cutoff the gradients optimise. */
  k?: number;
  /** RankNet's sigma. */
  sigma?: number;
}

export const LAMBDAMART_DEFAULTS: Required<LambdaMartOptions> = {
  trees: 150,
  learningRate: 0.1,
  maxDepth: 4,
  minLeafWeight: 1e-3,
  minLeafSize: 5,
  l2: 1,
  bins: 64,
  k: 10,
  sigma: 1,
};

/** A node: internal (feature, threshold, children) or a leaf (value). */
export type TreeNode = { feature: number; threshold: number; left: number; right: number } | { value: number };

export interface LambdaMartModel {
  features: number;
  trees: TreeNode[][];
  learningRate: number;
}

export function scoreOne(model: LambdaMartModel, x: readonly number[]): number {
  let s = 0;
  for (const tree of model.trees) {
    let i = 0;
    for (;;) {
      const node = tree[i];
      if (!node) break;
      if ('value' in node) {
        s += node.value;
        break;
      }
      i = valueAt(x, node.feature) <= node.threshold ? node.left : node.right;
    }
  }
  return s * model.learningRate;
}

/** Results in the order the model would show them (ties by original order). */
export function rank(model: LambdaMartModel, rows: readonly (readonly number[])[]): number[] {
  const scores = rows.map(r => scoreOne(model, r));
  return scores
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map(x => x.i);
}

const gain = (label: number) => 2 ** label - 1;
const discount = (position: number) => 1 / Math.log2(position + 2);

/** Ideal DCG@k for a query's labels: the normaliser of NDCG. */
function idealDcg(labels: readonly number[], k: number): number {
  const sorted = [...labels].sort((a, b) => b - a);
  let d = 0;
  for (let i = 0; i < Math.min(k, sorted.length); i++) d += gain(valueAt(sorted, i)) * discount(i);
  return d;
}

/** Quantile thresholds per feature: the candidate split points. */
function quantileThresholds(rows: readonly (readonly number[])[], features: number, bins: number): number[][] {
  const out: number[][] = [];
  for (let f = 0; f < features; f++) {
    const values = [...new Set(rows.map(r => valueAt(r, f)))].sort((a, b) => a - b);
    if (values.length <= bins) {
      // Midpoints between distinct values: every distinct split is possible.
      out.push(values.slice(0, -1).map((v, i) => (v + (values[i + 1] ?? v)) / 2));
      continue;
    }
    const all = rows.map(r => valueAt(r, f)).sort((a, b) => a - b);
    const t = new Set<number>();
    for (let b = 1; b < bins; b++) t.add(valueAt(all, Math.floor((b * all.length) / bins)));
    out.push([...t].sort((a, b) => a - b));
  }
  return out;
}

/** The bin index of each value: values <= thresholds[b] fall in bin b. */
function binOf(thresholds: readonly number[], v: number): number {
  let lo = 0;
  let hi = thresholds.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (v <= (thresholds[mid] ?? Infinity)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * LambdaRank gradients for one query's results, as negative gradients
 * (positive pushes a result up), with their Newton hessians. Each pair is
 * pushed apart by |change in NDCG@k| from swapping it: zero when both are
 * below the cutoff, since neither then counts. Weighted by the more relevant
 * result's weight.
 */
export function lambdaGradients(
  scores: ArrayLike<number>,
  labels: readonly number[],
  weights: readonly number[],
  idcg: number,
  k: number,
  sigma: number,
): { grad: Float64Array; hess: Float64Array } {
  const m = labels.length;
  const grad = new Float64Array(m);
  const hess = new Float64Array(m);
  const order = Array.from({ length: m }, (_, i) => i).sort((a, b) => valueAt(scores, b) - valueAt(scores, a) || a - b);
  const pos = new Int32Array(m);
  order.forEach((idx, p) => (pos[idx] = p));
  for (let i = 0; i < m; i++)
    for (let j = 0; j < m; j++) {
      const li = valueAt(labels, i);
      const lj = valueAt(labels, j);
      if (li <= lj) continue;
      const pi = valueAt(pos, i);
      const pj = valueAt(pos, j);
      const di = pi < k ? discount(pi) : 0;
      const dj = pj < k ? discount(pj) : 0;
      const delta = (Math.abs((gain(li) - gain(lj)) * (di - dj)) / idcg) * (weights[i] ?? 1);
      if (delta === 0) continue;
      const rho = 1 / (1 + Math.exp(sigma * (valueAt(scores, i) - valueAt(scores, j))));
      const l = sigma * rho * delta;
      const h = sigma * sigma * rho * (1 - rho) * delta;
      grad[i] = valueAt(grad, i) + l;
      grad[j] = valueAt(grad, j) - l;
      hess[i] = valueAt(hess, i) + h;
      hess[j] = valueAt(hess, j) + h;
    }
  return { grad, hess };
}

export function trainLambdaMart(queries: readonly RankingQuery[], options: LambdaMartOptions = {}): LambdaMartModel {
  const o = { ...LAMBDAMART_DEFAULTS, ...options };
  const rows: (readonly number[])[] = [];
  const labels: number[] = [];
  const weights: number[] = [];
  const spans: Array<{ start: number; end: number; idcg: number }> = [];
  let features = 0;
  for (const q of queries) {
    const start = rows.length;
    q.features.forEach((r, i) => {
      rows.push(r);
      labels.push(valueAt(q.labels, i));
      weights.push(q.weights?.[i] ?? 1);
      features = Math.max(features, r.length);
    });
    const idcg = idealDcg(q.labels, o.k);
    // A query with no relevant result can't teach an order.
    if (idcg > 0 && rows.length - start > 1) spans.push({ start, end: rows.length, idcg });
  }
  const n = rows.length;
  const thresholds = quantileThresholds(rows, features, o.bins);
  const binned = thresholds.map((t, f) => Uint16Array.from(rows, r => binOf(t, valueAt(r, f))));
  const scores = new Float64Array(n);
  const grad = new Float64Array(n);
  const hess = new Float64Array(n);
  const trees: TreeNode[][] = [];

  for (let t = 0; t < o.trees; t++) {
    grad.fill(0);
    hess.fill(0);
    for (const { start, end, idcg } of spans) lambdas(start, end, idcg);
    const tree = growTree();
    trees.push(tree.nodes);
    for (let i = 0; i < n; i++) scores[i] = valueAt(scores, i) + o.learningRate * valueAt(tree.leafValue, i);
  }
  return { features, trees, learningRate: o.learningRate };

  function lambdas(start: number, end: number, idcg: number) {
    const g = lambdaGradients(
      scores.subarray(start, end),
      labels.slice(start, end),
      weights.slice(start, end),
      idcg,
      o.k,
      o.sigma,
    );
    for (let i = 0; i < end - start; i++) {
      grad[start + i] = valueAt(grad, start + i) + valueAt(g.grad, i);
      hess[start + i] = valueAt(hess, start + i) + valueAt(g.hess, i);
    }
  }

  function growTree(): { nodes: TreeNode[]; leafValue: Float64Array } {
    const nodes: TreeNode[] = [];
    const leafValue = new Float64Array(n);
    const all = Array.from({ length: n }, (_, i) => i);
    build(all, 0);
    return { nodes, leafValue };

    function build(members: number[], depth: number): number {
      const id = nodes.length;
      nodes.push({ value: 0 });
      let G = 0;
      let H = 0;
      for (const i of members) {
        G += valueAt(grad, i);
        H += valueAt(hess, i);
      }
      const leaf = () => {
        const value = H + o.l2 > 0 ? G / (H + o.l2) : 0;
        nodes[id] = { value };
        for (const i of members) leafValue[i] = value;
        return id;
      };
      if (depth >= o.maxDepth || members.length < 2 * o.minLeafSize || H < 2 * o.minLeafWeight) return leaf();
      const best = bestSplit(members, G, H);
      if (!best) return leaf();
      const left: number[] = [];
      const right: number[] = [];
      const bins = binned[best.feature] ?? new Uint16Array(0);
      for (const i of members) (valueAt(bins, i) <= best.bin ? left : right).push(i);
      const l = build(left, depth + 1);
      const r = build(right, depth + 1);
      nodes[id] = { feature: best.feature, threshold: thresholds[best.feature]?.[best.bin] ?? 0, left: l, right: r };
      return id;
    }

    function bestSplit(members: number[], G: number, H: number) {
      const parent = (G * G) / (H + o.l2);
      let best: { feature: number; bin: number; gain: number } | null = null;
      for (let f = 0; f < features; f++) {
        const t = thresholds[f] ?? [];
        if (t.length === 0) continue;
        const gs = new Float64Array(t.length + 1);
        const hs = new Float64Array(t.length + 1);
        const cs = new Uint32Array(t.length + 1);
        const bins = binned[f] ?? new Uint16Array(0);
        for (const i of members) {
          const b = valueAt(bins, i);
          gs[b] = valueAt(gs, b) + valueAt(grad, i);
          hs[b] = valueAt(hs, b) + valueAt(hess, i);
          cs[b] = valueAt(cs, b) + 1;
        }
        let gl = 0;
        let hl = 0;
        let cl = 0;
        for (let b = 0; b < t.length; b++) {
          gl += valueAt(gs, b);
          hl += valueAt(hs, b);
          cl += valueAt(cs, b);
          const gr = G - gl;
          const hr = H - hl;
          const cr = members.length - cl;
          if (cl < o.minLeafSize || cr < o.minLeafSize || hl < o.minLeafWeight || hr < o.minLeafWeight) continue;
          const g = (gl * gl) / (hl + o.l2) + (gr * gr) / (hr + o.l2) - parent;
          if (g > 1e-12 && (!best || g > best.gain)) best = { feature: f, bin: b, gain: g };
        }
      }
      return best;
    }
  }
}

/** Compact JSON for the model registry's artifact. */
export function serializeLambdaMart(model: LambdaMartModel): Buffer {
  return Buffer.from(JSON.stringify({ v: 1, ...model }));
}

export function deserializeLambdaMart(artifact: Buffer): LambdaMartModel {
  const parsed = JSON.parse(artifact.toString('utf8')) as { v?: number } & LambdaMartModel;
  if (parsed.v !== 1 || !Array.isArray(parsed.trees) || typeof parsed.learningRate !== 'number')
    throw new Error('not a LambdaMART model this code can read');
  return { features: parsed.features, trees: parsed.trees, learningRate: parsed.learningRate };
}
