// The merchant pixel and the ad status, through the real server and Postgres (ADR 0030).
import { beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './helpers/app.ts';
import { must } from './helpers/must.ts';

let h: TestApp;
let names = 0;
let adsOn = true;
beforeAll(async () => {
  h = await startApp(() => Date.now(), { adsEnabled: () => adsOn });
  await h.t.owner.query("UPDATE app.feature_flags SET enabled = true WHERE name IN ('ads', 'ads_partner_sites')");
  await h.t.owner.query('UPDATE app.ad_jurisdiction_rules SET legal_approved = true');
  return h.close;
});
async function member() {
  const p = await h.person();
  names += 1;
  await h.call('POST', '/me/profile', p.token, {
    handle: `pix.${String(names)}`,
    country: 'IN',
    fields: ['travel'],
    adult: true,
  });
  return p;
}
async function world(eid: string) {
  const o = h.t.owner;
  const person = await member();
  await h.call('PUT', '/me/consents', person.token, {
    choices: [
      { category: 'ads_personalization', enabled: true },
      { category: 'ads_partner_sites', enabled: true },
    ],
  });
  await o.query('INSERT INTO app.ad_identities (profile_id) VALUES ($1) ON CONFLICT DO NOTHING', [person.id]);
  const adId = must(
    (await o.query<{ ad_id: string }>('SELECT ad_id::text FROM app.ad_identities WHERE profile_id = $1', [person.id]))
      .rows[0],
  ).ad_id;
  const staff = await member();
  const biz = must(
    (
      await o.query<{ id: string; public_id: string; pixel_id: string }>(
        `INSERT INTO app.ad_advertisers (name, country, status) VALUES ($1, 'IN', 'active') RETURNING id::text, public_id::text, pixel_id::text`,
        [`Boats ${eid.slice(0, 4)}`],
      )
    ).rows[0],
  );
  await o.query('INSERT INTO app.ad_advertiser_members (advertiser_id, profile_id) VALUES ($1, $2)', [
    biz.id,
    staff.id,
  ]);
  await o.query(
    `INSERT INTO app.ad_eids (eid, ad_id, expires_at, scope) VALUES ($1, $2, now() + interval '1 day', 'advertiser:' || $3)`,
    [eid, adId, biz.id],
  );
  return { person, staff, biz, adId };
}
const send = (
  pixel: string,
  eidToken: string,
  eventId: string,
  origin = 'https://shop.example.com',
  extra: Record<string, string> = {},
  more: object = {},
) =>
  h.app.inject({
    method: 'POST',
    url: '/ads/pixel',
    headers: { 'content-type': 'text/plain', origin, ...extra },
    payload: JSON.stringify({ pixel, eidToken, event: 'PRODUCT_VIEW', eventId, ...more }),
  });
const events = async (biz: string) =>
  must(
    (
      await h.t.owner.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM app.ad_partner_events WHERE advertiser_id = $1',
        [biz],
      )
    ).rows[0],
  ).n;

describe('the merchant pixel', () => {
  it('counts only a listed site, a real id of this advertiser, once, and answers the same every time', async () => {
    const eid = 'pixelaaaaaaaaaaaaaaaaa';
    const { staff, biz } = await world(eid);
    const stranger = await member();
    expect(
      (
        await h.call('PUT', `/ads/advertisers/${biz.public_id}/pixel`, stranger.token, {
          domains: ['shop.example.com'],
        })
      ).statusCode,
    ).toBe(403);
    const set = await h.call('PUT', `/ads/advertisers/${biz.public_id}/pixel`, staff.token, {
      domains: ['shop.example.com'],
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json()).toEqual({ pixel: { id: biz.pixel_id, domains: ['shop.example.com'] } });

    const replies = [
      await send(biz.pixel_id, eid, 'a'),
      await send(biz.pixel_id, eid, 'a'), // Twice: once.
      await send(biz.pixel_id, eid, 'b', 'https://evil.example.org'), // Not listed.
      await send(biz.pixel_id, 'z'.repeat(22), 'c'), // Nobody.
      await send('00000000-0000-4000-8000-000000000000', eid, 'd'), // No such pixel.
      await send(biz.pixel_id, eid, 'e', 'https://shop.example.com', { 'sec-gpc': '1' }), // Privacy Control.
    ];
    for (const r of replies) {
      expect(r.statusCode).toBe(202);
      expect(r.json()).toEqual({ accepted: true });
    }
    expect(await events(biz.id)).toBe(1);
  });

  it("refuses money, and ignores another advertiser's id", async () => {
    const eid = 'pixelbbbbbbbbbbbbbbbbb';
    const { staff, biz } = await world(eid);
    await h.call('PUT', `/ads/advertisers/${biz.public_id}/pixel`, staff.token, { domains: ['shop.example.com'] });
    expect((await send(biz.pixel_id, eid, 'm', undefined, {}, { valueMicros: 5 })).statusCode).toBe(400);
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: '/ads/pixel',
          headers: { 'content-type': 'text/plain', origin: 'https://shop.example.com' },
          payload: JSON.stringify({ pixel: biz.pixel_id, eidToken: eid, event: 'PURCHASE', eventId: 'p' }),
        })
      ).statusCode,
    ).toBe(400);
    const other = await world('pixelccccccccccccccccc');
    await h.call('PUT', `/ads/advertisers/${other.biz.public_id}/pixel`, other.staff.token, {
      domains: ['other.example.com'],
    });
    await send(other.biz.pixel_id, eid, 'x', 'https://other.example.com');
    expect(await events(other.biz.id)).toBe(0);
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: '/ads/pixel',
          headers: { 'content-type': 'text/plain' },
          payload: 'not json',
        })
      ).statusCode,
    ).toBe(400);
  });

  it('refuses a domain that is not a plain host, in the API and the database', async () => {
    const { staff, biz } = await world('pixeldddddddddddddddddd'.slice(0, 22));
    expect(
      (await h.call('PUT', `/ads/advertisers/${biz.public_id}/pixel`, staff.token, { domains: ['https://x.com'] }))
        .statusCode,
    ).toBe(400);
    await expect(
      h.t.database.withUser(staff.id, q =>
        q.query('SELECT app.set_pixel_domains($1, $2)', [biz.public_id, ['localhost']]),
      ),
    ).rejects.toThrow(/plain host/);
  });

  it('stops when consent is withdrawn', async () => {
    const eid = 'pixeleeeeeeeeeeeeeeeee';
    const { person, staff, biz } = await world(eid);
    await h.call('PUT', `/ads/advertisers/${biz.public_id}/pixel`, staff.token, { domains: ['shop.example.com'] });
    await h.call('PUT', '/me/consents', person.token, { choices: [{ category: 'ads_partner_sites', enabled: false }] });
    await send(biz.pixel_id, eid, 'after');
    expect(await events(biz.id)).toBe(0);
  });
});

describe('GET /ads/status', () => {
  it('says what a page may do, and GPC or no permission means no signals', async () => {
    const { person } = await world('pixelffffffffffffffffff'.slice(0, 22));
    expect((await h.call('GET', '/ads/status')).json()).toEqual({ on: true, partnerSignals: false });
    expect((await h.call('GET', '/ads/status', person.token)).json()).toEqual({ on: true, partnerSignals: true });
    const gpc = await h.app.inject({
      method: 'GET',
      url: '/ads/status',
      headers: { authorization: `Bearer ${person.token}`, 'sec-gpc': '1' },
    });
    expect(gpc.json()).toEqual({ on: true, partnerSignals: false });
    const other = await member();
    expect((await h.call('GET', '/ads/status', other.token)).json()).toEqual({ on: true, partnerSignals: false });
    adsOn = false;
    expect((await h.call('GET', '/ads/status', person.token)).json()).toEqual({ on: false, partnerSignals: false });
    adsOn = true;
  });
});
