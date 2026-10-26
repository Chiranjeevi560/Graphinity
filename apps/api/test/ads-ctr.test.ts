import { describe, expect, it } from 'vitest';
import { ctrFeatures, trainCtr, type ImpressionExample } from '../src/ads/ctr.ts';
import { choose, indexCampaigns, type AdContext, type IndexedCampaign } from '../src/ads/serve.ts';
import { seededRandom } from '../src/ml/linalg.ts';

/** Impressions where a campaign does far better on its own topic: structure a per-campaign average can't see. */
function logs(n: number, seed: number, structured: boolean): ImpressionExample[] {
  const r = seededRandom(seed);
  return Array.from({ length: n }, (_, i) => {
    const campaign = String(Math.floor(r() * 30));
    const field = `f${String(Math.floor(r() * 6))}`;
    const home = `f${String(Number(campaign) % 6)}`;
    const p = structured ? (field === home ? 0.12 : 0.01) : 0.04;
    return {
      id: String(i),
      campaign,
      creative: `${campaign}-1`,
      placement: r() < 0.5 ? 'search' : 'question',
      field,
      hour: i % 24,
      clicked: r() < p,
    };
  });
}

describe('training the ad click model', () => {
  it('promotes a model that learns what a per-campaign average misses', () => {
    const examples = logs(40_000, 1, true);
    const rate = new Map<string, number>();
    for (const c of new Set(examples.map(e => e.campaign))) {
      const mine = examples.slice(0, 32_000).filter(e => e.campaign === c);
      rate.set(c, mine.filter(e => e.clicked).length / Math.max(1, mine.length));
    }
    const result = trainCtr(examples, e => rate.get(e.campaign) ?? 0.03);
    expect(result.promote).toBe(true);
    expect(result.difference.high).toBeLessThan(0);
    expect(result.artifact).not.toBeNull();
    expect(result.counts).toEqual({
      train: 28_000,
      validate: 4_000,
      test: 8_000,
      clicks: examples.filter(e => e.clicked).length,
    });
  });

  it('refuses one that can’t beat what serves, and keeps no weights for it', () => {
    // Clicks at random: the true rate is the best anyone can do, and the baseline already has it.
    const result = trainCtr(logs(30_000, 2, false), () => 0.04);
    expect(result.promote).toBe(false);
    expect(result.artifact).toBeNull();
    expect(result.reason).toMatch(/not better/);
  });

  it('reads the same features in training and serving', () => {
    const f = ctrFeatures({ campaign: '7', creative: '7-1', placement: 'search', field: null, hour: 3 });
    expect(f).toEqual(['c:7', 'cr:7-1', 'p:search', 'f:-', 'h:3', 'cf:7:-', 'cp:7:search']);
  });
});

describe('serving with a learned model', () => {
  const campaign = (id: string, maxCpcMicros: number): IndexedCampaign => ({
    id,
    advertiser: id,
    advertiserId: id,
    maxCpcMicros,
    dailyBudgetMicros: 100_000_000,
    frequencyCap: 3,
    spentMicros: 0,
    impressions: 0,
    clicks: 0,
    creatives: [{ id: `${id}-1`, headline: 'h', body: 'b', domain: 'd.example' }],
    targets: new Map(),
  });
  const ctx: AdContext = { placement: 'question', fields: ['travel'], words: [], country: 'IN', interests: null };

  it('ranks by the model’s click rate, where shrunk averages would rank by bid', () => {
    const cs = indexCampaigns([campaign('high-bid', 2_000_000), campaign('clicked', 1_000_000)]);
    const now = Date.UTC(2026, 9, 26, 12);
    expect(choose(cs, ctx, new Map(), now).wins[0]?.campaignId).toBe('high-bid');
    const model = (c: string) => (c === 'clicked' ? 0.08 : 0.01);
    expect(choose(cs, ctx, new Map(), now, c => model(c)).wins[0]?.campaignId).toBe('clicked');
  });
});
