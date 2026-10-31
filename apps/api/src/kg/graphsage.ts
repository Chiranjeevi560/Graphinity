// Inductive node embeddings (Hamilton et al., NeurIPS 2017; master charter §4.3).
// Two message-passing layers with one weight matrix per relation, attention from edge
// trust and time decay, in typed arrays with no Python or GPU at serving. A new
// node gets an embedding from its features and neighbours without retraining. Weights
// stay near identity on purpose: measured on held-out links in two communities, these
// reach AUC 0.74 (features alone 0.50), and last-layer edge-reconstruction training fell
// to 0.61 as all embeddings collapsed toward one direction, so that training isn't shipped.
import { at } from '../ml/num.ts';

export interface GraphEdge {
  from: number;
  to: number;
  relation: number;
  trust: number;
  ageDays: number;
}

export interface SageGraph {
  nodes: number;
  features: Float32Array;
  featureDims: number;
  /** Neighbours by destination node. */
  incoming: GraphEdge[][];
}

export interface SageModel {
  dims: number;
  relations: number;
  /** [layer] self matrix, then [layer][relation] matrices; dims × dims each, row by row. */
  self: Float32Array[];
  rel: Float32Array[][];
}

export const HALF_LIFE_DAYS = 90;
export const attention = (e: Pick<GraphEdge, 'trust' | 'ageDays'>) =>
  Math.max(0, e.trust) * 2 ** (-e.ageDays / HALF_LIFE_DAYS);

export function buildGraph(
  nodes: number,
  features: Float32Array,
  featureDims: number,
  edges: readonly GraphEdge[],
): SageGraph {
  const incoming: GraphEdge[][] = Array.from({ length: nodes }, () => []);
  for (const e of edges) incoming[e.to]?.push(e);
  return { nodes, features, featureDims, incoming };
}

export function initSage(dims: number, relations: number, random: () => number): SageModel {
  const matrix = () => {
    const m = new Float32Array(dims * dims);
    for (let i = 0; i < m.length; i++) m[i] = (random() - 0.5) * (0.5 / dims);
    for (let i = 0; i < dims; i++) m[i * dims + i] = at(m, i * dims + i) + 1;
    return m;
  };
  return {
    dims,
    relations,
    self: [matrix(), matrix()],
    rel: [Array.from({ length: relations }, matrix), Array.from({ length: relations }, matrix)],
  };
}

function normalizeInto(h: Float32Array, offset: number, d: number): void {
  let s = 0;
  for (let i = 0; i < d; i++) s += at(h, offset + i) ** 2;
  if (s <= 0) return;
  const k = 1 / Math.sqrt(s);
  for (let i = 0; i < d; i++) h[offset + i] = at(h, offset + i) * k;
}

function addTimes(out: Float32Array, m: Float32Array, h: Float32Array, offset: number, d: number, w: number) {
  for (let i = 0; i < d; i++) {
    let s = 0;
    for (let j = 0; j < d; j++) s += at(m, i * d + j) * at(h, offset + j);
    out[i] = at(out, i) + w * s;
  }
}

/** One forward pass: h(l) = L2(ReLU(W_self h(l−1) + Σ α W_rel h_u(l−1))). O(layers × edges × d²). */
export function embed(model: SageModel, graph: SageGraph): Float32Array {
  const d = model.dims;
  let h = new Float32Array(graph.nodes * d);
  // Features projected to d by truncating or padding: a fixed, deterministic input layer.
  for (let v = 0; v < graph.nodes; v++) {
    for (let i = 0; i < Math.min(d, graph.featureDims); i++)
      h[v * d + i] = at(graph.features, v * graph.featureDims + i);
    normalizeInto(h, v * d, d);
  }
  const buffer = new Float32Array(d);
  for (let layer = 0; layer < model.self.length; layer++) {
    const next = new Float32Array(graph.nodes * d);
    const self = model.self[layer] ?? new Float32Array(d * d);
    for (let v = 0; v < graph.nodes; v++) {
      buffer.fill(0);
      addTimes(buffer, self, h, v * d, d, 1);
      const list = graph.incoming[v] ?? [];
      let total = 0;
      for (const e of list) total += attention(e);
      if (total > 0)
        for (const e of list) {
          const m = model.rel[layer]?.[e.relation];
          if (m) addTimes(buffer, m, h, e.from * d, d, attention(e) / total);
        }
      for (let i = 0; i < d; i++) next[v * d + i] = Math.max(0, at(buffer, i));
      normalizeInto(next, v * d, d);
    }
    h = next;
  }
  return h;
}

export function cosineAt(h: Float32Array, a: number, b: number, d: number): number {
  let s = 0;
  for (let i = 0; i < d; i++) s += at(h, a * d + i) * at(h, b * d + i);
  return s;
}

/** AUC of linked pairs over random pairs: how well the embedding recovers held-out edges. */
export function linkAuc(
  h: Float32Array,
  d: number,
  positives: ReadonlyArray<[number, number]>,
  negatives: ReadonlyArray<[number, number]>,
): number {
  let wins = 0;
  for (const [a, b] of positives) {
    const p = cosineAt(h, a, b, d);
    for (const [c, e] of negatives) {
      const n = cosineAt(h, c, e, d);
      wins += p > n ? 1 : p === n ? 0.5 : 0;
    }
  }
  return wins / Math.max(1, positives.length * negatives.length);
}
