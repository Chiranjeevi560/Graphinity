import { describe, expect, it } from 'vitest';
import { paced, runAuction, shrunkCtr, type Candidate } from '../src/ads/auction.ts';
import { seededRandom } from '../src/ml/linalg.ts';

const rules = { slots: 2, reserveMicros: 10_000 };
const ad = (campaignId: string, maxCpcMicros: number, ctr: number, creativeId = `${campaignId}-1`): Candidate => ({
  campaignId,
  creativeId,
  maxCpcMicros,
  ctr,
});

describe('the auction', () => {
  it('ranks by value, not bid alone, and charges the second price', () => {
    // a: 1,000,000 x 0.02 = 20,000; b: 2,000,000 x 0.005 = 10,000; c: 500,000 x 0.01 = 5,000.
    const wins = runAuction([ad('b', 2_000_000, 0.005), ad('a', 1_000_000, 0.02), ad('c', 500_000, 0.01)], rules);
    expect(wins.map(w => w.campaignId)).toEqual(['a', 'b']);
    // a pays what keeps it above b: 10,000 / 0.02 + 1 = 500,001.
    expect(wins[0]?.priceMicros).toBe(500_001);
    // b pays what keeps it above c: 5,000 / 0.005 + 1 = 1,000,001.
    expect(wins[1]?.priceMicros).toBe(1_000_001);
  });

  it('never charges more than the bid, nor less than the reserve', () => {
    const [only] = runAuction([ad('a', 50_000, 0.02)], rules);
    expect(only?.priceMicros).toBe(rules.reserveMicros);
    const wins = runAuction([ad('a', 1_000_000, 0.01), ad('b', 1_000_000, 0.01)], rules);
    expect(wins.every(w => w.priceMicros <= 1_000_000 && w.priceMicros >= rules.reserveMicros)).toBe(true);
  });

  it('leaves out bids under the reserve and ads with no chance of a click, and shows each campaign once', () => {
    const wins = runAuction(
      [
        ad('a', 5_000, 0.5),
        ad('b', 1_000_000, 0),
        ad('c', 1_000_000, Number.NaN),
        ad('d', 100_000, 0.1, 'd-1'),
        ad('d', 90_000, 0.1, 'd-2'),
      ],
      { slots: 5, reserveMicros: 10_000 },
    );
    expect(wins.map(w => [w.campaignId, w.creativeId])).toEqual([['d', 'd-1']]);
  });

  it('is the same whatever order the candidates arrive in', () => {
    const r = seededRandom(5);
    const candidates = Array.from({ length: 30 }, (_, i) =>
      ad(`c${String(i)}`, 10_000 + Math.floor(r() * 2_000_000), r() * 0.05),
    );
    const once = runAuction(candidates, { slots: 4, reserveMicros: 10_000 });
    for (let t = 0; t < 20; t++) {
      const shuffled = [...candidates].sort(() => r() - 0.5);
      expect(runAuction(shuffled, { slots: 4, reserveMicros: 10_000 })).toEqual(once);
    }
  });

  it('charges each winner no more than its bid and exactly enough to keep its place (property, 500 auctions)', () => {
    const r = seededRandom(9);
    for (let t = 0; t < 500; t++) {
      const candidates = Array.from({ length: 2 + Math.floor(r() * 10) }, (_, i) =>
        ad(`c${String(i)}`, 10_000 + Math.floor(r() * 3_000_000), 0.001 + r() * 0.05),
      );
      const wins = runAuction(candidates, { slots: 3, reserveMicros: 10_000 });
      const ranked = [...candidates].sort((a, b) => b.maxCpcMicros * b.ctr - a.maxCpcMicros * a.ctr);
      wins.forEach((w, i) => {
        const me = ranked[i];
        const next = ranked[i + 1];
        expect(w.priceMicros).toBeLessThanOrEqual(me?.maxCpcMicros ?? 0);
        // At its price, its value still beats the next ad's: it kept its place.
        if (next) expect(w.priceMicros * w.ctr).toBeGreaterThanOrEqual(next.maxCpcMicros * next.ctr);
        // One unit less would not have (unless the bid or reserve bound it).
        if (next && w.priceMicros < (me?.maxCpcMicros ?? 0) && w.priceMicros > 10_000)
          expect((w.priceMicros - 1) * w.ctr).toBeLessThanOrEqual(next.maxCpcMicros * next.ctr);
      });
    }
  });
});

describe('click rates', () => {
  it('start at the prior and move toward what was seen as evidence grows', () => {
    expect(shrunkCtr(0, 0, 0.02, 100)).toBeCloseTo(0.02, 12);
    expect(shrunkCtr(1, 2, 0.02, 100)).toBeCloseTo((2 + 1) / 102, 12);
    expect(shrunkCtr(500, 10_000, 0.02, 100)).toBeCloseTo(0.0497, 3);
    // Nonsense counts are bounded rather than trusted.
    expect(shrunkCtr(9, 3, 0.02, 100)).toBeCloseTo((2 + 3) / 103, 12);
  });
});

describe('pacing', () => {
  it('spreads a day’s budget over the day, with a little room, and never past it', () => {
    expect(paced(0, 1_000_000, 0)).toBe(true);
    expect(paced(150_000, 1_000_000, 0.05)).toBe(false);
    expect(paced(140_000, 1_000_000, 0.05)).toBe(true);
    expect(paced(999_999, 1_000_000, 1)).toBe(true);
    expect(paced(1_000_000, 1_000_000, 1)).toBe(false);
    expect(paced(0, 1_000_000, 2)).toBe(true);
  });
});
