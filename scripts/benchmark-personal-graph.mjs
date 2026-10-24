import { performance } from 'node:perf_hooks';
import { analyzePersonalGraph } from '../apps/api/src/personal-graph-algorithms.ts';

const nodeCount = 1000;
const edgeCount = 5000;
const nodes = Array.from({ length: nodeCount }, (_, index) => ({
  id: `node-${String(index).padStart(4, '0')}`,
  entityType: index % 3 === 0 ? 'topic' : 'question',
  category: index % 2 === 0 ? 'reading_history' : 'learning_expertise',
}));
let state = 0x6d2b79f5;
const next = () => {
  state = Math.imul(state ^ (state >>> 15), state | 1);
  state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
  return ((state ^ (state >>> 14)) >>> 0) / 0x1_0000_0000;
};
const edges = Array.from({ length: edgeCount }, (_, index) => {
  const source = index % nodeCount;
  let target = Math.floor(next() * nodeCount);
  if (target === source) target = (target + 1) % nodeCount;
  return { sourceNode: nodes[source].id, targetNode: nodes[target].id, weight: 0.1 + next() * 0.9 };
});
const seeds = nodes.slice(0, 10).map(node => node.id);
const durations = [];
for (let round = 0; round < 25; round += 1) {
  const start = performance.now();
  const result = analyzePersonalGraph(nodes, edges, seeds, 20);
  const elapsed = performance.now() - start;
  if (round >= 5) durations.push(elapsed);
  if (result.nodes.length !== 20) throw new Error('benchmark did not produce the requested candidate count');
}
durations.sort((a, b) => a - b);
const percentile = p => durations[Math.min(durations.length - 1, Math.ceil(durations.length * p) - 1)];
process.stdout.write(
  `${JSON.stringify({
    graph: { nodes: nodeCount, directedEdges: edgeCount },
    warmupRounds: 5,
    measuredRounds: durations.length,
    milliseconds: {
      p50: Number(percentile(0.5).toFixed(3)),
      p95: Number(percentile(0.95).toFixed(3)),
      p99: Number(percentile(0.99).toFixed(3)),
      max: Number(durations.at(-1).toFixed(3)),
    },
    processMaxRssKiB: process.resourceUsage().maxRSS,
  })}\n`,
);
