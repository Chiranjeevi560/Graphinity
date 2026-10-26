import { describe, expect, it } from 'vitest';
import {
  CLIP,
  cellKey,
  cellUniform,
  cellsPerPerson,
  EPSILON_PER_METRIC,
  laplace,
  noisyCount,
  privateCells,
  releaseCost,
  type TrueCell,
} from '../src/ads/privacy.ts';

const secret = Buffer.alloc(32, 7);
const other = Buffer.alloc(32, 8);

describe('noise', () => {
  it('is the same for the same cell and secret, and different otherwise', () => {
    const key = cellKey('1', 'day', '2026-10-20', '2026-10-20');
    expect(noisyCount(500, 'impressions', secret, key)).toBe(noisyCount(500, 'impressions', secret, key));
    const draws = new Set(
      ['a', 'b', 'c', 'd', 'e', 'f'].map(v => noisyCount(500, 'impressions', secret, cellKey('1', 'country', 'x', v))),
    );
    expect(draws.size).toBeGreaterThan(1);
    expect(cellUniform(secret, key)).not.toBe(cellUniform(other, key));
  });

  it('is uniform in (0, 1), and Laplace with the right scale', () => {
    const n = 40_000;
    const us = Array.from({ length: n }, (_, i) => cellUniform(secret, String(i)));
    expect(Math.min(...us)).toBeGreaterThan(0);
    expect(Math.max(...us)).toBeLessThan(1);
    const mean = us.reduce((s, u) => s + u, 0) / n;
    expect(mean).toBeCloseTo(0.5, 2);
    // Laplace(0, b): mean 0, mean |x| = b, variance 2b².
    const xs = us.map(u => laplace(5, u));
    const m = xs.reduce((s, x) => s + x, 0) / n;
    const abs = xs.reduce((s, x) => s + Math.abs(x), 0) / n;
    const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / n;
    expect(Math.abs(m)).toBeLessThan(0.15);
    expect(abs).toBeCloseTo(5, 0);
    expect(variance / 50).toBeCloseTo(1, 1);
    expect(laplace(1, 0.5)).toBe(-0);
  });

  it('never gives a negative count, and scales with clipping over ε', () => {
    expect(noisyCount(0, 'clicks', secret, 'k')).toBeGreaterThanOrEqual(0);
    const spread = (metric: 'impressions' | 'conversions') => {
      let s = 0;
      for (let i = 0; i < 4000; i++) s += Math.abs(noisyCount(10_000, metric, secret, String(i)) - 10_000);
      return s / 4000;
    };
    // Mean absolute noise is Δ/ε: 100 for impressions, 5 for conversions.
    expect(spread('impressions') / (CLIP.impressions / EPSILON_PER_METRIC)).toBeCloseTo(1, 1);
    expect(spread('conversions') / (CLIP.conversions / EPSILON_PER_METRIC)).toBeCloseTo(1, 0);
  });
});

describe('cells', () => {
  const cell = (over: Partial<TrueCell>): TrueCell => ({
    value: 'IN',
    day: '2026-10-20',
    people: 40,
    impressions: 2000,
    clicks: 60,
    conversions: 5,
    ...over,
  });

  it('are shown only with 25 people and 50 impressions behind them', () => {
    const shown = privateCells(
      '1',
      'country',
      [cell({}), cell({ value: 'US', people: 24 }), cell({ value: 'GB', impressions: 3 })],
      secret,
    );
    expect(shown.cells.map(c => c.value)).toEqual(['IN']);
    expect(shown.suppressed).toBe(2);
    const [c] = shown.cells;
    expect(Math.abs((c?.impressions ?? 0) - 2000)).toBeLessThan(1000);
  });

  it('cost ε by how many cells one person can be in', () => {
    expect([cellsPerPerson('day', 0), cellsPerPerson('country', 3), cellsPerPerson('placement', 0)]).toEqual([1, 1, 2]);
    expect([cellsPerPerson('audience', 0), cellsPerPerson('audience', 3)]).toEqual([1, 3]);
    expect([releaseCost('day', 0), releaseCost('placement', 0), releaseCost('audience', 3)]).toEqual([0.6, 1.2, 1.8]);
  });
});
