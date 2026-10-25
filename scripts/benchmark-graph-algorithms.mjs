#!/usr/bin/env node
// Compares the personal graph's community detection and node embeddings,
// v1 (label propagation; hashed random-walk counts) against the candidates
// (Louvain; NetMF), on planted-partition graphs at the personal graph's cap:
// 1,000 nodes, about 2,400 links (each stored both ways: under the 5,000-edge
// cap), 20 communities, with the share of edges
// that cross communities ("mixing") from easy (0.1) to hard (0.6).
//
//   node scripts/benchmark-graph-algorithms.mjs
//
// Reports: NMI against the planted communities and modularity (communities);
// link-prediction AUC on 10% hidden edges (embeddings); median time of 5 runs;
// heap growth; and for recommendations, how often a seed's hidden neighbour
// is in the top 10 (v1's formula against the shipped v2), with the full
// analysis time. Planted structure says which method recovers structure better;
// it does not say how real personal graphs are shaped.
import { louvain, modularity, nmi } from '../apps/api/src/graph-communities.ts';
import { cosineOf, netmfEmbedding } from '../apps/api/src/graph-embedding.ts';
import {
  hashedWalkEmbeddings,
  holdOut,
  labelPropagation,
  linkPredictionAuc,
  plantedPartition,
} from '../apps/api/src/graph-evaluation.ts';
import { analyzePersonalGraph, makeUndirectedAdjacency, rankGraph } from '../apps/api/src/personal-graph-algorithms.ts';

const id = i => `n${String(i).padStart(4, '0')}`;
function asV1(n, edges) {
  const nodes = Array.from({ length: n }, (_, i) => ({ id: id(i), entityType: 'topic', category: 'x' }));
  return {
    nodes,
    adjacency: makeUndirectedAdjacency(
      nodes,
      edges.map(([a, b]) => ({ sourceNode: id(a), targetNode: id(b), weight: 1 })),
    ),
  };
}
function timed(f) {
  const times = [];
  let out;
  for (let r = 0; r < 5; r++) {
    const t = performance.now();
    out = f();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  return { out, ms: +times[2].toFixed(1) };
}
function heapGrowth(f) {
  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  const keep = f();
  const after = process.memoryUsage().heapUsed;
  return { keep, mb: +((after - before) / 1e6).toFixed(1) };
}

const n = 1000;
for (const mixing of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) {
  const g = plantedPartition(n, 20, 5, mixing, 1);
  const v1 = asV1(n, g.edges);

  const lp = timed(() => labelPropagation(v1.nodes, v1.adjacency));
  const lpLabels = Int32Array.from({ length: n }, (_, i) => Number(lp.out.labels.get(id(i)).slice(1)));
  const lv = timed(() => louvain(g.adjacency));

  const split = holdOut(n, g.edges, 0.1);
  const v1Split = asV1(n, split.kept);
  const hashed = timed(() => hashedWalkEmbeddings(v1Split.nodes, v1Split.adjacency));
  const learned = timed(() => netmfEmbedding(split.adjacency, { powerIterations: 2 }));
  const memory = heapGrowth(() => netmfEmbedding(split.adjacency, { powerIterations: 2 }));
  const aucHashed = linkPredictionAuc(n, g.edges, split.hidden, (a, b) =>
    cosineOf(hashed.out.get(id(a)), hashed.out.get(id(b))),
  );
  const aucLearned = linkPredictionAuc(n, g.edges, split.hidden, (a, b) => cosineOf(learned.out[a], learned.out[b]));

  // Recommendations: 100 hidden links, seed on one end; hit if the other end is in the top 10 of non-neighbours.
  const ids = v1Split.nodes.map(x => x.id).sort();
  const neighbours = split.adjacency.map(row => new Set(row.map(([j]) => id(j))));
  const both = split.kept.flatMap(([a, b]) => [
    { sourceNode: id(a), targetNode: id(b), weight: 1 },
    { sourceNode: id(b), targetNode: id(a), weight: 1 },
  ]);
  let v1Hits = 0;
  let v2Hits = 0;
  const v2Times = [];
  const trials = split.hidden.slice(0, 100);
  for (const [a, b] of trials) {
    const ppr = rankGraph(ids, v1Split.adjacency, new Map([[id(a), 1]]), 0.85).scores;
    const personal = new Array(16).fill(0);
    for (const [k, w] of ppr) hashed.out.get(k).forEach((x, c) => (personal[c] += w * x));
    const norm = Math.hypot(...personal) || 1;
    const v1 = ids
      .filter(k => k !== id(a) && !neighbours[a].has(k))
      .map(k => ({
        k,
        s:
          0.7 * ppr.get(k) +
          0.3 *
            Math.max(
              0,
              cosineOf(
                personal.map(x => x / norm),
                hashed.out.get(k),
              ),
            ),
      }))
      .sort((x, y) => y.s - x.s || x.k.localeCompare(y.k));
    if (v1.slice(0, 10).some(x => x.k === id(b))) v1Hits++;
    const t = performance.now();
    const v2 = analyzePersonalGraph(v1Split.nodes, both, [id(a)], 100).nodes.filter(x => !neighbours[a].has(x.id));
    v2Times.push(performance.now() - t);
    if (v2.slice(0, 10).some(x => x.id === id(b))) v2Hits++;
  }
  v2Times.sort((x, y) => x - y);
  const pct = q => +v2Times[Math.min(v2Times.length - 1, Math.floor(q * v2Times.length))].toFixed(1);

  console.log(
    JSON.stringify({
      mixing,
      edges: g.edges.length,
      communities: {
        labelPropagation: {
          nmi: +nmi(g.truth, lpLabels).toFixed(3),
          modularity: +modularity(g.adjacency, lpLabels).toFixed(3),
          found: new Set(lpLabels).size,
          ms: lp.ms,
        },
        louvain: {
          nmi: +nmi(g.truth, lv.out.community).toFixed(3),
          modularity: +lv.out.modularity.toFixed(3),
          found: new Set(lv.out.community).size,
          ms: lv.ms,
        },
        planted: { modularity: +modularity(g.adjacency, g.truth).toFixed(3) },
      },
      linkPredictionAuc: {
        hashedWalks: { auc: +aucHashed.toFixed(3), ms: hashed.ms },
        netmf: { auc: +aucLearned.toFixed(3), ms: learned.ms, heapMB: memory.mb },
      },
      recommendationsHitAt10: { v1: v1Hits / trials.length, v2: v2Hits / trials.length },
      v2AnalysisMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) },
    }),
  );
}
