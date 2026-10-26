// Measuring what ads lead to (ADR 0022 part 6a, migration 0034): keys shown
// once and stored only as hashes; click ids only for people who allow
// measurement; conversions counted once, only for a business's own recent
// clicks, with every refusal looking the same from outside.
import { beforeAll, describe, expect, it } from 'vitest';
import { hashKey } from '../src/routes/ad-measurement.ts';
import { startAdWorld } from './helpers/ads.ts';
import { must, type Body } from './helpers/must.ts';

let w: Awaited<ReturnType<typeof startAdWorld>>;

beforeAll(async () => {
  w = await startAdWorld('measure', ['ads', 'ads_measurement']);
  return w.h.close;
});

const allowMeasurement = (token: string) =>
  w.h.call('PUT', '/me/consents', token, { choices: [{ category: 'ads_measurement', enabled: true }] });

async function makeKey(owner: { token: string }, advertiser: string) {
  const res = await w.h.call('POST', `/ads/advertisers/${advertiser}/keys`, owner.token);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ key: { value: string; prefix: string } }>().key;
}

let keywords = 0;
/**
 * A campaign of its own: it targets a keyword nothing else does, so it never meets another
 * campaign in the auction (earlier tests' clicked campaigns predict higher click rates).
 */
async function ownCampaign() {
  keywords += 1;
  const keyword = `measured${String(keywords)}`;
  return { ...(await w.liveCampaign([{ kind: 'keyword', value: keyword }])), keyword };
}

/** A click on the campaign by `viewer`, from a search for its keyword, returning where it sends them. */
async function click(live: { headline: string; keyword: string }, viewer?: { token: string }) {
  const ad = must(
    (await w.select(viewer?.token, { placement: 'search', query: `ferry ${live.keyword}` })).find(
      a => a.headline === live.headline,
    ),
  );
  return (await w.h.call('POST', `/ads/click/${ad.token}`, viewer?.token)).json<{ destination: string }>().destination;
}

// The key travels as a bearer token, as an advertiser's server sends it.
const report = (key: string, body: object) => w.h.call('POST', '/ads/conversions', key, body);

describe('API keys', () => {
  it('are made by the business’s owner, shown once, and kept only as hashes', async () => {
    const live = await ownCampaign();
    const key = await makeKey(live.owner, live.advertiser);
    expect(key.value).toMatch(/^grk_[A-Za-z0-9_-]{43}$/);
    const { rows } = await w.h.t.owner.query<{ key_hash: string; prefix: string }>(
      'SELECT key_hash, prefix FROM app.ad_api_keys',
    );
    expect(rows.map(r => r.key_hash)).toContain(hashKey(key.value));
    expect(JSON.stringify(rows)).not.toContain(key.value.slice(10));
    // A manager, or anyone else, can't.
    const manager = await w.member();
    await w.h.t.owner.query(
      "INSERT INTO app.ad_advertiser_members (advertiser_id, profile_id, role) SELECT id, $1, 'manager' FROM app.ad_advertisers WHERE public_id = $2",
      [manager.id, live.advertiser],
    );
    expect((await w.h.call('POST', `/ads/advertisers/${live.advertiser}/keys`, manager.token)).json<Body>().error).toBe(
      'not_owner',
    );
    expect(
      (await w.h.call('POST', `/ads/advertisers/${live.advertiser}/keys`, (await w.member()).token)).statusCode,
    ).toBe(404);
  });

  it('are at most ten working at once, and a revoked one stops working for good', async () => {
    const live = await ownCampaign();
    const keys = [];
    for (let i = 0; i < 10; i++) keys.push(await makeKey(live.owner, live.advertiser));
    expect(
      (await w.h.call('POST', `/ads/advertisers/${live.advertiser}/keys`, live.owner.token)).json<Body>().error,
    ).toBe('too_many_keys');
    const first = must(keys[0]);
    const revoke = () =>
      w.h.call('DELETE', `/ads/advertisers/${live.advertiser}/keys/${first.prefix}`, live.owner.token);
    expect((await revoke()).statusCode).toBe(200);
    expect((await revoke()).statusCode).toBe(404);
    await expect(
      w.h.t.database.withUser(live.owner.id, q =>
        q.query('UPDATE app.ad_api_keys SET revoked_at = NULL WHERE prefix = $1', [first.prefix]),
      ),
    ).rejects.toThrow();
    // Room for one more now.
    await makeKey(live.owner, live.advertiser);
  });
});

describe('click ids', () => {
  it('reach the advertiser only for people who allow measurement', async () => {
    const live = await ownCampaign();
    const [allowing, other] = [await w.member(), await w.member()];
    await allowMeasurement(allowing.token);
    expect(new URL(await click(live, other)).searchParams.has('gr_click')).toBe(false);
    expect(new URL(await click(live)).searchParams.has('gr_click')).toBe(false);
    const tracked = new URL(await click(live, allowing));
    expect(tracked.searchParams.get('gr_click')).toMatch(/^[0-9a-f-]{36}$/);
    expect(tracked.pathname).toBe('/book');
  });
});

describe('conversions', () => {
  it('count once, for a business’s own recent click, and every refusal looks the same', async () => {
    const live = await ownCampaign();
    const other = await ownCampaign();
    const key = await makeKey(live.owner, live.advertiser);
    const otherKey = await makeKey(other.owner, other.advertiser);
    const person = await w.member();
    await allowMeasurement(person.token);
    const clickId = must(new URL(await click(live, person)).searchParams.get('gr_click'));
    const order = { clickId, externalId: 'order-1', valueMicros: 2_500_000_000 };
    expect((await report(key.value, order)).statusCode).toBe(201);
    expect((await report(key.value, order)).json<{ conversion: { duplicate: boolean } }>().conversion.duplicate).toBe(
      true,
    );
    // Another business's key, an unknown click, a bad key, a conversion before the click: all "not counted".
    expect((await report(otherKey.value, { ...order, externalId: 'o2' })).json<Body>().error).toBe('not_counted');
    expect(
      (await report(key.value, { ...order, clickId: crypto.randomUUID(), externalId: 'o3' })).json<Body>().error,
    ).toBe('not_counted');
    expect((await report('grk_' + 'x'.repeat(43), { ...order, externalId: 'o4' })).json<Body>().error).toBe(
      'not_counted',
    );
    expect((await report('not-a-key', order)).statusCode).toBe(401);
    // No key at all.
    expect((await w.h.call('POST', '/ads/conversions', undefined, order)).json<Body>().error).toBe('bad_key');
    expect(
      (await report(key.value, { ...order, externalId: 'o5', convertedAt: '2020-01-01T00:00:00.000Z' })).json<Body>()
        .error,
    ).toBe('not_counted');
    // A click more than 30 days old.
    await w.h.t.owner.query(
      "UPDATE app.ad_impressions SET clicked_at = now() - interval '31 days' WHERE click_id = $1",
      [clickId],
    );
    expect((await report(key.value, { ...order, externalId: 'o6' })).json<Body>().error).toBe('not_counted');
    // A revoked key.
    await w.h.call('DELETE', `/ads/advertisers/${live.advertiser}/keys/${key.prefix}`, live.owner.token);
    await w.h.t.owner.query('UPDATE app.ad_impressions SET clicked_at = now() WHERE click_id = $1', [clickId]);
    expect((await report(key.value, { ...order, externalId: 'o7' })).json<Body>().error).toBe('not_counted');
    const { rows } = await w.h.t.owner.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM app.ad_conversions c JOIN app.ad_advertisers a ON a.id = c.advertiser_id WHERE a.public_id = $1',
      [live.advertiser],
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('count when reported in whole seconds the moment after the click (clocks and precision differ)', async () => {
    const live = await ownCampaign();
    const key = await makeKey(live.owner, live.advertiser);
    const person = await w.member();
    await allowMeasurement(person.token);
    const clickId = must(new URL(await click(live, person)).searchParams.get('gr_click'));
    const wholeSecond = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
    expect((await report(key.value, { clickId, externalId: 'same-second', convertedAt: wholeSecond })).statusCode).toBe(
      201,
    );
  });

  it('are read by the business they belong to, and nobody else', async () => {
    const live = await ownCampaign();
    const key = await makeKey(live.owner, live.advertiser);
    const person = await w.member();
    await allowMeasurement(person.token);
    const clickId = must(new URL(await click(live, person)).searchParams.get('gr_click'));
    await report(key.value, { clickId, externalId: 'order-9' });
    const seen = (id: string) =>
      w.h.t.database.withUser(id, async q => (await q.query('SELECT 1 FROM app.ad_conversions')).rowCount);
    expect(await seen(live.owner.id)).toBe(1);
    expect(await seen(person.id)).toBe(0);
  });

  it('aren’t counted while measurement is switched off', async () => {
    const live = await ownCampaign();
    const key = await makeKey(live.owner, live.advertiser);
    const person = await w.member();
    await allowMeasurement(person.token);
    const clickId = must(new URL(await click(live, person)).searchParams.get('gr_click'));
    await w.h.t.owner.query("UPDATE app.feature_flags SET enabled = false WHERE name = 'ads_measurement'");
    try {
      expect((await report(key.value, { clickId, externalId: 'order-off' })).json<Body>().error).toBe('not_counted');
      // And no new click ids are handed out meanwhile.
      expect(new URL(await click(live, person)).searchParams.has('gr_click')).toBe(false);
    } finally {
      await w.h.t.owner.query("UPDATE app.feature_flags SET enabled = true WHERE name = 'ads_measurement'");
    }
  });
});

describe('campaign reports', () => {
  it('give the business its campaign’s numbers and credit, and nobody else sees them', async () => {
    const live = await ownCampaign();
    const key = await makeKey(live.owner, live.advertiser);
    const person = await w.member();
    await w.h.t.owner.query("UPDATE app.feature_flags SET enabled = true WHERE name = 'ads_behavioral'");
    try {
      await w.h.call('PUT', '/me/consents', person.token, {
        choices: [
          { category: 'ads_personalization', enabled: true },
          { category: 'ads_measurement', enabled: true },
        ],
      });
      const clickId = must(new URL(await click(live, person)).searchParams.get('gr_click'));
      expect((await report(key.value, { clickId, externalId: 'r-1', valueMicros: 4_000_000 })).statusCode).toBe(201);
      const read = (token: string) => w.h.call('GET', `/ads/campaigns/${live.campaign}/report`, token);
      // One person behind it: nothing is shown.
      expect((await read(live.owner.token)).json<{ report: object }>().report).toEqual({
        days: 30,
        belowMinimum: true,
        minimumPeople: 25,
      });
      // 24 more viewers, untracked: 25 people.
      await w.h.t.owner.query(
        `INSERT INTO app.ad_impressions (campaign_id, creative_id, placement, price_micros)
         SELECT c.id, cr.id, 'search', 1000 FROM app.ad_campaigns c JOIN app.ad_creatives cr ON cr.campaign_id = c.id,
                generate_series(1, 24) WHERE c.public_id = $1`,
        [live.campaign],
      );
      const res = await read(live.owner.token);
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json<{
        report: {
          impressions: number;
          clicks: number;
          spentMicros: number;
          businessConversions: number;
          joinedPaths: number;
          credited: Record<string, { conversions: number; valueMicros: number }>;
        };
      }>().report;
      expect([body.impressions, body.clicks, body.businessConversions, body.joinedPaths]).toEqual([25, 1, 1, 1]);
      expect(body.spentMicros).toBeGreaterThan(0);
      for (const model of ['last_click', 'first_touch', 'linear', 'time_decay', 'position', 'data_driven'])
        expect(body.credited[model]).toEqual({ conversions: 1, valueMicros: 4_000_000 });
      // Nothing about the person who bought.
      expect(res.body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      // Another person, and a moderator (who reviews every campaign), get nothing.
      expect((await read((await w.member()).token)).statusCode).toBe(404);
      const moderator = await w.member();
      await w.h.t.owner.query('INSERT INTO app.moderators (profile_id) VALUES ($1)', [moderator.id]);
      expect((await read(moderator.token)).json<Body>().error).toBe('not_found');
      // Once the person stops allowing measurement, their impressions no longer join into a path.
      await w.h.call('PUT', '/me/consents', person.token, {
        choices: [{ category: 'ads_measurement', enabled: false }],
      });
      const after = (await read(live.owner.token)).json<{
        report: { joinedPaths: number; businessConversions: number };
      }>();
      expect([after.report.businessConversions, after.report.joinedPaths]).toEqual([1, 0]);
    } finally {
      await w.h.t.owner.query("UPDATE app.feature_flags SET enabled = false WHERE name = 'ads_behavioral'");
    }
  });

  it('aren’t available while advertising is switched off', async () => {
    const live = await ownCampaign();
    w.setOn(false);
    try {
      expect(
        (await w.h.call('GET', `/ads/campaigns/${live.campaign}/report`, live.owner.token)).json<Body>().error,
      ).toBe('ads_off');
    } finally {
      w.setOn(true);
    }
  });
});
