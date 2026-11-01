// What the security review of 2026-11-01 found in ad billing and access, each as an attack that must now fail.
import { beforeAll, describe, expect, it } from 'vitest';
import { hashKey } from '../src/routes/ad-measurement.ts';
import type { TestApp } from './helpers/app.ts';
import { startAdWorld } from './helpers/ads.ts';
import { must, type Body } from './helpers/must.ts';

let w: Awaited<ReturnType<typeof startAdWorld>>;
let h: TestApp;
beforeAll(async () => {
  w = await startAdWorld('billrev');
  h = w.h;
  return h.close;
});

/** A shown ad's token, ready to tap. */
let words = 0;
async function shown(over: Record<string, number> = {}) {
  // A word only this campaign bids on, so earlier tests' campaigns can't outbid it.
  words += 1;
  const word = `ferryword${'abcdefghij'[words] ?? 'k'}`;
  const live = await w.liveCampaign([{ kind: 'keyword', value: word }], over);
  const ad = must(
    (await w.select(undefined, { placement: 'search', query: `${word} timetable` })).find(
      a => a.headline === live.headline,
    ),
  );
  const id = must(
    (
      await h.t.owner.query<{ id: string; advertiser_id: string }>(
        'SELECT id::text, advertiser_id::text FROM app.ad_campaigns WHERE public_id = $1',
        [live.campaign],
      )
    ).rows[0],
  );
  return { ...live, token: ad.token, campaignId: id.id, advertiserId: id.advertiser_id };
}
const charged = async (token: string) =>
  Number(
    must(
      (
        await h.t.owner.query<{ c: string }>(
          'SELECT charged_micros::text AS c FROM app.ad_impressions WHERE token = $1',
          [token],
        )
      ).rows[0],
    ).c,
  );

/** An older impression, shown days ago and charged at `chargedAgo`. */
const pastCharge = (campaign: string, micros: number, chargedAgo: string) =>
  h.t.owner.query(
    `INSERT INTO app.ad_impressions (campaign_id, creative_id, ad_id, placement, price_micros, shown_at, clicked_at, charged_micros, charged_at, field)
     SELECT $1, cr.id, NULL, 'question', $2, now() - interval '3 days', now() - $3::interval, $2, now() - $3::interval, 'travel'
     FROM app.ad_creatives cr WHERE cr.campaign_id = $1 LIMIT 1`,
    [campaign, micros, chargedAgo],
  );

describe('clicks and budgets', () => {
  it('a click today counts against today, whenever the ad was shown', async () => {
    const live = await shown({ dailyBudgetMicros: 10_000_000, maxCpcMicros: 10_000_000 });
    // Shown days ago, charged minutes ago: under the old rule this spend belonged to another day.
    await pastCharge(live.campaignId, 10_000_000, '1 minute');
    await h.call('POST', `/ads/click/${live.token}`);
    expect(await charged(live.token)).toBe(0);
  });

  it("yesterday's charges don't use today's budget", async () => {
    const live = await shown({ dailyBudgetMicros: 10_000_000, maxCpcMicros: 10_000_000 });
    await pastCharge(live.campaignId, 10_000_000, '2 days');
    await h.call('POST', `/ads/click/${live.token}`);
    expect(await charged(live.token)).toBeGreaterThan(0);
  });

  it('the total budget holds at click time', async () => {
    const live = await shown({ dailyBudgetMicros: 10_000_000, maxCpcMicros: 10_000_000 });
    await pastCharge(live.campaignId, 10_000_000, '2 days');
    await h.t.owner.query('UPDATE app.ad_campaigns SET total_budget_micros = 10000000 WHERE id = $1', [live.campaignId]);
    await h.call('POST', `/ads/click/${live.token}`);
    expect(await charged(live.token)).toBe(0);
  });

  it('a paused campaign or suspended business is charged nothing, and the tap still works', async () => {
    const paused = await shown();
    await h.t.owner.query("UPDATE app.ad_campaigns SET status = 'paused' WHERE id = $1", [paused.campaignId]);
    expect((await h.call('POST', `/ads/click/${paused.token}`)).statusCode).toBe(200);
    expect(await charged(paused.token)).toBe(0);
    const suspended = await shown();
    await h.t.owner.query("UPDATE app.ad_advertisers SET status = 'suspended' WHERE id = $1", [suspended.advertiserId]);
    await h.call('POST', `/ads/click/${suspended.token}`);
    expect(await charged(suspended.token)).toBe(0);
    await h.t.owner.query("UPDATE app.ad_advertisers SET status = 'active' WHERE id = $1", [suspended.advertiserId]);
  });

  it("a business's staff tapping its own ad leaves no click to inflate its rate", async () => {
    const live = await shown();
    const res = await h.call('POST', `/ads/click/${live.token}`, live.owner.token);
    expect(res.statusCode).toBe(200);
    const { rows } = await h.t.owner.query<{ clicked: boolean; c: string }>(
      'SELECT clicked_at IS NOT NULL AS clicked, charged_micros::text AS c FROM app.ad_impressions WHERE token = $1',
      [live.token],
    );
    expect(rows).toEqual([{ clicked: false, c: '0' }]);
  });
});

describe('suspended and blocked', () => {
  const key = `grk_${'s'.repeat(43)}`;
  it("a suspended business's key stops working, and a blocked person can't build", async () => {
    const live = await shown();
    await h.t.owner.query(
      "INSERT INTO app.ad_api_keys (advertiser_id, key_hash, prefix) VALUES ($1, $2, 'grk_ssssss')",
      [live.advertiserId, hashKey(key)],
    );
    const find = async () =>
      (await h.t.database.asSystem(
        async q =>
          (await q.query<{ id: string | null }>('SELECT app.active_key_advertiser($1) AS id', [hashKey(key)])).rows[0]
            ?.id,
      )) ?? null;
    expect(await find()).toBe(live.advertiserId);
    await h.t.owner.query("UPDATE app.ad_advertisers SET status = 'suspended' WHERE id = $1", [live.advertiserId]);
    expect(await find()).toBeNull();
    await h.t.owner.query("UPDATE app.ad_advertisers SET status = 'active' WHERE id = $1", [live.advertiserId]);

    await h.t.owner.query('INSERT INTO app.blocks (profile_id) VALUES ($1)', [live.owner.id]);
    await expect(
      h.t.database.withUser(live.owner.id, q =>
        q.query("INSERT INTO app.ad_api_keys (advertiser_id, key_hash, prefix) VALUES ($1, $2, 'grk_zzzzzz')", [
          live.advertiserId,
          hashKey(`grk_${'z'.repeat(43)}`),
        ]),
      ),
    ).rejects.toThrow();
  });
});

describe('uploads', () => {
  it('a made-up key is refused before the body is read', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/ads/audiences/partner-match',
      headers: { authorization: `Bearer grk_${'A'.repeat(43)}`, 'content-type': 'application/json' },
      // Not even valid: reaching the schema check would answer 400.
      payload: '{"not":"valid"}',
    });
    expect(res.statusCode).toBe(202);
    expect(res.json<Body>()).toEqual({ status: 'insufficient' });
  });
});
