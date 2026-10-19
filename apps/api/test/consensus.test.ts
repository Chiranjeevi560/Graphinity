import { describe, expect, it } from 'vitest';
import { amountsIn, claimWeight, consensus, reportedAmount, type Claim } from '../src/consensus.ts';

const inr = (rupees: number) => ({ minor: rupees * 100, currency: 'INR' as const });

describe('reading amounts the way people write them', () => {
  it('understands Indian and Western grouping, words and symbols', () => {
    expect(amountsIn('Paid ₹1,40,000 at Chennai').map(a => a.minor)).toEqual([14_000_000]);
    expect(amountsIn('about Rs 95000 in duty').map(a => a.minor)).toEqual([9_500_000]);
    expect(amountsIn('roughly 95k INR')).toMatchObject([{ minor: 9_500_000, currency: 'INR' }]);
    expect(amountsIn('1.4 lakh rupees')).toMatchObject([{ minor: 14_000_000, currency: 'INR' }]);
    expect(amountsIn('$1,200.50 at JFK')).toMatchObject([{ minor: 120_050, currency: 'USD' }]);
    expect(amountsIn('£300')).toMatchObject([{ currency: 'GBP' }]);
  });

  it('ignores numbers that aren’t money: years, counts, durations', () => {
    expect(amountsIn('In 2025 it took 5 days and 3 forms')).toEqual([]);
  });

  it('picks the amount that was paid, not the price of the item', () => {
    expect(reportedAmount('Imported a watch valued at ₹2,95,000 through Chennai. Paid ₹94,800 total including the courier fee.')).toEqual(inr(94_800));
    expect(reportedAmount('The duty came to ₹95,000 on a ₹3,00,000 watch.')).toEqual(inr(95_000));
  });

  it('falls back to the last amount mentioned, and to nothing when there is none', () => {
    expect(reportedAmount('First quote ₹80,000, final ₹92,000')).toEqual(inr(92_000));
    expect(reportedAmount('It cleared smoothly, no issues at all.')).toBeNull();
  });
});

describe('agreement among answers (the spec’s own example)', () => {
  // 7 near ₹95,000, 2 near ₹80,000, 1 at ₹1,40,000, everyone equally trusted.
  const claims: Claim[] = [
    ...[92_000, 93_500, 94_000, 95_000, 95_500, 96_000, 98_000].map((r, i) => ({ answerId: `maj${String(i)}`, amount: inr(r), reputation: 0.5, trust: 0.5 })),
    { answerId: 'mid0', amount: inr(80_000), reputation: 0.5, trust: 0.5 },
    { answerId: 'mid1', amount: inr(81_000), reputation: 0.9, trust: 0.9 },
    { answerId: 'out', amount: inr(140_000), reputation: 0.5, trust: 0.5 },
  ];
  const result = consensus(claims);

  it('groups ₹92,000–₹98,000 together and keeps ₹80,000 and ₹1,40,000 apart', () => {
    expect(result.clusters.map(c => [c.lowMinor / 100, c.highMinor / 100, c.answerIds.length])).toEqual([
      [92_000, 98_000, 7],
      [80_000, 81_000, 2],
      [140_000, 140_000, 1],
    ]);
  });

  it('weighs groups by standing, not headcount, and the shares add to 1', () => {
    const [major, middle] = result.clusters;
    expect(result.clusters.reduce((s, c) => s + c.mass, 0)).toBeCloseTo(1, 10);
    // One very trusted person counts for more than one average one.
    expect(middle?.mass ?? 0).toBeGreaterThan(2 / 10);
    expect(major?.mass ?? 0).toBeGreaterThan(0.5);
  });

  it('pins the strongest answer of every smaller group, so edge cases stay visible', () => {
    expect(result.minorityPinned).toEqual(['mid1', 'out']);
  });

  it('measures agreement by entropy: split views mean low confidence', () => {
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThan(0.5);
    const unanimous = consensus(claims.slice(0, 7));
    expect(unanimous.confidence).toBe(1);
    expect(unanimous.minorityPinned).toEqual([]);
    const even = consensus([
      { answerId: 'a', amount: inr(10_000), reputation: 0.5, trust: 0.5 },
      { answerId: 'b', amount: inr(50_000), reputation: 0.5, trust: 0.5 },
    ]);
    expect(even.confidence).toBeCloseTo(0, 10);
  });

  it('never compares amounts in different currencies', () => {
    const mixed = consensus([
      { answerId: 'r', amount: inr(95_000), reputation: 0.5, trust: 0.5 },
      { answerId: 'd', amount: { minor: 95_000 * 100, currency: 'USD' }, reputation: 0.5, trust: 0.5 },
    ]);
    expect(mixed.clusters).toHaveLength(2);
  });

  it('has nothing to say about no claims, and survives zero trust', () => {
    expect(consensus([])).toEqual({ clusters: [], confidence: 0, minorityPinned: [] });
    const untrusted = consensus([{ answerId: 'x', amount: inr(1), reputation: 0, trust: 0 }]);
    expect(untrusted.clusters[0]?.mass).toBe(1);
  });

  it('weighs a claim (0.5 + 0.5·reputation) × trust, and clamps nonsense', () => {
    expect(claimWeight({ reputation: 1, trust: 1 })).toBe(1);
    expect(claimWeight({ reputation: 0, trust: 1 })).toBe(0.5);
    expect(claimWeight({ reputation: Number.NaN, trust: 2 })).toBe(0.5);
  });
});
