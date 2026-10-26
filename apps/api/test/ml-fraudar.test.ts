import { describe, expect, it } from 'vitest';
import { denseBlocks, densestBlock, implicated, type BipartiteEdge } from '../src/ml/fraudar.ts';
import { seededRandom } from '../src/ml/linalg.ts';
import { must } from './helpers/must.ts';

/** Sparse honest activity among `n` accounts, plus a ring of `ring` accounts acting on each other. */
function world(n: number, ring: readonly number[], options: { camouflage?: number; seed?: number } = {}) {
  const r = seededRandom(options.seed ?? 1);
  const edges: BipartiteEdge[] = [];
  // Honest: each account acts on 3 others, popular ones more often (preferential).
  for (let s = 0; s < n; s++) for (let k = 0; k < 3; k++) edges.push({ source: s, target: Math.floor(n * r() ** 2) });
  for (const a of ring) for (const b of ring) if (a !== b) edges.push({ source: a, target: b, count: 2 });
  // Camouflage: ring members also act on popular honest accounts, spread thinly as real camouflage is.
  for (const a of ring) for (let k = 0; k < (options.camouflage ?? 0); k++) edges.push({ source: a, target: k % 30 });
  return edges;
}

const ring = [500, 501, 502, 503, 504, 505];

describe('Fraudar', () => {
  it('finds a planted ring in sparse honest activity', () => {
    const block = densestBlock(world(1000, ring));
    expect(block?.sources).toEqual(ring);
    expect(block?.targets).toEqual(ring);
    expect(block?.edges).toBe(ring.length * (ring.length - 1));
  });

  it('still isolates the ring when it hides among popular accounts, and never implicates them', () => {
    const edges = world(1000, ring, { camouflage: 30, seed: 2 });
    const block = densestBlock(edges);
    // Fraudar's guarantee: the accounts acting are exactly the ring.
    expect(new Set(block?.sources)).toEqual(new Set(ring));
    // The popular accounts it acted on as camouflage are acted on mostly by everyone else: never implicated.
    const flagged = implicated(must(block), edges);
    expect(new Set(flagged.targets)).toEqual(new Set(ring));
    // Any implicated account really is acted on mostly from inside the block.
    const inbound = (t: number) => edges.filter(e => e.target === t);
    for (const t of flagged.targets) {
      const all = inbound(t).reduce((n, e) => n + (e.count ?? 1), 0);
      const inside = inbound(t)
        .filter(e => ring.includes(e.source))
        .reduce((n, e) => n + (e.count ?? 1), 0);
      expect(inside / all).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('finds several rings in turn, and is deterministic', () => {
    const second = [700, 701, 702, 703];
    const edges = [
      ...world(1000, ring, { seed: 3 }),
      ...second.flatMap(a => second.filter(b => b !== a).map(b => ({ source: a, target: b, count: 2 }))),
    ];
    const blocks = denseBlocks(edges, 2);
    expect(blocks.map(b => b.sources)).toEqual([ring, second]);
    expect(denseBlocks(edges, 2)).toEqual(blocks);
  });

  it('answers nothing for no edges, and stops below a minimum density', () => {
    expect(densestBlock([])).toBeNull();
    expect(denseBlocks(world(300, []), 3, { minDensity: 1e6 })).toEqual([]);
  });
});
