// Graph algorithms v2 (ADR 0012) against ground truth: exact modularity on
// small graphs, planted communities, and links hidden from the algorithm.
import { describe, expect, it } from 'vitest';
import { connectedParts, louvain, modularity, nmi } from '../src/graph-communities.ts';
import { cosineOf, netmfEmbedding } from '../src/graph-embedding.ts';
import {
  hashedWalkEmbeddings,
  holdOut,
  labelPropagation,
  linkPredictionAuc,
  plantedPartition,
  toAdjacency,
} from '../src/graph-evaluation.ts';
import {
  analyzePersonalGraph,
  effectiveWeight,
  makeUndirectedAdjacency,
  rankGraph,
} from '../src/personal-graph-algorithms.ts';

const id = (i: number) => `n${String(i).padStart(4, '0')}`;
function asStrings(n: number, edges: ReadonlyArray<readonly [number, number]>) {
  const nodes = Array.from({ length: n }, (_, i) => ({
    id: id(i),
    entityType: 'topic',
    category: 'learning_expertise',
  }));
  const graphEdges = edges.map(([a, b]) => ({ sourceNode: id(a), targetNode: id(b), weight: 1 }));
  return { nodes, graphEdges, adjacency: makeUndirectedAdjacency(nodes, graphEdges) };
}

describe('modularity and NMI', () => {
  // Two triangles joined by one edge: m = 7, each side Σin = 6, Σtot = 7.
  const triangles = toAdjacency(6, [
    [0, 1],
    [1, 2],
    [0, 2],
    [3, 4],
    [4, 5],
    [3, 5],
    [2, 3],
  ]);

  it('matches the hand-computed value', () => {
    expect(modularity(triangles, [0, 0, 0, 1, 1, 1])).toBeCloseTo(2 * (6 / 14 - (7 / 14) ** 2), 12);
    expect(modularity(triangles, [0, 0, 0, 0, 0, 0])).toBeCloseTo(0, 12);
    expect(modularity(toAdjacency(3, []), [0, 1, 2])).toBe(0);
  });

  it('is 1 for the same partition under other names, and low for an unrelated one', () => {
    expect(nmi([0, 0, 1, 1, 2, 2], [5, 5, 9, 9, 7, 7])).toBeCloseTo(1, 12);
    expect(nmi([0, 0, 0, 1, 1, 1], [0, 1, 0, 1, 0, 1])).toBeLessThan(0.1);
    expect(nmi([], [])).toBe(0);
    expect(nmi([3, 3], [1, 1])).toBe(1);
  });
});

describe('Louvain', () => {
  it('finds the two triangles, deterministically, with the best modularity', () => {
    const triangles = toAdjacency(6, [
      [0, 1],
      [1, 2],
      [0, 2],
      [3, 4],
      [4, 5],
      [3, 5],
      [2, 3],
    ]);
    const result = louvain(triangles);
    expect([...result.community]).toEqual([0, 0, 0, 1, 1, 1]);
    expect(result.modularity).toBeCloseTo(5 / 14, 12);
    expect(louvain(triangles)).toEqual(result);
  });

  it('recovers planted communities exactly when they are clear', () => {
    const g = plantedPartition(1000, 20, 10, 0.1, 1);
    const result = louvain(g.adjacency);
    expect(nmi(g.truth, result.community)).toBeGreaterThan(0.99);
    expect(result.modularity).toBeGreaterThanOrEqual(modularity(g.adjacency, g.truth) - 1e-9);
  });

  it('still finds structure where label propagation (v1) merged everything into one community', () => {
    const g = plantedPartition(1000, 20, 10, 0.4, 1);
    const v1 = asStrings(1000, g.edges);
    const lp = labelPropagation(v1.nodes, v1.adjacency);
    expect(new Set(lp.labels.values()).size).toBe(1);
    expect(nmi(g.truth, louvain(g.adjacency).community)).toBeGreaterThan(0.7);
  });

  it('never returns a community split into unconnected parts, and gives isolated nodes their own', () => {
    const g = plantedPartition(300, 6, 6, 0.3, 4);
    const isolated = toAdjacency(303, g.edges);
    const { community } = louvain(isolated);
    for (const c of new Set(community)) {
      const members = [...community.keys()].filter(i => community[i] === c);
      const reached = new Set([members[0]]);
      const stack = [members[0] ?? 0];
      while (stack.length) {
        const i = stack.pop() ?? 0;
        for (const [j] of isolated[i] ?? [])
          if (community[j] === c && !reached.has(j)) {
            reached.add(j);
            stack.push(j);
          }
      }
      expect(reached.size).toBe(members.length);
    }
    expect(new Set([community[300], community[301], community[302]]).size).toBe(3);
  });

  it('splits a community whose members have no edges between them, which raises modularity', () => {
    // 0-1 and 2-3 are two pairs; a labelling that lumps all four together is split in two.
    const pairs = toAdjacency(4, [
      [0, 1],
      [2, 3],
    ]);
    const split = connectedParts(pairs, [0, 0, 0, 0]);
    expect([...split]).toEqual([0, 0, 1, 1]);
    expect(modularity(pairs, split)).toBeGreaterThan(modularity(pairs, [0, 0, 0, 0]));
  });

  it('handles a graph with no edges', () => {
    expect(louvain(toAdjacency(3, []))).toEqual({ community: Int32Array.from([0, 1, 2]), levels: 0, modularity: 0 });
  });
});

describe('NetMF embeddings', () => {
  it('predicts hidden links far better than v1’s hashed walk counts', () => {
    const g = plantedPartition(600, 12, 10, 0.3, 2);
    const split = holdOut(600, g.edges, 0.1);
    const learned = netmfEmbedding(split.adjacency, { powerIterations: 2 });
    const v1 = asStrings(600, split.kept);
    const hashed = hashedWalkEmbeddings(v1.nodes, v1.adjacency);
    const aucLearned = linkPredictionAuc(600, g.edges, split.hidden, (a, b) =>
      cosineOf(learned[a] ?? [], learned[b] ?? []),
    );
    const aucHashed = linkPredictionAuc(600, g.edges, split.hidden, (a, b) =>
      cosineOf(hashed.get(id(a)) ?? [], hashed.get(id(b)) ?? []),
    );
    expect(aucLearned).toBeGreaterThan(0.75);
    expect(aucLearned - aucHashed).toBeGreaterThan(0.15);
  });

  it('keeps its edge on hard graphs, where the log and a window over one step matter', () => {
    // Measured at 50% mixing: 0.68 as built; 0.60 without the log; 0.59 with a one-step window.
    const g = plantedPartition(600, 12, 10, 0.5, 3);
    const split = holdOut(600, g.edges, 0.1, 4);
    const learned = netmfEmbedding(split.adjacency, { powerIterations: 2 });
    const auc = linkPredictionAuc(600, g.edges, split.hidden, (a, b) => cosineOf(learned[a] ?? [], learned[b] ?? []));
    expect(auc).toBeGreaterThan(0.65);
  });

  it('gives unit vectors, zeros for a node with no edges, the same result every time, and copes with tiny graphs', () => {
    const adjacency = toAdjacency(5, [
      [0, 1],
      [1, 2],
      [2, 0],
      [2, 3],
    ]);
    const vectors = netmfEmbedding(adjacency);
    for (const i of [0, 1, 2, 3]) expect(Math.hypot(...(vectors[i] ?? []))).toBeCloseTo(1, 9);
    expect([...(vectors[4] ?? [])].every(x => x === 0)).toBe(true);
    expect(netmfEmbedding(adjacency)).toEqual(vectors);
    expect(netmfEmbedding(toAdjacency(2, [[0, 1]]))).toHaveLength(2);
    expect(netmfEmbedding([])).toEqual([]);
    expect(netmfEmbedding(toAdjacency(3, [])).every(v => v.every(x => x === 0))).toBe(true);
  });
});

describe('PageRank', () => {
  it('matches the hand-solved value, with a dead end’s rank passed on rather than lost', () => {
    // a → b, and b links nowhere. With x_a + x_b = 1: x_a = 0.075 + 0.425·x_b, so x_a = 0.5 / 1.425.
    const ids = ['a', 'b'];
    const adjacency = new Map([
      ['a', [{ id: 'b', weight: 1 }]],
      ['b', []],
    ]);
    const { scores } = rankGraph(ids, adjacency, new Map(ids.map(i => [i, 0.5])), 0.85);
    expect(scores.get('a')).toBeCloseTo(0.5 / 1.425, 9);
    expect((scores.get('a') ?? 0) + (scores.get('b') ?? 0)).toBeCloseTo(1, 9);
  });
});

describe('edge weights in analysis', () => {
  const now = new Date('2026-10-25T00:00:00Z');
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

  it('multiplies by confidence, halves observed behaviour every 90 days, and never fades what you entered', () => {
    expect(effectiveWeight({ weight: 0.8, confidence: 0.5, freshness: now, observed: false }, now)).toBeCloseTo(0.4);
    expect(effectiveWeight({ weight: 1, confidence: 1, freshness: daysAgo(90), observed: true }, now)).toBeCloseTo(0.5);
    expect(effectiveWeight({ weight: 1, confidence: 1, freshness: daysAgo(365), observed: true }, now)).toBeCloseTo(
      0.0601,
      3,
    );
    expect(effectiveWeight({ weight: 1, confidence: 1, freshness: daysAgo(365), observed: false }, now)).toBe(1);
    // A clock behind the database never makes an edge stronger than stored.
    expect(effectiveWeight({ weight: 1, confidence: 1, freshness: daysAgo(-5), observed: true }, now)).toBe(1);
  });
});

describe('recommendations', () => {
  it('rank a hidden neighbour higher than v1’s formula did', { timeout: 60_000 }, () => {
    const n = 300;
    const g = plantedPartition(n, 6, 10, 0.3, 6);
    const split = holdOut(n, g.edges, 0.1, 7);
    const { nodes, graphEdges } = asStrings(n, split.kept);
    const both = graphEdges.flatMap(e => [e, { sourceNode: e.targetNode, targetNode: e.sourceNode, weight: e.weight }]);
    const neighbours = split.adjacency.map(row => new Set(row.map(([j]) => id(j))));
    let hits = 0;
    const trials = split.hidden.slice(0, 40);
    for (const [a, b] of trials) {
      const ranked = analyzePersonalGraph(nodes, both, [id(a)], 100).nodes.filter(x => !neighbours[a]?.has(x.id));
      if (ranked.slice(0, 10).some(x => x.id === id(b))) hits++;
    }
    // v1 found 3.5% of hidden links in its top 10 on graphs like this (benchmark); v2 must do far better.
    expect(hits / trials.length).toBeGreaterThan(0.1);
  });
});
