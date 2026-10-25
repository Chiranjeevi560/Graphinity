// The worker thread that runs personal graph analysis (ADR 0012).
import { afterEach, describe, expect, it } from 'vitest';
import { createGraphAnalyzer, GraphBusyError, type GraphAnalyzer } from '../src/graph-analyzer.ts';
import { analyzePersonalGraph } from '../src/personal-graph-algorithms.ts';

const nodes = ['a', 'b', 'c', 'd'].map(id => ({ id, entityType: 'topic', category: 'learning_expertise' }));
const edges = [
  { sourceNode: 'a', targetNode: 'b', weight: 1 },
  { sourceNode: 'b', targetNode: 'c', weight: 0.5 },
  { sourceNode: 'c', targetNode: 'a', weight: 1 },
];
const input = { nodes, edges, seedNodeIds: ['a'], limit: 20 };

let analyzer: GraphAnalyzer | undefined;
afterEach(async () => {
  await analyzer?.close();
});

describe('the graph worker', () => {
  it('gives exactly what analysing in-process gives', async () => {
    analyzer = createGraphAnalyzer();
    expect(await analyzer.analyze(input)).toEqual(analyzePersonalGraph(nodes, edges, ['a'], 20));
    expect(analyzer.depth()).toBe(0);
  });

  it('refuses work past its queue instead of letting it pile up, and carries on after', async () => {
    analyzer = createGraphAnalyzer({ maxWaiting: 1 });
    const first = analyzer.analyze(input);
    const second = analyzer.analyze(input);
    await expect(analyzer.analyze(input)).rejects.toBeInstanceOf(GraphBusyError);
    expect(analyzer.depth()).toBe(2);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    await expect(analyzer.analyze(input)).resolves.toMatchObject({ algorithmVersion: 'personal-graph-v2' });
  });

  it('reports a bad request as a range error and keeps serving', async () => {
    analyzer = createGraphAnalyzer();
    await expect(analyzer.analyze({ ...input, seedNodeIds: ['missing'] })).rejects.toThrow(RangeError);
    await expect(analyzer.analyze(input)).resolves.toMatchObject({ nodes: expect.any(Array) as unknown });
  });

  it('refuses input that can’t be sent to the worker without leaving it counted as waiting', async () => {
    analyzer = createGraphAnalyzer();
    const unsendable = { ...input, nodes: [{ ...nodes[0], extra: () => 1 }] } as unknown as typeof input;
    await expect(analyzer.analyze(unsendable)).rejects.toThrow();
    expect(analyzer.depth()).toBe(0);
  });

  it('fails what it holds when closed, and refuses new work', async () => {
    analyzer = createGraphAnalyzer();
    const running = analyzer.analyze(input);
    await analyzer.close();
    await expect(running).rejects.toThrow(/closed|stopped/);
    await expect(analyzer.analyze(input)).rejects.toThrow(/closed/);
  });
});
