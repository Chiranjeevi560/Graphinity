// One test per verified finding of the independent review of the platform work.
import { beforeAll, describe, expect, it } from 'vitest';
import { eid } from '../src/ads/rtb.ts';
import { hashKey } from '../src/routes/ad-measurement.ts';
import { startAdWorld, crowd } from './helpers/ads.ts';
import type { TestApp } from './helpers/app.ts';
import { must } from './helpers/must.ts';

let w: Awaited<ReturnType<typeof startAdWorld>>;
let h: TestApp;

beforeAll(async () => {
  w = await startAdWorld('review', ['ads', 'ads_behavioral', 'ads_partner_sites', 'ads_audiences', 'ads_measurement']);
  h = w.h;
  return h.close;
});

async function business(name: string, suffix: string) {
  const id = must(
    (
      await h.t.owner.query<{ id: string }>(
        "INSERT INTO app.ad_advertisers (name, country, status) VALUES ($1, 'IN', 'active') RETURNING id::text",
        [name],
      )
    ).rows[0],
  ).id;
  const key = `grk_${suffix.repeat(43)}`;
  await h.t.owner.query("INSERT INTO app.ad_api_keys (advertiser_id, key_hash, prefix) VALUES ($1, $2, 'grk_xxxxxx')", [
    id,
    hashKey(key),
  ]);
  return { id, key };
}
const post = (url: string, key: string, payload: object) =>
  h.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${key}` }, payload });

describe('finding 1: removed questions', () => {
  it('show no evidence', async () => {
    const asker = await w.member();
    const answerer = await w.member();
    const q = must(
      (
        await h.call('POST', '/questions', asker.token, {
          title: 'What did customs charge on your watch this year?',
          field: 'imports-customs',
        })
      ).json<{ question: { id: string } }>().question.id,
    );
    await h.t.owner.query(
      "INSERT INTO app.answers (question_id, answerer_id, body) VALUES ($1, $2, 'I paid ₹12,000 in duty and it cleared within 3 days.')",
      [q, answerer.id],
    );
    expect(
      (await h.call('GET', `/questions/${q}/evidence`)).json<{ claims: unknown[] }>().claims.length,
    ).toBeGreaterThan(0);
    const hide = await h.t.owner.query(
      "SELECT pg_get_functiondef('app.is_question_hidden(bigint)'::regprocedure) AS d",
    );
    expect(JSON.stringify(hide.rows)).toContain('is_question_hidden');
    await h.t.owner.query('ALTER FUNCTION app.is_question_hidden(bigint) RENAME TO is_question_hidden_real');
    await h.t.owner.query(
      'CREATE FUNCTION app.is_question_hidden(bigint) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$',
    );
    await h.t.owner.query('GRANT EXECUTE ON FUNCTION app.is_question_hidden(bigint) TO app_api');
    try {
      const after = await h.call('GET', `/questions/${q}/evidence`);
      expect(after.json<{ claims: unknown[] }>().claims).toEqual([]);
    } finally {
      await h.t.owner.query('DROP FUNCTION app.is_question_hidden(bigint) CASCADE').catch(() => undefined);
      await h.t.owner.query('ALTER FUNCTION app.is_question_hidden_real(bigint) RENAME TO is_question_hidden');
    }
  });
});

describe('finding 2: rotating ids', () => {
  it('differ per business and bidder', () => {
    const s = Buffer.alloc(32, 1);
    expect(eid(s, 'ad', 0, null, 'advertiser:1')).not.toBe(eid(s, 'ad', 0, null, 'advertiser:2'));
    expect(eid(s, 'ad', 0, null, 'partner:1')).not.toBe(eid(s, 'ad', 0, null, 'advertiser:1'));
  });
  it('count only for the business they were handed to', async () => {
    const [a, b] = [await business('A co', 'a'), await business('B co', 'b')];
    const p = await w.member();
    await h.call('PUT', '/me/consents', p.token, {
      choices: [
        { category: 'ads_personalization', enabled: true },
        { category: 'ads_partner_sites', enabled: true },
      ],
    });
    await h.t.owner.query('INSERT INTO app.ad_identities (profile_id) VALUES ($1) ON CONFLICT DO NOTHING', [p.id]);
    const adId = must(
      (
        await h.t.owner.query<{ ad_id: string }>('SELECT ad_id::text FROM app.ad_identities WHERE profile_id = $1', [
          p.id,
        ])
      ).rows[0],
    ).ad_id;
    const id = 'scopescopescopescopesc';
    await h.t.owner.query(
      "INSERT INTO app.ad_eids (eid, ad_id, expires_at, scope) VALUES ($1, $2, now() + interval '1 day', 'advertiser:' || $3)",
      [id, adId, a.id],
    );
    await post('/ads/partner-events', b.key, { eidToken: id, event: 'PURCHASE', eventId: 'stolen' });
    expect((await h.t.owner.query("SELECT 1 FROM app.ad_partner_events WHERE external_id = 'stolen'")).rows).toEqual(
      [],
    );
    await post('/ads/partner-events', a.key, { eidToken: id, event: 'PURCHASE', eventId: 'own' });
    expect((await h.t.owner.query("SELECT 1 FROM app.ad_partner_events WHERE external_id = 'own'")).rows).toHaveLength(
      1,
    );
    // Finding 5: withdrawing partner sites removes it all, at once.
    await h.call('PUT', '/me/consents', p.token, { choices: [{ category: 'ads_partner_sites', enabled: false }] });
    expect((await h.t.owner.query('SELECT 1 FROM app.ad_eids WHERE ad_id = $1', [adId])).rows).toEqual([]);
    expect((await h.t.owner.query('SELECT 1 FROM app.ad_partner_events WHERE ad_id = $1', [adId])).rows).toEqual([]);
  });
});

describe('findings 3 and 8: partner match', () => {
  it('is ready and usable at 100, and three tries a day is all', async () => {
    const biz = await business('Match co', 'm');
    const { ids, adIds } = await crowd(w, 120, { travel: 2 });
    await h.t.owner.query(
      `INSERT INTO app.user_consent_settings (user_id, category, enabled, policy_version)
       SELECT id, 'ads_partner_sites', true, c.policy_version FROM unnest($1::uuid[]) AS t(id)
       JOIN app.consent_categories c ON c.name = 'ads_partner_sites'`,
      [ids],
    );
    const tokens = adIds.map((_, i) => `m${String(i).padStart(21, '0')}`);
    await h.t.owner.query(
      `INSERT INTO app.ad_eids (eid, ad_id, expires_at, scope)
       SELECT e, a, now() + interval '1 day', 'advertiser:' || $3 FROM unnest($1::text[], $2::uuid[]) AS t(e, a)`,
      [tokens, adIds, biz.id],
    );
    const ok = await post('/ads/audiences/partner-match', biz.key, { name: 'buyers', eidTokens: tokens });
    expect(ok.statusCode).toBe(201);
    const audience = ok.json<{ audience: { id: string; size: number } }>().audience;
    expect(audience.size).toBe(100);
    expect(
      must(
        (
          await h.t.owner.query<{ status: string }>('SELECT status FROM app.ad_audiences WHERE public_id = $1', [
            audience.id,
          ])
        ).rows[0],
      ).status,
    ).toBe('ready');
    await post('/ads/audiences/partner-match', biz.key, { name: 'two', eidTokens: tokens });
    await post('/ads/audiences/partner-match', biz.key, { name: 'three', eidTokens: tokens });
    const over = await post('/ads/audiences/partner-match', biz.key, { name: 'four', eidTokens: tokens });
    expect(over.json()).toEqual({ status: 'insufficient' });
    const nokey = await h.app.inject({
      method: 'POST',
      url: '/ads/audiences/partner-match',
      payload: { name: 'x', eidTokens: [] },
    });
    expect(nokey.json()).toEqual({ status: 'insufficient' });
  });
});

describe('finding 4: lift', () => {
  it('moderators can’t read it, and it draws on the day’s budget', async () => {
    const live = await w.liveCampaign([{ kind: 'field', value: 'travel' }]);
    const m = await w.member();
    await h.t.owner.query('INSERT INTO app.moderators (profile_id) VALUES ($1)', [m.id]);
    const url = `/ads/campaigns/${live.campaign}/lift`;
    expect((await h.call('GET', url, m.token)).statusCode).toBe(404);
    expect((await h.call('GET', url, live.owner.token)).statusCode).toBe(200);
    const spent = await h.t.owner.query<{ e: string }>(
      `SELECT epsilon_spent::text AS e FROM app.ad_privacy_budget_ledger l JOIN app.ad_campaigns c ON c.advertiser_id = l.advertiser_id WHERE c.public_id = $1`,
      [live.campaign],
    );
    expect(Number(must(spent.rows[0]).e)).toBeCloseTo(0.8, 5);
    await h.call('GET', url, live.owner.token);
    const again = await h.t.owner.query<{ e: string }>(
      `SELECT epsilon_spent::text AS e FROM app.ad_privacy_budget_ledger l JOIN app.ad_campaigns c ON c.advertiser_id = l.advertiser_id WHERE c.public_id = $1`,
      [live.campaign],
    );
    // Every read costs: free re-reads would show who withdrew between them.
    expect(Number(must(again.rows[0]).e)).toBeCloseTo(1.6, 5);
  });
});

describe('finding 6: account deletion', () => {
  it('takes a complaint’s words and experiment rows, and product words stay unread below 25', async () => {
    const o = h.t.owner;
    const p = await w.member();
    await h.call('POST', '/grievances', p.token, { kind: 'general', body: 'My neighbour Asha Rao posted about me.' });
    const layer = must(
      (
        await o.query<{ id: string }>(
          "INSERT INTO app.exp_layers (name) VALUES ('review') RETURNING layer_id::text AS id",
        )
      ).rows[0],
    ).id;
    await o.query(
      "INSERT INTO app.exp_definitions (layer_id, name, bucket_start, bucket_end, status) VALUES ($1, 'all', 0, 10000, 'running')",
      [layer],
    );
    await h.call('GET', '/me/experiments', p.token);
    expect((await o.query('SELECT 1 FROM app.exp_unit_metrics WHERE subject = $1', [p.id])).rows).toHaveLength(1);
    await o.query('DELETE FROM app.profiles WHERE id = $1', [p.id]);
    expect((await o.query("SELECT 1 FROM app.grievances WHERE body LIKE '%Asha%'")).rows).toEqual([]);
    expect((await o.query('SELECT 1 FROM app.exp_unit_metrics WHERE subject = $1', [p.id])).rows).toEqual([]);
    await o.query(
      "INSERT INTO app.products (key, brand, label) VALUES ('apple-refused-my-visa', 'apple', 'apple refused my visa')",
    );
    const boss = await w.member();
    await o.query('INSERT INTO app.platform_owners (profile_id) VALUES ($1)', [boss.id]);
    const seen = await h.t.database.withUser(boss.id, q =>
      q.query("SELECT 1 FROM app.products WHERE key = 'apple-refused-my-visa'"),
    );
    expect(seen.rows).toEqual([]);
  });
});

describe('finding 9: GPC on a tap', () => {
  it('leaves no click id in the destination', async () => {
    const live = await w.liveCampaign([{ kind: 'field', value: 'parenting-schools' }]);
    const p = await w.member();
    await h.call('PUT', '/me/consents', p.token, { choices: [{ category: 'ads_measurement', enabled: true }] });
    const ad = must(
      (await w.select(p.token, { placement: 'search', field: 'parenting-schools' })).find(
        a => a.headline === live.headline,
      ),
    );
    const res = await h.app.inject({
      method: 'POST',
      url: `/ads/click/${ad.token}`,
      headers: { authorization: `Bearer ${p.token}`, 'sec-gpc': '1' },
    });
    const url = new URL(res.json<{ destination: string }>().destination);
    expect(url.searchParams.has('gr_click')).toBe(false);
    expect(url.searchParams.has('gr_eid')).toBe(false);
  });
});

describe('finding 12: transitions', () => {
  it('refuse a made-up previous topic', async () => {
    await h.call('POST', '/knowledge-graph/transitions', undefined, {
      from: 'travel',
      to: 'fitness',
      previous: 'made-up-key',
    });
    expect(
      (await h.t.owner.query("SELECT 1 FROM app.kg_session_transitions WHERE prior_key = 'made-up-key'")).rows,
    ).toEqual([]);
  });
});
