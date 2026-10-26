import { describe, expect, it } from 'vitest';
import {
  attribute,
  HALF_LIFE_MS,
  MAX_SHAPLEY_CAMPAIGNS,
  ruleCredit,
  shapleyModel,
  type Path,
} from '../src/ads/attribution.ts';
import { heldOut, lift } from '../src/ads/lift.ts';
import { campaignReport } from '../src/routes/ad-measurement.ts';

const DAY = 86_400_000;
const path = (campaigns: string[], converted = true, gapDays = 1): Path => ({
  touches: campaigns.map((campaign, i) => ({ campaign, at: i * gapDays * DAY })),
  converted,
  at: campaigns.length * gapDays * DAY,
});

describe('rule-based attribution', () => {
  const p = path(['a', 'b', 'c', 'd']);
  it('gives each model’s split, always summing to one', () => {
    expect([...ruleCredit(p, 'last_click')]).toEqual([['d', 1]]);
    expect([...ruleCredit(p, 'first_touch')]).toEqual([['a', 1]]);
    expect(ruleCredit(p, 'linear').get('b')).toBeCloseTo(0.25, 12);
    const pos = ruleCredit(p, 'position');
    expect([pos.get('a'), pos.get('b'), pos.get('c'), pos.get('d')]).toEqual([0.4, 0.1, 0.1, 0.4]);
    for (const m of ['last_click', 'first_touch', 'linear', 'time_decay', 'position'] as const)
      expect([...ruleCredit(p, m).values()].reduce((s, x) => s + x, 0)).toBeCloseTo(1, 12);
  });

  it('halves a touch’s time-decay weight every week before the conversion', () => {
    const two: Path = {
      touches: [
        { campaign: 'old', at: 0 },
        { campaign: 'new', at: HALF_LIFE_MS },
      ],
      converted: true,
      at: HALF_LIFE_MS,
    };
    const credit = ruleCredit(two, 'time_decay');
    expect((credit.get('new') ?? 0) / (credit.get('old') ?? 1)).toBeCloseTo(2, 12);
  });

  it('splits short paths evenly under position, and credits nothing without touches', () => {
    expect([...ruleCredit(path(['a']), 'position')]).toEqual([['a', 1]]);
    expect([...ruleCredit(path(['a', 'b']), 'position')]).toEqual([
      ['a', 0.5],
      ['b', 0.5],
    ]);
    expect(ruleCredit(path([]), 'linear').size).toBe(0);
  });

  it('adds up a campaign’s credit across paths, over conversions only', () => {
    const total = attribute([path(['a', 'b']), path(['a']), path(['b'], false)], p => ruleCredit(p, 'linear'));
    expect([...total].sort()).toEqual([
      ['a', 1.5],
      ['b', 0.5],
    ]);
  });
});

describe('data-driven attribution', () => {
  it('credits the campaign that changes the chance of converting, not the one that merely tags along', () => {
    // "a" lifts conversion from 10% to 50%; "b" does nothing.
    const paths: Path[] = [];
    for (let i = 0; i < 100; i++) {
      paths.push(path(['b'], i < 10));
      paths.push(path([], i < 10));
      paths.push(path(['a'], i < 50));
      paths.push(path(['a', 'b'], i < 50));
    }
    const credit = shapleyModel(paths)(path(['a', 'b']));
    expect(credit.get('a')).toBeGreaterThan(0.9);
    expect(credit.get('b')).toBeLessThan(0.1);
    expect((credit.get('a') ?? 0) + (credit.get('b') ?? 0)).toBeCloseTo(1, 12);
  });

  it('is symmetric: two campaigns that act alike share equally', () => {
    const paths: Path[] = [];
    for (let i = 0; i < 100; i++) {
      paths.push(path([], i < 5));
      paths.push(path(['a'], i < 30));
      paths.push(path(['b'], i < 30));
      paths.push(path(['a', 'b'], i < 55));
    }
    const credit = shapleyModel(paths)(path(['a', 'b']));
    expect(credit.get('a')).toBeCloseTo(0.5, 12);
  });

  it('trusts no rare set on its own, and falls back to even shares past its size limit', () => {
    // One lucky path is not evidence: the rare pair borrows its best subset's rate.
    const paths: Path[] = [path(['x', 'y'], true)];
    for (let i = 0; i < 20; i++) paths.push(path(['x'], i < 2));
    const credit = shapleyModel(paths)(path(['x', 'y']));
    expect(credit.get('y')).toBe(0);
    const many = Array.from({ length: MAX_SHAPLEY_CAMPAIGNS + 1 }, (_, i) => `c${String(i)}`);
    const wide = shapleyModel([path(many)])(path(many));
    expect(wide.get('c0')).toBeCloseTo(1 / many.length, 12);
  });
});

describe('data-driven attribution, edge cases', () => {
  it('splits evenly when no campaign seems to help, and trusts the empty set at any count', () => {
    // Seeing "a" or "b" never converts more than seeing nothing: no gain to share.
    const paths: Path[] = [path([], true), path([], false)];
    for (let i = 0; i < 10; i++) paths.push(path(['a'], false), path(['b'], false), path(['a', 'b'], i < 1));
    const credit = shapleyModel(paths)(path(['a', 'b']));
    expect([credit.get('a'), credit.get('b')]).toEqual([0.5, 0.5]);
    expect(shapleyModel(paths)(path([])).size).toBe(0);
  });
});

describe('lift from a holdout', () => {
  it('measures the difference with its interval, and says when it is real', () => {
    const real = lift({
      exposedPeople: 10_000,
      exposedConversions: 600,
      holdoutPeople: 10_000,
      holdoutConversions: 400,
    });
    expect(real?.absolute).toBeCloseTo(0.02, 12);
    expect(real?.incremental).toBeCloseTo(200, 6);
    expect(real?.significant).toBe(true);
    const none = lift({ exposedPeople: 1000, exposedConversions: 50, holdoutPeople: 1000, holdoutConversions: 49 });
    expect(none?.significant).toBe(false);
    expect(lift({ exposedPeople: 50, exposedConversions: 5, holdoutPeople: 50, holdoutConversions: 1 })).toBeNull();
  });

  it('assigns people to the holdout by a stable hash, at the share asked', () => {
    expect(heldOut(0, 0.05)).toBe(true);
    expect(heldOut(0xffff_ffff, 0.05)).toBe(false);
    let inside = 0;
    for (let h = 0; h < 100_000; h++) if (heldOut((h * 2_654_435_761) % 0x1_0000_0000, 0.05)) inside++;
    expect(inside / 100_000).toBeCloseTo(0.05, 2);
  });
});

describe('a campaign’s report', () => {
  const now = 100 * DAY;
  const at = (day: number) => new Date(day * DAY);
  const conversion = (adId: string | null, campaign: string, clickedDay: number, value = '1000') => ({
    campaign,
    ad_id: adId,
    clicked_at: at(clickedDay),
    converted_at: at(clickedDay + 1),
    value,
  });

  it('joins a known person’s impressions into a path, within 30 days before the conversion', () => {
    const seen = [
      { ad_id: 'p1', campaign: 'a', at: at(80) },
      { ad_id: 'p1', campaign: 'b', at: at(95) },
      // Too long before, and after the conversion: not on the path.
      { ad_id: 'p1', campaign: 'c', at: at(60) },
      { ad_id: 'p1', campaign: 'c', at: at(97) },
    ];
    const r = campaignReport('a', [conversion('p1', 'b', 95, '2000')], seen, now).credited;
    expect(r.first_touch).toEqual({ conversions: 1, valueMicros: 2000 });
    expect(r.last_click).toEqual({ conversions: 0, valueMicros: 0 });
    expect(r.linear).toEqual({ conversions: 0.5, valueMicros: 1000 });
    expect(campaignReport('c', [conversion('p1', 'b', 95)], seen, now).credited.linear?.conversions).toBe(0);
  });

  it('credits only the click when the person isn’t known, or has no impressions in reach', () => {
    const seen = [{ ad_id: 'p2', campaign: 'a', at: at(10) }];
    for (const c of [conversion(null, 'b', 95), conversion('p2', 'b', 95)]) {
      const r = campaignReport('b', [c], seen, now);
      expect([r.credited.first_touch?.conversions, r.joinedPaths]).toEqual([1, 0]);
    }
  });

  it('compares converters with recent people who didn’t convert', () => {
    // "a" alone converts 1 in 6 recently seen people; "b" alone converts every time.
    const seen = [
      ...Array.from({ length: 5 }, (_, i) => ({ ad_id: `n${String(i)}`, campaign: 'a', at: at(90) })),
      // Seen too long ago to count as someone who didn't convert.
      ...Array.from({ length: 50 }, (_, i) => ({ ad_id: `old${String(i)}`, campaign: 'b', at: at(50) })),
    ];
    const conversions = [
      conversion(null, 'a', 90),
      ...Array.from({ length: 6 }, () => conversion(null, 'b', 90)),
      ...Array.from({ length: 6 }, (_, i) => conversion(`ab${String(i)}`, 'b', 90)),
    ];
    const both = [
      ...seen,
      ...Array.from({ length: 6 }, (_, i) => [
        { ad_id: `ab${String(i)}`, campaign: 'a', at: at(89) },
        { ad_id: `ab${String(i)}`, campaign: 'b', at: at(90) },
      ]).flat(),
    ];
    const a = campaignReport('a', conversions, both, now).credited;
    const b = campaignReport('b', conversions, both, now).credited;
    // Under linear the pairs split evenly; data-driven gives "b" almost all of them.
    expect(a.linear?.conversions).toBe(4);
    expect(a.data_driven?.conversions).toBeLessThan(2);
    expect(b.data_driven?.conversions).toBeGreaterThan(11);
  });

  it('doesn’t count a person who converted among those who didn’t', () => {
    // "a" alone converts half the time, "b" alone never, both together always:
    // Shapley gives each pair 3/4 to "a" and 1/4 to "b".
    const seen = [
      ...Array.from({ length: 3 }, (_, i) => ({ ad_id: `a${String(i)}`, campaign: 'a', at: at(90) })),
      ...Array.from({ length: 6 }, (_, i) => ({ ad_id: `b${String(i)}`, campaign: 'b', at: at(90) })),
      ...Array.from({ length: 6 }, (_, i) => [
        { ad_id: `ab${String(i)}`, campaign: 'a', at: at(89) },
        { ad_id: `ab${String(i)}`, campaign: 'b', at: at(90) },
      ]).flat(),
    ];
    const conversions = [
      ...Array.from({ length: 3 }, () => conversion(null, 'a', 90)),
      ...Array.from({ length: 6 }, (_, i) => conversion(`ab${String(i)}`, 'b', 90)),
    ];
    expect(campaignReport('b', conversions, seen, now).credited.data_driven?.conversions).toBe(1.5);
  });
});
