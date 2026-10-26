import { describe, expect, it } from 'vitest';
import { recordAdInterest } from '../src/ads/interests.ts';
import {
  choose as chooseFrom,
  indexCampaigns,
  matches,
  type AdContext,
  type IndexedCampaign,
} from '../src/ads/serve.ts';

const choose = (cs: IndexedCampaign[], ctx: AdContext, seen: Map<string, number>, now: number) =>
  chooseFrom(indexCampaigns(cs), ctx, seen, now);

const campaign = (
  id: string,
  targets: Record<string, string[]> = {},
  over: Partial<IndexedCampaign> = {},
): IndexedCampaign => ({
  id,
  advertiser: `Business ${id}`,
  advertiserId: `a${id}`,
  maxCpcMicros: 1_000_000,
  dailyBudgetMicros: 100_000_000,
  frequencyCap: 3,
  spentMicros: 0,
  impressions: 0,
  clicks: 0,
  creatives: [
    { id: `${id}-1`, headline: 'Ferries to the islands', body: 'Daily boats.', domain: 'ferries.example.in' },
  ],
  targets: new Map(Object.entries(targets).map(([k, v]) => [k, new Set(v)])),
  reminders: new Set(),
  ...over,
});
const ctx = (over: Partial<AdContext> = {}): AdContext => ({
  placement: 'search',
  fields: ['travel'],
  words: ['ferry', 'goa'],
  country: 'IN',
  interests: null,
  ...over,
});
const noon = Date.UTC(2026, 9, 26, 12);

describe('targeting', () => {
  it('needs every kind a campaign uses to match, any value within a kind', () => {
    expect(matches(campaign('1'), ctx())).toBe(true);
    expect(matches(campaign('1', { field: ['travel', 'money-tax'] }), ctx())).toBe(true);
    expect(matches(campaign('1', { field: ['money-tax'] }), ctx())).toBe(false);
    expect(matches(campaign('1', { field: ['travel'], keyword: ['visa'] }), ctx())).toBe(false);
    expect(matches(campaign('1', { keyword: ['goa'], country: ['IN'] }), ctx())).toBe(true);
    // No country known (signed out): country-targeted campaigns don't serve.
    expect(matches(campaign('1', { country: ['IN'] }), ctx({ country: null }))).toBe(false);
  });

  it('matches interests only for a reader who allows personalized ads', () => {
    const c = campaign('1', { interest: ['travel'] });
    expect(matches(c, ctx({ interests: null }))).toBe(false);
    expect(matches(c, ctx({ interests: new Set(['money-tax']) }))).toBe(false);
    expect(matches(c, ctx({ interests: new Set(['travel']) }))).toBe(true);
  });
});

describe('the index', () => {
  it('finds exactly what scanning every campaign would (property, 300 contexts)', () => {
    const fields = ['travel', 'money-tax', 'health', 'imports-customs'];
    const all = Array.from({ length: 60 }, (_, i) =>
      campaign(
        String(i),
        i % 5 === 0 ? {} : { field: [fields[i % 4] ?? 'travel', ...(i % 7 === 0 ? ['health'] : [])] },
      ),
    );
    const index = indexCampaigns(all);
    for (let t = 0; t < 300; t++) {
      const c = ctx({ fields: fields.filter((_, j) => (t >> j) & 1) });
      const byScan = all
        .filter(x => matches(x, c))
        .map(x => x.id)
        .sort();
      const viaIndex = [...new Set([...index.anyField, ...c.fields.flatMap(f => index.byField.get(f) ?? [])])]
        .filter(x => matches(x, c))
        .map(x => x.id)
        .sort();
      expect(viaIndex).toEqual(byScan);
    }
  });
});

describe('choosing', () => {
  it('leaves out campaigns ahead of their pacing or at their cap, and fills the placement’s slots', () => {
    const fresh = campaign('fresh');
    const ahead = campaign('ahead', {}, { spentMicros: 90_000_000 });
    const capped = campaign('capped', {}, { frequencyCap: 1 });
    const other = campaign('other', {}, { maxCpcMicros: 500_000 });
    const picked = choose([fresh, ahead, capped, other], ctx(), new Map([['capped', 1]]), noon);
    expect(picked.wins.map(w => w.campaignId)).toEqual(['fresh', 'other']);
    expect(picked.creatives.get('fresh-1')?.advertiser).toBe('Business fresh');
    // A question page has one slot.
    expect(choose([fresh, other], ctx({ placement: 'question' }), new Map(), noon).wins).toHaveLength(1);
  });

  it('prefers the campaign people click more, at equal bids, once there is evidence', () => {
    const clicked = campaign('clicked', {}, { impressions: 2000, clicks: 120 });
    const ignored = campaign('ignored', {}, { impressions: 2000, clicks: 4 });
    expect(choose([ignored, clicked], ctx({ placement: 'question' }), new Map(), noon).wins[0]?.campaignId).toBe(
      'clicked',
    );
  });
});

describe('recording interests', () => {
  it('never gets in the way: a failure is logged by kind and the page carries on', async () => {
    const warnings: Array<{ obj: object; msg: string }> = [];
    const failing = { withUser: () => Promise.reject(new TypeError('database down')) };
    await recordAdInterest(failing, { warn: (obj, msg) => warnings.push({ obj, msg }) }, 'someone', 'travel', 1);
    expect(warnings).toEqual([{ obj: { kind: 'TypeError' }, msg: 'ad interest not recorded' }]);
  });
});

describe('audiences', () => {
  it('match only readers in one of the targeted audiences, and nobody untracked', () => {
    const c = campaign('aud', { audience: ['A'] });
    const noon = Date.UTC(2026, 9, 27, 12);
    const shown = (audiences: ReadonlyMap<string, number> | null) =>
      choose([c], ctx({ audiences }), new Map(), noon).wins.length;
    expect(shown(new Map([['A', noon]]))).toBe(1);
    expect(shown(new Map([['B', noon]]))).toBe(0);
    expect(shown(new Map())).toBe(0);
    expect(shown(null)).toBe(0);
  });

  it('cool a reminder with time since the tap, and cap it at 3 a day', () => {
    const noon = Date.UTC(2026, 9, 27, 12);
    // The reminder bids a fifth more: it wins fresh, and loses once cooled for a week (×e^−1).
    const reminder = campaign(
      'r',
      { audience: ['R'] },
      { reminders: new Set(['R']), frequencyCap: 10, maxCpcMicros: 1_200_000 },
    );
    const plain = campaign('p', {}, { frequencyCap: 10 });
    const first = (tapAt: number) =>
      choose([reminder, plain], ctx({ placement: 'question', audiences: new Map([['R', tapAt]]) }), new Map(), noon)
        .wins[0]?.campaignId;
    expect(first(noon)).toBe('r');
    expect(first(noon - 7 * 86_400_000)).toBe('p');
    expect(choose([reminder], ctx({ audiences: new Map([['R', noon]]) }), new Map([['r', 3]]), noon).wins).toHaveLength(
      0,
    );
    expect(choose([plain], ctx(), new Map([['p', 3]]), noon).wins).toHaveLength(1);
  });
});
