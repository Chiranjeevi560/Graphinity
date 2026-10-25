// Analysis of one person's own graph (ADR 0009, revised by ADR 0012). Pure and
// bounded: the route loads only the caller's consented nodes and edges, and a
// worker thread runs this (graph-analyzer.ts), so a large graph never holds up
// other requests.
//
// v2, each part chosen by measurement against v1 on planted-structure graphs
// (scripts/benchmark-graph-algorithms.mjs):
//   - Communities: Louvain (graph-communities.ts), not label propagation,
//     which merged every node into one community once 40% of edges crossed.
//   - Embeddings: NetMF (graph-embedding.ts), not hashed walk counts: hidden
//     links found with AUC 0.83 against 0.57 at 30% crossing edges.
//   - Recommendations: cosine to the personalized-PageRank-weighted
//     embedding. v1 added 0.7 × PPR (values summing to 1, so ~0.001 each) to
//     0.3 × cosine, which mixed scales and ranked hidden links worse than PPR alone.
import { louvain } from './graph-communities.ts';
import { cosineOf, NETMF_DIMENSIONS, netmfEmbedding } from './graph-embedding.ts';
import { valueAt } from './ml/linalg.ts';

export interface PersonalGraphNode {
  id: string;
  entityType: string;
  category: string;
}

export interface PersonalGraphEdge {
  sourceNode: string;
  targetNode: string;
  weight: number;
}

export interface GraphInsight {
  id: string;
  pageRank: number;
  personalizedRank: number;
  community: string;
  recommendationScore: number;
}

export interface PersonalGraphInsights {
  algorithmVersion: 'personal-graph-v2';
  iterations: { pageRank: number; personalizedPageRank: number; communities: number };
  nodes: GraphInsight[];
}

const MAX_NODES = 1_000;
const MAX_EDGES = 5_000;
const RANK_DAMPING = 0.85;
const RESTART_PROBABILITY = 0.15;
const RANK_EPSILON = 1e-10;
const MAX_RANK_ITERATIONS = 100;
/** NetMF's eigensolver passes: 2 matched 6 on held-out links (AUC 0.829 vs 0.832) in 40% less time. */
const EMBEDDING_POWER_ITERATIONS = 2;
/**
 * Observed behaviour (edges projected from your own activity) fades by half
 * every 90 days; what you entered yourself doesn't fade. The signals behind
 * observed edges expire at 365 days, when an edge has 6% of its weight left,
 * so expiry is a small step, not a cliff. A prior, not fitted: there is no
 * data yet to fit it to.
 */
export const OBSERVED_HALF_LIFE_DAYS = 90;

export type Neighbor = { id: string; weight: number };
type RankResult = { scores: Map<string, number>; iterations: number };

/** An edge's weight in analysis: as stored, times its confidence, faded with age if it was observed. */
export function effectiveWeight(
  edge: { weight: number; confidence: number; freshness: Date; observed: boolean },
  now: Date,
): number {
  const base = edge.weight * edge.confidence;
  if (!edge.observed) return base;
  const days = Math.max(0, (now.getTime() - edge.freshness.getTime()) / 86_400_000);
  return base * 2 ** (-days / OBSERVED_HALF_LIFE_DAYS);
}

function assertGraphSize(nodes: readonly PersonalGraphNode[], edges: readonly PersonalGraphEdge[]) {
  if (nodes.length > MAX_NODES || edges.length > MAX_EDGES) {
    throw new RangeError(`personal graph is limited to ${MAX_NODES} nodes and ${MAX_EDGES} edges per analysis`);
  }
}

function makeDirectedAdjacency(nodes: readonly PersonalGraphNode[], edges: readonly PersonalGraphEdge[]) {
  const ids = new Set(nodes.map(node => node.id));
  const adjacency = new Map<string, Neighbor[]>(nodes.map(node => [node.id, []]));
  for (const edge of edges) {
    if (!ids.has(edge.sourceNode) || !ids.has(edge.targetNode) || edge.sourceNode === edge.targetNode) continue;
    if (!Number.isFinite(edge.weight) || edge.weight <= 0) continue;
    adjacency.get(edge.sourceNode)?.push({ id: edge.targetNode, weight: edge.weight });
  }
  for (const neighbors of adjacency.values()) neighbors.sort((a, b) => a.id.localeCompare(b.id));
  return adjacency;
}

export function makeUndirectedAdjacency(nodes: readonly PersonalGraphNode[], edges: readonly PersonalGraphEdge[]) {
  const ids = new Set(nodes.map(node => node.id));
  const combined = new Map<string, Map<string, number>>(nodes.map(node => [node.id, new Map()]));
  for (const edge of edges) {
    if (!ids.has(edge.sourceNode) || !ids.has(edge.targetNode) || edge.sourceNode === edge.targetNode) continue;
    if (!Number.isFinite(edge.weight) || edge.weight <= 0) continue;
    combined
      .get(edge.sourceNode)
      ?.set(edge.targetNode, (combined.get(edge.sourceNode)?.get(edge.targetNode) ?? 0) + edge.weight);
    combined
      .get(edge.targetNode)
      ?.set(edge.sourceNode, (combined.get(edge.targetNode)?.get(edge.sourceNode) ?? 0) + edge.weight);
  }
  return new Map(
    [...combined].map(([id, neighbors]) => [
      id,
      [...neighbors].map(([target, weight]) => ({ id: target, weight })).sort((a, b) => a.id.localeCompare(b.id)),
    ]),
  );
}

/**
 * Weighted PageRank with teleport distribution `teleport`, continuing with
 * probability `continuationProbability`; dangling mass follows the teleport.
 * Flat arrays with each node's out-weight computed once: the same arithmetic
 * as v1's Map version, about 10× faster (it was most of an analysis's time).
 */
export function rankGraph(
  ids: readonly string[],
  adjacency: Map<string, Neighbor[]>,
  teleport: Map<string, number>,
  continuationProbability: number,
): RankResult {
  const n = ids.length;
  if (!n) return { scores: new Map(), iterations: 0 };
  const index = new Map(ids.map((id, i) => [id, i]));
  const start = new Int32Array(n + 1);
  const targets: number[] = [];
  const shares: number[] = [];
  ids.forEach((id, i) => {
    const neighbors = (adjacency.get(id) ?? []).filter(nb => index.has(nb.id));
    const total = neighbors.reduce((sum, nb) => sum + nb.weight, 0);
    if (total > 0)
      for (const nb of neighbors) {
        targets.push(index.get(nb.id) ?? 0);
        shares.push(nb.weight / total);
      }
    start[i + 1] = targets.length;
  });
  const jump = Float64Array.from(ids, id => teleport.get(id) ?? 0);
  let scores = Float64Array.from(jump);
  let next = new Float64Array(n);
  const c = continuationProbability;
  let iterations = MAX_RANK_ITERATIONS;
  for (let iteration = 1; iteration <= MAX_RANK_ITERATIONS; iteration += 1) {
    for (let i = 0; i < n; i++) next[i] = (1 - c) * valueAt(jump, i);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      const from = valueAt(start, i);
      const to = valueAt(start, i + 1);
      const score = valueAt(scores, i);
      if (from === to) dangling += score;
      else
        for (let e = from; e < to; e++) {
          const t = valueAt(targets, e);
          next[t] = valueAt(next, t) + c * score * valueAt(shares, e);
        }
    }
    if (dangling > 0) for (let i = 0; i < n; i++) next[i] = valueAt(next, i) + c * dangling * valueAt(jump, i);
    let difference = 0;
    for (let i = 0; i < n; i++) difference += Math.abs(valueAt(next, i) - valueAt(scores, i));
    [scores, next] = [next, scores];
    if (difference <= RANK_EPSILON) {
      iterations = iteration;
      break;
    }
  }
  return { scores: new Map(ids.map((id, i) => [id, valueAt(scores, i)])), iterations };
}

/** Bounded, deterministic algorithms over the caller's already consent-filtered graph. */
export function analyzePersonalGraph(
  nodes: readonly PersonalGraphNode[],
  edges: readonly PersonalGraphEdge[],
  seedNodeIds: readonly string[],
  limit = 20,
): PersonalGraphInsights {
  assertGraphSize(nodes, edges);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError('limit must be from 1 to 100');
  if (seedNodeIds.length < 1 || seedNodeIds.length > 10) throw new RangeError('provide between 1 and 10 seed nodes');
  const ids = nodes.map(node => node.id).sort((a, b) => a.localeCompare(b));
  const idSet = new Set(ids);
  if (new Set(seedNodeIds).size !== seedNodeIds.length || seedNodeIds.some(id => !idSet.has(id))) {
    throw new RangeError('seed nodes must be distinct nodes in this graph');
  }
  const directed = makeDirectedAdjacency(nodes, edges);
  const undirected = makeUndirectedAdjacency(nodes, edges);
  const uniform = new Map(ids.map(id => [id, 1 / Math.max(1, ids.length)]));
  const personalization = new Map(seedNodeIds.map(id => [id, 1 / seedNodeIds.length]));
  const pageRank = rankGraph(ids, directed, uniform, RANK_DAMPING);
  const ppr = rankGraph(ids, directed, personalization, 1 - RESTART_PROBABILITY);
  // Numbered undirected graph for Louvain and NetMF: row i is ids[i].
  const index = new Map(ids.map((id, i) => [id, i]));
  const numbered = ids.map(id =>
    (undirected.get(id) ?? []).map(n => [index.get(n.id) ?? 0, n.weight] as [number, number]),
  );
  const communities = louvain(numbered);
  // A community is named by its lowest node id: communities are numbered from their lowest node.
  const firstOf = new Map<number, string>();
  communities.community.forEach((c, i) => {
    if (!firstOf.has(c)) firstOf.set(c, ids[i] ?? '');
  });
  const embeddings = netmfEmbedding(numbered, { powerIterations: EMBEDDING_POWER_ITERATIONS });
  // The personalized embedding: every node's vector weighted by its PPR score, then unit length.
  const personalizedEmbedding = new Float64Array(NETMF_DIMENSIONS);
  embeddings.forEach((vector, i) => {
    const weight = ppr.scores.get(ids[i] ?? '') ?? 0;
    vector.forEach((x, c) => (personalizedEmbedding[c] = valueAt(personalizedEmbedding, c) + weight * x));
  });
  const norm = Math.hypot(...personalizedEmbedding);
  if (norm > 0) personalizedEmbedding.forEach((x, c) => (personalizedEmbedding[c] = x / norm));
  const seeds = new Set(seedNodeIds);
  const scored = nodes
    .filter(node => !seeds.has(node.id))
    .map(node => {
      const personalizedRank = ppr.scores.get(node.id) ?? 0;
      const at = index.get(node.id) ?? 0;
      return {
        id: node.id,
        pageRank: pageRank.scores.get(node.id) ?? 0,
        personalizedRank,
        community: firstOf.get(communities.community[at] ?? -1) ?? node.id,
        recommendationScore: Math.max(0, cosineOf(personalizedEmbedding, embeddings[at] ?? [])),
      };
    })
    .sort(
      (a, b) =>
        b.recommendationScore - a.recommendationScore ||
        b.personalizedRank - a.personalizedRank ||
        a.id.localeCompare(b.id),
    );
  return {
    algorithmVersion: 'personal-graph-v2',
    iterations: {
      pageRank: pageRank.iterations,
      personalizedPageRank: ppr.iterations,
      communities: communities.levels,
    },
    nodes: scored.slice(0, limit),
  };
}
