import { describe, expect, it } from 'vitest';
import { seededRandom } from '../src/ml/linalg.ts';
import {
  applySwap,
  chooseSwap,
  clickWeight,
  estimatePropensities,
  MAX_WEIGHT,
  MIN_CLICKS,
  SWAP_DEPTH,
  SWAP_SHARE,
  type LoggedSearch,
} from '../src/search/interventions.ts';

/** Searches under the position-based model with examination k^-eta, swaps as production chooses them. */
function simulate(count: number, eta: number, seed: number): LoggedSearch[] {
  const r = seededRandom(seed);
  return Array.from({ length: count }, () => {
    // Attractiveness falls with the ranker's order, so the ranker is decent but not perfect.
    const attract = Array.from({ length: 10 }, (_, i) => 0.9 / (1 + i * 0.3));
    const swap = chooseSwap(r, 10);
    const order = applySwap(
      attract.map((_, i) => i + 1),
      swap,
    );
    return {
      swap,
      results: order.map((ranked, i) => ({
        ranked,
        shown: i + 1,
        clicked: r() < (i + 1) ** -eta * (attract[ranked - 1] ?? 0),
      })),
    };
  });
}

describe('position interventions', () => {
  it('swaps one neighbouring pair among the top five, on about the disclosed share', () => {
    const r = seededRandom(1);
    const picks = Array.from({ length: 20_000 }, () => chooseSwap(r, 20));
    const swapped = picks.filter((p): p is number => p !== null);
    expect(swapped.length / picks.length).toBeCloseTo(SWAP_SHARE, 2);
    expect(new Set(swapped)).toEqual(new Set([1, 2, 3, 4]));
    expect(swapped.every(k => k + 1 <= SWAP_DEPTH)).toBe(true);
    expect(chooseSwap(() => 0, 1)).toBeNull();
    expect(chooseSwap(() => 0, 2)).toBe(1);
    expect(applySwap(['a', 'b', 'c'], 2)).toEqual(['a', 'c', 'b']);
    expect(applySwap(['a', 'b', 'c'], null)).toEqual(['a', 'b', 'c']);
    expect(applySwap(['a', 'b'], 2)).toEqual(['a', 'b']);
  });

  it('recovers how much each position is looked at, whatever the results’ own pull', () => {
    for (const eta of [0.5, 1, 1.5]) {
      const p = estimatePropensities(simulate(60_000, eta, 2));
      expect(p).not.toBeNull();
      expect(p?.eta ?? 0).toBeCloseTo(eta, 1);
      for (let k = 1; k <= 5; k++) expect(p?.theta[k - 1] ?? 0).toBeCloseTo(k ** -eta, 1);
      expect(p?.theta).toHaveLength(20);
      // Past the measured positions, the fitted power law.
      expect(p?.theta[19] ?? 0).toBeCloseTo(20 ** -(p?.eta ?? 0), 6);
    }
  });

  it('refuses to guess with too few clicks', () => {
    expect(estimatePropensities(simulate(200, 1, 3))).toBeNull();
    expect(estimatePropensities([])).toBeNull();
    // Every count present but below MIN_CLICKS: still too few to trust.
    const few = (clicks: number): LoggedSearch[] =>
      [1, 2, 3, 4].flatMap(k =>
        Array.from({ length: clicks }, () => [
          {
            swap: null,
            results: [
              { ranked: k, shown: k, clicked: true },
              { ranked: k + 1, shown: k + 1, clicked: true },
            ],
          },
          {
            swap: k,
            results: [
              { ranked: k + 1, shown: k, clicked: true },
              { ranked: k, shown: k + 1, clicked: true },
            ],
          },
        ]).flat(),
      );
    expect(estimatePropensities(few(MIN_CLICKS - 1))).toBeNull();
    expect(estimatePropensities(few(MIN_CLICKS))).not.toBeNull();
  });

  it('weights a click by the inverse of its position’s examination, clipped', () => {
    const p = { theta: [1, 0.5, 0.25, 0.05], eta: 1, evidence: [] };
    expect(clickWeight(p, 1)).toBe(1);
    expect(clickWeight(p, 2)).toBe(2);
    expect(clickWeight(p, 4)).toBe(MAX_WEIGHT);
    expect(clickWeight(p, 30)).toBe(MAX_WEIGHT);
  });
});
