import { describe, expect, it } from 'vitest';
import type { Win } from '../src/ads/auction.ts';
import { cpmOf, eid, floors, merge, microsOfCpm, PRICE_INCREMENT } from '../src/ads/rtb.ts';

// Own winners worth 50 and 20 per thousand impressions (value is micro-units per impression).
const own = (id: string, cpm: number): Win => ({
  campaignId: id,
  creativeId: `${id}-1`,
  priceMicros: 1_000_000,
  value: cpm * 1000,
  ctr: 0.02,
});
const bid = (partner: string, impid: string, price: number) => ({
  partner,
  impid,
  price,
  headline: 'h',
  body: 'b',
  url: 'https://x.example/',
  domain: 'x.example',
  creative: 'c',
  seat: 's',
});

describe('outside bids', () => {
  it('floor each slot at what our own ad earns there, or the reserve', () => {
    expect(floors([own('a', 50), own('b', 20)], 3, 0.2)).toEqual([50, 20, 0.2]);
    expect(cpmOf(microsOfCpm(12.34))).toBeCloseTo(12.34, 9);
  });

  it('take a slot only by beating its floor, paying the second price plus a hundredth', () => {
    const wins = [own('a', 50), own('b', 20)];
    const f = floors(wins, 2, 0.2);
    // Too low for slot 1; enough for slot 2, against a second bid of 25.
    const out = merge(wins, [bid('p1', '1', 49), bid('p1', '2', 30), bid('p2', '2', 25)], f);
    expect(out.map(o => (o.kind === 'own' ? o.win.campaignId : o.bid.partner))).toEqual(['a', 'p1']);
    const second = out[1];
    expect(second?.kind === 'partner' && second.priceMicros).toBe(microsOfCpm(25 + PRICE_INCREMENT));
  });

  it('move our ads down a slot when a partner takes the first, flooring the next at the displaced ad', () => {
    const wins = [own('a', 50), own('b', 20)];
    const f = floors(wins, 2, 0.2);
    // p1 wins slot 1 alone: pays the floor plus a hundredth. For slot 2, "a" (worth 50) is what
    // a partner would displace: p2's 30 isn't enough.
    const out = merge(wins, [bid('p1', '1', 80), bid('p2', '2', 30)], f);
    expect(out.map(o => (o.kind === 'own' ? o.win.campaignId : o.bid.partner))).toEqual(['p1', 'a']);
    const first = out[0];
    expect(first?.kind === 'partner' && first.priceMicros).toBe(microsOfCpm(50 + PRICE_INCREMENT));
  });

  it('let a partner fill one slot at most, and never pay more than it bid', () => {
    const out = merge([], [bid('p1', '1', 5), bid('p1', '2', 5)], [0.2, 0.2]);
    expect(out).toHaveLength(1);
    const [only] = out;
    expect(only?.kind === 'partner' && only.priceMicros).toBe(microsOfCpm(0.2 + PRICE_INCREMENT));
    const close = merge([], [bid('p1', '1', 0.205)], [0.2]);
    expect(close[0]?.kind === 'partner' && close[0].priceMicros).toBe(microsOfCpm(0.205));
  });
});

describe('extended ids', () => {
  const secret = Buffer.alloc(32, 1);
  const at = Date.UTC(2026, 9, 27);
  it('are stable within a month, and change with the month, the identity and the device', () => {
    const base = eid(secret, 'ad-1', at, 'dev-1');
    expect(base).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(eid(secret, 'ad-1', at + 86_400_000, 'dev-1')).toBe(base);
    expect(eid(secret, 'ad-1', Date.UTC(2026, 10, 1), 'dev-1')).not.toBe(base);
    expect(eid(secret, 'ad-2', at, 'dev-1')).not.toBe(base);
    expect(eid(secret, 'ad-1', at, 'dev-2')).not.toBe(base);
    expect(eid(secret, 'ad-1', at, null)).not.toBe(base);
    expect(eid(Buffer.alloc(32, 2), 'ad-1', at, 'dev-1')).not.toBe(base);
  });
});
