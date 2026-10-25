import { describe, expect, it } from 'vitest';
import { analyzePersonalGraph } from '../src/personal-graph-algorithms.ts';

const nodes = ['a', 'b', 'c', 'd'].map(id => ({ id, entityType: 'topic', category: 'learning_expertise' }));
const edges = [
  { sourceNode: 'a', targetNode: 'b', weight: 1 },
  { sourceNode: 'b', targetNode: 'c', weight: 1 },
  { sourceNode: 'c', targetNode: 'b', weight: 1 },
];

describe('personal graph algorithms', () => {
  it('computes deterministic global rank, personalized rank, communities, and graph recommendations', () => {
    const result = analyzePersonalGraph(nodes, edges, ['a']);
    const byId = new Map(result.nodes.map(node => [node.id, node]));
    expect(result.algorithmVersion).toBe('personal-graph-v2');
    expect([...result.nodes].every(node => node.pageRank >= 0 && node.personalizedRank >= 0)).toBe(true);
    expect(byId.get('b')?.personalizedRank).toBeGreaterThan(byId.get('d')?.personalizedRank ?? 0);
    expect(byId.get('b')?.community).toBe(byId.get('c')?.community);
    expect(byId.get('d')?.community).not.toBe(byId.get('b')?.community);
    expect(result.nodes.some(node => node.id === 'a')).toBe(false);
    expect(analyzePersonalGraph(nodes, edges, ['a'])).toEqual(result);
  });

  it('rejects missing, duplicate, or out-of-graph seeds and unbounded inputs', () => {
    expect(() => analyzePersonalGraph(nodes, edges, [])).toThrow(/seed nodes/);
    expect(() => analyzePersonalGraph(nodes, edges, ['a', 'a'])).toThrow(/distinct/);
    expect(() => analyzePersonalGraph(nodes, edges, ['missing'])).toThrow(/distinct/);
    expect(() => analyzePersonalGraph(nodes, edges, ['a'], 101)).toThrow(/limit/);
    expect(() =>
      analyzePersonalGraph(
        Array.from({ length: 1001 }, (_, index) => ({
          id: String(index),
          entityType: 'topic',
          category: 'learning_expertise',
        })),
        [],
        ['0'],
      ),
    ).toThrow(/limited/);
  });
});
