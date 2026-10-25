// The worker thread graph-analyzer.ts starts: runs analyses one message at a
// time, off the server's main thread.
import { parentPort } from 'node:worker_threads';
import type { GraphAnalysisInput } from './graph-analyzer.ts';
import { analyzePersonalGraph } from './personal-graph-algorithms.ts';

if (!parentPort) throw new Error('graph-worker.ts runs only as a worker thread');
const port = parentPort;
port.on('message', ({ id, input }: { id: number; input: GraphAnalysisInput }) => {
  try {
    port.postMessage({
      id,
      ok: true,
      insights: analyzePersonalGraph(input.nodes, input.edges, input.seedNodeIds, input.limit),
    });
  } catch (err) {
    port.postMessage({ id, ok: false, error: err instanceof Error ? err.message : 'graph analysis failed' });
  }
});
