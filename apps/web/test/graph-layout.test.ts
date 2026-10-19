import { describe, expect, it } from 'vitest';
import { edgeAt, layout, nodeAt, seededRandom } from '../src/lib/graph-layout.ts';
import { must } from './must.ts';

const field = (slug: string, members: number) => ({ slug, name: slug, members });
const fields = [
  { slug: 'watches-luxury', name: 'Watches', members: 40 },
  { slug: 'imports-customs', name: 'Imports & Customs', members: 20 },
  { slug: 'travel', name: 'Travel', members: 5 },
  { slug: 'fitness', name: 'Fitness', members: 0 },
];
const people = [...Array.from({ length: 30 }, () => [0]), ...Array.from({ length: 10 }, () => [1]), [0, 1], [2]];
const W = 360;
const H = 300;

describe('laying out the graph', () => {
  it('is the same every time for the same data', () => {
    expect(layout({ fields, people }, W, H)).toEqual(layout({ fields, people }, W, H));
  });

  it('keeps every person inside the box', () => {
    for (const n of layout({ fields, people }, W, H).nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(W);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeLessThanOrEqual(H);
    }
  });

  it('puts the biggest field nearest the middle, and sizes clusters by members', () => {
    const { clusters } = layout({ fields, people }, W, H);
    const dist = (i: number) => Math.hypot(must(clusters[i]).x - W / 2, must(clusters[i]).y - H / 2);
    expect(dist(0)).toBeLessThan(dist(1));
    expect(dist(1)).toBeLessThan(dist(2));
    expect(must(clusters[0]).r).toBeGreaterThan(must(clusters[2]).r);
  });

  it('centres a graph with only one field in use', () => {
    const one = layout(
      { fields: [field('a', 0), field('b', 9), field('c', 0)], people: Array.from({ length: 9 }, () => [1]) },
      W,
      H,
    );
    expect(must(one.clusters[1]).x).toBeCloseTo(W / 2, 0);
    expect(Math.abs(must(one.clusters[1]).y - H / 2)).toBeLessThan(H * 0.1);
  });

  it('places someone who knows two fields between them, a bridge', () => {
    const { clusters, nodes } = layout({ fields, people }, W, H);
    const bridge = must(nodes.find(n => n.fields.length === 2));
    const [a, b] = [must(clusters[0]), must(clusters[1])];
    const span = Math.hypot(a.x - b.x, a.y - b.y);
    expect(Math.hypot(bridge.x - a.x, bridge.y - a.y)).toBeLessThan(span);
    expect(Math.hypot(bridge.x - b.x, bridge.y - b.y)).toBeLessThan(span);
  });

  it('links only people who share a field, a few each', () => {
    const { nodes, edges } = layout({ fields, people }, W, H);
    for (const e of edges) {
      const [a, b] = [must(nodes[e.a]), must(nodes[e.b])];
      expect(a.fields.some(f => b.fields.includes(f))).toBe(true);
    }
    expect(edges.length).toBeLessThanOrEqual(nodes.length * 2 * 2);
    // The one person in Travel has nobody to link to.
    const loner = nodes.findIndex(n => n.fields[0] === 2);
    expect(edges.some(e => e.a === loner || e.b === loner)).toBe(false);
  });

  it('adds the viewer as one more, bigger node in their fields', () => {
    const { nodes } = layout({ fields, people }, W, H, { you: [1] });
    expect(nodes).toHaveLength(people.length + 1);
    const you = must(nodes.at(-1));
    expect(you.you).toBe(true);
    expect(you.fields).toEqual([1]);
    expect(nodes.filter(n => n.you)).toHaveLength(1);
    expect(you.size).toBeGreaterThan(Math.max(...nodes.filter(n => !n.you).map(n => n.size)));
  });

  it('draws nothing it has no data for, and survives an empty graph', () => {
    expect(layout({ fields: [], people: [] }, W, H)).toEqual({ clusters: [], nodes: [], edges: [] });
    expect(layout({ fields, people: [[7]] }, W, H).nodes).toEqual([]);
  });
});

describe('motion', () => {
  it('wanders a few pixels around the resting place, and never jumps', () => {
    const node = must(layout({ fields, people }, W, H).nodes[0]);
    for (let t = 0; t < 120; t += 0.5) {
      const p = nodeAt(node, t);
      expect(Math.hypot(p.x - node.x, p.y - node.y)).toBeLessThanOrEqual(node.amp * Math.SQRT2 + 1e-9);
      const next = nodeAt(node, t + 1 / 60);
      expect(Math.hypot(next.x - p.x, next.y - p.y)).toBeLessThan(0.2);
    }
  });

  it('fades links fully in and out, smoothly', () => {
    const edge = must(layout({ fields, people }, W, H).edges[0]);
    const seen = Array.from({ length: 600 }, (_, i) => edgeAt(edge, i / 10));
    expect(Math.min(...seen)).toBe(0);
    expect(Math.max(...seen)).toBeGreaterThan(0.99);
  });

  it('draws the same random numbers from the same seed', () => {
    const a = seededRandom(7),
      b = seededRandom(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(seededRandom(8)()).not.toBe(seededRandom(7)());
  });
});
