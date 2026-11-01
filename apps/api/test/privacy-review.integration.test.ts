// What the privacy review of 2026-11-01 found, each as a promise that must now hold.
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { TestApp } from './helpers/app.ts';
import { startAdWorld } from './helpers/ads.ts';
import { must } from './helpers/must.ts';

let w: Awaited<ReturnType<typeof startAdWorld>>;
let h: TestApp;
beforeAll(async () => {
  w = await startAdWorld('privrev');
  h = w.h;
  return h.close;
});

const allowing = async () => {
  const p = await w.member();
  await h.call('PUT', '/me/consents', p.token, { choices: [{ category: 'ads_personalization', enabled: true }] });
  return p;
};
const interests = async (id: string) =>
  (
    await h.t.owner.query(
      'SELECT 1 FROM app.ad_interests a JOIN app.ad_identities i ON i.ad_id = a.ad_id WHERE i.profile_id = $1',
      [id],
    )
  ).rowCount;

/** An impression of this person's with a click id, and a sale a merchant reported against it. */
async function saleFor(person: { id: string; token: string }) {
  const live = await w.liveCampaign([
    { kind: 'keyword', value: `kettle${randomUUID().slice(0, 4).replace(/\d/g, 'k')}` },
  ]);
  await h.call('PUT', '/me/consents', person.token, { choices: [{ category: 'ads_measurement', enabled: true }] });
  const clickId = randomUUID();
  await h.t.owner.query('INSERT INTO app.ad_identities (profile_id) VALUES ($1) ON CONFLICT DO NOTHING', [person.id]);
  const row = must(
    (
      await h.t.owner.query<{ id: string; advertiser: string }>(
        `INSERT INTO app.ad_impressions (campaign_id, creative_id, ad_id, placement, price_micros, clicked_at, charged_micros, charged_at, click_id, country, field)
         SELECT c.id, cr.id, d.ad_id, 'search', 5, now(), 5, now(), $2, 'IN', 'travel'
         FROM app.ad_campaigns c JOIN app.ad_creatives cr ON cr.campaign_id = c.id, app.ad_identities d
         WHERE c.public_id = $1 AND d.profile_id = $3 LIMIT 1
         RETURNING id::text, (SELECT advertiser_id::text FROM app.ad_campaigns WHERE public_id = $1) AS advertiser`,
        [live.campaign, clickId, person.id],
      )
    ).rows[0],
  );
  await h.t.owner.query(
    `INSERT INTO app.ad_conversions (advertiser_id, impression_id, external_id, value_micros, converted_at) VALUES ($1, $2, $3, 100, now())`,
    [row.advertiser, row.id, `customer-${randomUUID()}`],
  );
  return row.id;
}
const after = async (impression: string) =>
  must(
    (
      await h.t.owner.query<Record<string, unknown>>(
        `SELECT ad_id, click_id, country, field, audience_id, charged_micros::int AS charged,
                (SELECT count(*)::int FROM app.ad_conversions c WHERE c.impression_id = i.id) AS sales
         FROM app.ad_impressions i WHERE id = $1`,
        [impression],
      )
    ).rows[0],
  );
const scrubbed = { ad_id: null, click_id: null, country: null, field: null, audience_id: null, charged: 5, sales: 0 };

describe('Global Privacy Control', () => {
  it('reading a question adds nothing to advertising interests when the browser objects', async () => {
    const reader = await allowing();
    const id = await w.question();
    const read = (headers: Record<string, string>) =>
      h.app.inject({
          method: 'GET',
          url: `/questions/${id}`,
          headers: { authorization: `Bearer ${reader.token}`, ...headers },
        });
    expect((await read({ 'sec-gpc': '1' })).statusCode).toBe(200);
    expect(await interests(reader.id)).toBe(0);
    expect((await read({})).statusCode).toBe(200);
    expect(await interests(reader.id)).toBe(1);
  });
});

describe('advertising rows follow the person', () => {
  it('deleting the account takes the sale and everything naming them, and keeps the charge', async () => {
    const p = await allowing();
    const impression = await saleFor(p);
    expect((await after(impression)).sales).toBe(1);
    await h.t.owner.query('DELETE FROM app.profiles WHERE id = $1', [p.id]);
    expect(await after(impression)).toEqual(scrubbed);
  });

  it('turning personalized ads off does the same', async () => {
    const p = await allowing();
    const impression = await saleFor(p);
    await h.call('PUT', '/me/consents', p.token, { choices: [{ category: 'ads_personalization', enabled: false }] });
    expect(await after(impression)).toEqual(scrubbed);
  });

  it("leaves other people's rows alone", async () => {
    const [gone, stays] = [await allowing(), await allowing()];
    const kept = await saleFor(stays);
    await saleFor(gone);
    await h.t.owner.query('DELETE FROM app.profiles WHERE id = $1', [gone.id]);
    expect((await after(kept)).sales).toBe(1);
    expect((await after(kept)).country).toBe('IN');
  });
});

describe('the data export', () => {
  it('has their advertising rows, memory, complaints and statements, and only theirs', async () => {
    const [p, other] = [await allowing(), await allowing()];
    await saleFor(p);
    await saleFor(other);
    await h.t.owner.query(`INSERT INTO app.memory_entries (user_id, tier, key) VALUES ($1, 'semantic', 'visas')`, [
      p.id,
    ]);
    await h.t.owner.query(`INSERT INTO app.memory_entries (user_id, tier, key) VALUES ($1, 'semantic', 'other')`, [
      other.id,
    ]);
    const body = (await h.call('GET', '/me/data-export', p.token)).json<{
      adActivity: { shown: unknown[]; reportedSales: unknown[]; partnerEvents: unknown[]; heldBack: unknown[] };
      memory: Array<{ key: string }>;
      complaints: unknown[];
      statementsOfReasons: unknown[];
    }>();
    expect(body.adActivity.shown).toHaveLength(1);
    expect(body.adActivity.reportedSales).toHaveLength(1);
    expect(body.memory.map(m => m.key)).toEqual(['visas']);
    expect(body.complaints).toEqual([]);
    expect(body.statementsOfReasons).toEqual([]);
  });
});
