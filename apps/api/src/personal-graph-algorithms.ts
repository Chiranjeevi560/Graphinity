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
  algorithmVersion: 'personal-graph-v1';
  iterations: { pageRank: number; personalizedPageRank: number; communities: number };
  nodes: GraphInsight[];
}

const MAX_NODES = 1_000;
const MAX_EDGES = 5_000;
const RANK_DAMPING = 0.85;
const RESTART_PROBABILITY = 0.15;
const RANK_EPSILON = 1e-10;
const MAX_RANK_ITERATIONS = 100;
const MAX_COMMUNITY_ITERATIONS = 20;
const EMBEDDING_DIMENSIONS = 16;
const WALK_COUNT = 4;
const WALK_LENGTH = 8;
const CONTEXT_WINDOW = 2;

type Neighbor = { id: string; weight: number };
type RankResult = { scores: Map<string, number>; iterations: number };
type CommunityResult = { labels: Map<string, string>; iterations: number };
type EmbeddingMap = Map<string, number[]>;

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

function makeUndirectedAdjacency(nodes: readonly PersonalGraphNode[], edges: readonly PersonalGraphEdge[]) {
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

function rankGraph(
  ids: readonly string[],
  adjacency: Map<string, Neighbor[]>,
  teleport: Map<string, number>,
  continuationProbability: number,
): RankResult {
  if (!ids.length) return { scores: new Map(), iterations: 0 };
  let scores = new Map(ids.map(id => [id, teleport.get(id) ?? 0]));
  for (let iteration = 1; iteration <= MAX_RANK_ITERATIONS; iteration += 1) {
    const next = new Map(ids.map(id => [id, (1 - continuationProbability) * (teleport.get(id) ?? 0)]));
    let dangling = 0;
    for (const id of ids) {
      const neighbors = adjacency.get(id) ?? [];
      const totalWeight = neighbors.reduce((sum, neighbor) => sum + neighbor.weight, 0);
      const score = scores.get(id) ?? 0;
      if (totalWeight === 0) {
        dangling += score;
      } else {
        for (const neighbor of neighbors) {
          next.set(
            neighbor.id,
            (next.get(neighbor.id) ?? 0) + continuationProbability * score * (neighbor.weight / totalWeight),
          );
        }
      }
    }
    if (dangling > 0) {
      for (const id of ids) {
        next.set(id, (next.get(id) ?? 0) + continuationProbability * dangling * (teleport.get(id) ?? 0));
      }
    }
    let difference = 0;
    for (const id of ids) difference += Math.abs((next.get(id) ?? 0) - (scores.get(id) ?? 0));
    scores = next;
    if (difference <= RANK_EPSILON) return { scores, iterations: iteration };
  }
  return { scores, iterations: MAX_RANK_ITERATIONS };
}

function detectCommunities(nodes: readonly PersonalGraphNode[], adjacency: Map<string, Neighbor[]>): CommunityResult {
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

function graphEmbeddings(nodes: readonly PersonalGraphNode[], adjacency: Map<string, Neighbor[]>): EmbeddingMap {
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

function cosine(a: readonly number[], b: readonly number[]): number {
  return a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);
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
  const communities = detectCommunities(nodes, undirected);
  const embeddings = graphEmbeddings(nodes, undirected);
  const personalizedEmbedding = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const [id, weight] of ppr.scores) {
    const vector = embeddings.get(id);
    if (!vector) continue;
    for (let i = 0; i < vector.length; i += 1)
      personalizedEmbedding[i] = (personalizedEmbedding[i] ?? 0) + weight * (vector[i] ?? 0);
  }
  const norm = Math.sqrt(personalizedEmbedding.reduce((sum, value) => sum + value * value, 0));
  if (norm > 0) {
    for (let i = 0; i < personalizedEmbedding.length; i += 1)
      personalizedEmbedding[i] = (personalizedEmbedding[i] ?? 0) / norm;
  }
  const seeds = new Set(seedNodeIds);
  const scored = nodes
    .filter(node => !seeds.has(node.id))
    .map(node => {
      const personalizedRank = ppr.scores.get(node.id) ?? 0;
      const vector = embeddings.get(node.id) ?? [];
      const similarity = Math.max(0, cosine(personalizedEmbedding, vector));
      return {
        id: node.id,
        pageRank: pageRank.scores.get(node.id) ?? 0,
        personalizedRank,
        community: communities.labels.get(node.id) ?? node.id,
        recommendationScore: personalizedRank * 0.7 + similarity * 0.3,
      };
    })
    .sort((a, b) => b.recommendationScore - a.recommendationScore || a.id.localeCompare(b.id));
  return {
    algorithmVersion: 'personal-graph-v1',
    iterations: {
      pageRank: pageRank.iterations,
      personalizedPageRank: ppr.iterations,
      communities: communities.iterations,
    },
    nodes: scored.slice(0, limit),
  };
}
