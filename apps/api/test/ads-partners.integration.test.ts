// Outside bidders (ADR 0022 part 9a), through the real server and database: a partner takes a
// slot only by outbidding our own ad, nothing about a person leaves without their permission,
// GPC and sensitive pages stop it entirely, and the switches and table can't be got around.
import { beforeAll, describe, expect, it } from 'vitest';
import { createAdServer } from '../src/ads/serve.ts';
import { createExchange, type Fetcher } from '../src/ads/exchange.ts';
import { startApp, type TestApp } from './helpers/app.ts';
import { must } from './helpers/must.ts';

let h: TestApp;
let rtbOn = true;
const sent: Array<Record<string, unknown>> = [];
let price = 500;

const fetcher: Fetcher = (_url, init) => {
  const request = JSON.parse(init.body) as Record<string, unknown>;
  sent.push(request);
  return Promise.resolve({
    status: 200,
    headers: { get: () => null },
    text: () =>
      Promise.resolve(
        JSON.stringify({
          id: request.id,
          seatbid: [
            {
              seat: 's',
              bid: [
                {
                  impid: '1',
                  price,
                  adomain: ['boats.example'],
                  adm: JSON.stringify({
                    assets: [
                      { id: 1, title: { text: 'Boats by the day' } },
                      { id: 2, data: { value: 'Hire one in Panaji.' } },
                    ],
                    link: { url: 'https://boats.example/hire' },
                  }),
                },
              ],
            },
          ],
        }),
      ),
  });
};

beforeAll(async () => {
  const holder: { server?: ReturnType<typeof createAdServer> } = {};
  h = await startApp(() => Date.now(), {
    adsEnabled: () => true,
    adServer: {
      serve: input => must(holder.server).serve(input),
      refresh: () => must(holder.server).refresh(),
    },
  });
  holder.server = createAdServer(h.t.database, {
    enabled: () => rtbOn,
    exchange: createExchange(fetcher),
    secret: Buffer.alloc(32, 3),
    site: 'graphinity.example',
    currency: 'INR',
  });
  await h.t.owner.query(
    "UPDATE app.feature_flags SET enabled = true WHERE name IN ('ads','ads_rtb','ads_behavioral','ads_partner_sites')",
  );
  await h.t.owner.query('UPDATE app.ad_jurisdiction_rules SET legal_approved = true');
  await h.t.owner.query(
    "INSERT INTO app.ad_partners (name, endpoint, enabled) VALUES ('p', 'https://bid.partner.example/rtb', true)",
  );
  return h.close;
});

const select = (token: string | undefined, headers: Record<string, string> = {}, field = 'travel') =>
  h.app.inject({
    method: 'POST',
    url: '/ads/select',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    payload: { placement: 'search', field },
  });
type Ads = { ads: Array<{ token: string; headline: string; domain: string; label: string }> };

async function member(handle: string, allow: boolean) {
  const p = await h.person();
  await h.call('POST', '/me/profile', p.token, { handle, country: 'IN', fields: ['travel'], adult: true });
  if (allow)
    await h.call('PUT', '/me/consents', p.token, {
      choices: [
        { category: 'ads_personalization', enabled: true },
        { category: 'ads_partner_sites', enabled: true },
      ],
    });
  return p;
}

describe('an outside bid', () => {
  it('fills a slot, labelled, and a tap leads to its address once', async () => {
    const res = await select(undefined);
    const ad = must(res.json<Ads>().ads[0]);
    expect(ad).toMatchObject({ headline: 'Boats by the day', domain: 'boats.example', label: 'Sponsored' });
    const tap = await h.call('POST', `/ads/click/${ad.token}`);
    expect(tap.json()).toEqual({ destination: 'https://boats.example/hire' });
    await h.call('POST', `/ads/click/${ad.token}`);
    const { rows } = await h.t.owner.query<{ clicked: Date | null }>(
      'SELECT clicked_at AS clicked FROM app.ad_partner_impressions WHERE token = $1',
      [ad.token],
    );
    expect(rows[0]?.clicked).not.toBeNull();
  });

  it('below every floor wins nothing', async () => {
    price = 0.001;
    try {
      expect((await select(undefined)).json<Ads>().ads).toEqual([]);
    } finally {
      price = 500;
    }
  });
});

describe('what leaves Graphinity', () => {
  it('holds nothing of a signed-out reader or one who has not allowed it', async () => {
    const p = await member('rtb.no', false);
    sent.length = 0;
    await select(p.token, { 'user-agent': 'Mozilla/5.0 (iPhone) Mobile' });
    const request = must(sent[0]);
    expect(request.user).toBeUndefined();
    const json = JSON.stringify(request);
    expect(json).not.toContain(p.id);
    expect(json).not.toContain('iPhone');
    expect(json).not.toContain('rtb.no');
    expect((request.device as { ip?: string }).ip).toBeUndefined();
  });

  it('holds a rotating id, never the account, for one who allows it; GPC stops that outright', async () => {
    const p = await member('rtb.yes', true);
    sent.length = 0;
    await select(p.token);
    const allowed = must(sent[0]);
    expect((allowed.user as { eids: unknown[] }).eids).toHaveLength(1);
    expect(JSON.stringify(allowed)).not.toContain(p.id);
    sent.length = 0;
    await select(p.token, { 'sec-gpc': '1' });
    expect(must(sent[0]).user).toBeUndefined();
  });

  it('is nothing at all for a sensitive page, or with the switch off', async () => {
    sent.length = 0;
    await select(undefined, {}, 'health-hospitals');
    expect(sent).toEqual([]);
    rtbOn = false;
    try {
      const server = createAdServer(h.t.database, {
        enabled: () => rtbOn,
        exchange: createExchange(fetcher),
        secret: Buffer.alloc(32, 3),
        site: 'x.example',
        currency: 'INR',
      });
      await server.refresh();
      await server.serve({ placement: 'search', fields: ['travel'], query: null, viewer: null, now: Date.now() });
      expect(sent).toEqual([]);
    } finally {
      rtbOn = true;
    }
  });
});

describe('the database', () => {
  it('refuses a partner address that could reach inside', async () => {
    for (const endpoint of [
      'http://bid.example/',
      'https://169.254.169.254/latest',
      'https://localhost/',
      'https://db.internal/',
      'https://user:pw@bid.example/',
      'https://bid.example:8443/',
    ])
      await expect(
        h.t.owner.query("INSERT INTO app.ad_partners (name, endpoint) VALUES ('x' || $1, $1)", [endpoint]),
      ).rejects.toThrow(/check/i);
  });

  it('lets the API role add no partner, and read none outside system work', async () => {
    const c = h.t.api;
    await expect(
      c.query("INSERT INTO app.ad_partners (name, endpoint) VALUES ('evil', 'https://evil.example/')"),
    ).rejects.toThrow(/permission/i);
    expect((await c.query('SELECT 1 FROM app.ad_partners')).rows).toEqual([]);
    expect((await c.query('SELECT 1 FROM app.ad_partner_impressions')).rows).toEqual([]);
  });

  it('counts no tap once the switch is off', async () => {
    const ad = must((await select(undefined)).json<Ads>().ads[0]);
    await h.t.owner.query("UPDATE app.feature_flags SET enabled = false WHERE name = 'ads_rtb'");
    try {
      expect((await h.call('POST', `/ads/click/${ad.token}`)).statusCode).toBe(404);
    } finally {
      await h.t.owner.query("UPDATE app.feature_flags SET enabled = true WHERE name = 'ads_rtb'");
    }
  });
});
