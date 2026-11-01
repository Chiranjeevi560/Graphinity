import { createHmac } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { pushCohorts, pushKey, type PushFetcher } from '../src/ads/partner-push.ts';
import { crowd, startAdWorld } from './helpers/ads.ts';
import type { TestApp } from './helpers/app.ts';

const secret = Buffer.alloc(32, 9);
const NOW = Date.now();
let w: Awaited<ReturnType<typeof startAdWorld>>;
let h: TestApp;

interface Sent {
  url: string;
  body: string;
  signature: string | undefined;
  redirect: string;
}
function recorder(status = 200) {
  const sent: Sent[] = [];
  const fetcher: PushFetcher = (url, init) => {
    sent.push({ url, body: init.body, signature: init.headers['x-graphinity-signature'], redirect: init.redirect });
    return Promise.resolve({ status });
  };
  return { sent, fetcher };
}
const run = (fetcher: PushFetcher, at = NOW) => pushCohorts(h.t.database, fetcher, secret, at);
const clear = () => h.t.owner.query('DELETE FROM app.ad_partner_pushes');

/** People who allow partner use, with this interest. */
async function allowing(n: number, field: string, score = 9) {
  const { ids, adIds } = await crowd(w, n, { [field]: score });
  await h.t.owner.query(
    `INSERT INTO app.user_consent_settings (user_id, category, enabled, policy_version)
     SELECT id, 'ads_partner_cohorts', true, c.policy_version FROM unnest($1::uuid[]) AS t(id)
     JOIN app.consent_categories c ON c.name = 'ads_partner_cohorts'`,
    [ids],
  );
  return { ids, adIds };
}

beforeAll(async () => {
  w = await startAdWorld('push', ['ads', 'ads_behavioral', 'ads_partner_sites']);
  h = w.h;
  await h.t.owner.query(
    `INSERT INTO app.ad_partners (name, endpoint, enabled, push_endpoint) VALUES
       ('one', 'https://rtb.one.example/bid', true, 'https://push.one.example/in'),
       ('two', 'https://rtb.two.example/bid', true, 'https://push.two.example/in'),
       ('off', 'https://rtb.off.example/bid', false, 'https://push.off.example/in'),
       ('none', 'https://rtb.none.example/bid', true, NULL)`,
  );
  return h.close;
});

describe('pushing cohorts to partners', () => {
  it('sends nothing with its switch off, whatever else is ready', async () => {
    const flag = (on: boolean) =>
      h.t.owner.query(`UPDATE app.feature_flags SET enabled = $1 WHERE name = 'ads_partner_push'`, [on]);
    await flag(true);
    await allowing(120, 'travel');
    await flag(false);
    const { sent, fetcher } = recorder();
    expect(await run(fetcher)).toBe(0);
    expect(sent).toHaveLength(0);
    await flag(true);
  });

  it('sends enabled partners with an address a signed list, scoped to each, naming nobody', async () => {
    const { sent, fetcher } = recorder();
    await clear();
    await run(fetcher);
    const travel = sent.filter(s => (JSON.parse(s.body) as { segment: string }).segment === 'travel');
    expect(travel.map(s => s.url).sort()).toEqual(['https://push.one.example/in', 'https://push.two.example/in']);
    const [a, b] = travel.map(s => JSON.parse(s.body) as { eids: string[] });
    expect(a?.eids.length).toBeGreaterThanOrEqual(100);
    expect(a?.eids.filter(e => b?.eids.includes(e))).toEqual([]);
    const { rows } = await h.t.owner.query<{ id: string; ad: string }>(
      `SELECT partner.id::text AS id, i.ad_id::text AS ad FROM app.ad_partners partner, app.ad_identities i
       WHERE partner.name = 'one' LIMIT 50`,
    );
    for (const s of travel) {
      expect(s.redirect).toBe('error');
      for (const r of rows) {
        expect(s.body).not.toContain(r.ad);
      }
    }
    const first = rows[0]?.id ?? '';
    const one = travel.find(s => s.url.includes('one')) as Sent;
    expect(one.signature).toBe(createHmac('sha256', pushKey(secret, first)).update(one.body).digest('hex'));
  });

  it('sends a topic at most once a day, even if delivery failed', async () => {
    await clear();
    const failing = recorder(500);
    await run(failing.fetcher);
    expect(failing.sent.length).toBeGreaterThan(0);
    const again = recorder();
    await run(again.fetcher);
    expect(again.sent).toHaveLength(0);
    const { rows } = await h.t.owner.query<{ delivered: boolean }>('SELECT delivered FROM app.ad_partner_pushes');
    expect(rows.every(r => !r.delivered)).toBe(true);
    const tomorrow = recorder();
    expect(await run(tomorrow.fetcher, NOW + 86_400_000)).toBeGreaterThan(0);
  });

  it('survives a partner that cannot be reached', async () => {
    await clear();
    expect(await run(() => Promise.reject(new Error('down')))).toBe(0);
  });

  it('leaves out topics under 100, faint or old interest, and anyone who withdrew', async () => {
    await clear();
    await allowing(99, 'imports-customs');
    await allowing(120, 'study-abroad', 2);
    const old = await allowing(120, 'visas-immigration');
    await h.t.owner.query(`UPDATE app.ad_interests SET updated_at = now() - interval '31 days' WHERE ad_id = ANY($1)`, [
      old.adIds,
    ]);
    const { sent, fetcher } = recorder();
    await run(fetcher);
    const segments = new Set(sent.map(s => (JSON.parse(s.body) as { segment: string }).segment));
    expect(segments.has('imports-customs')).toBe(false);
    expect(segments.has('study-abroad')).toBe(false);
    expect(segments.has('visas-immigration')).toBe(false);
    // Withdrawing takes a topic below the floor at the next push.
    await clear();
    const { rows } = await h.t.owner.query<{ id: string }>(
      `SELECT i.profile_id::text AS id FROM app.ad_interests a JOIN app.ad_identities i ON i.ad_id = a.ad_id WHERE a.field = 'travel'`,
    );
    await h.t.owner.query(
      `UPDATE app.user_consent_settings SET enabled = false WHERE category = 'ads_partner_cohorts' AND user_id = ANY($1)`,
      [rows.map(r => r.id)],
    );
    const after = recorder();
    await run(after.fetcher);
    expect(after.sent.filter(s => s.body.includes('"travel"'))).toHaveLength(0);
  });

  it('never sends health, immigration or legal topics, however many people', async () => {
    await clear();
    await allowing(120, 'health-hospitals');
    await allowing(120, 'legal-matters');
    const { sent, fetcher } = recorder();
    await run(fetcher);
    for (const s of sent) {
      expect(s.body).not.toContain('health-hospitals');
      expect(s.body).not.toContain('legal-matters');
    }
  });

  it("gives one person a different id per topic and per day, so lists can't be joined into a profile", async () => {
    await clear();
    await allowing(120, 'cars-vehicles');
    const ids = (at: number) => async (segment: string) => {
      await clear();
      const r = recorder();
      await run(r.fetcher, at);
      const body = r.sent.find(s => s.url.includes('one') && s.body.includes(`"${segment}"`));
      return new Set((JSON.parse(body?.body ?? '{"eids":[]}') as { eids: string[] }).eids);
    };
    const today = await ids(NOW)('cars-vehicles');
    const tomorrow = await ids(NOW + 86_400_000)('cars-vehicles');
    expect(today.size).toBeGreaterThanOrEqual(100);
    expect([...today].filter(e => tomorrow.has(e))).toEqual([]);
    // In an order that says nothing: score order would link someone across days.
    expect([...today]).toEqual([...today].sort());
  });

  it('asks nobody about this until its switch allows it', async () => {
    await h.t.owner.query(`UPDATE app.feature_flags SET enabled = false WHERE name = 'ads_partner_push'`);
    const person = await w.member();
    const offered = async () =>
      (await h.call('GET', '/me/consents', person.token))
        .json<{ categories: Array<{ name: string }> }>()
        .categories.some(c => c.name === 'ads_partner_cohorts');
    expect(await offered()).toBe(false);
    await h.t.owner.query(`UPDATE app.feature_flags SET enabled = true WHERE name = 'ads_partner_push'`);
    expect(await offered()).toBe(true);
  });

  it('refuses a local or plain-text address, and a person can read nothing here', async () => {
    for (const bad of ['http://a.example/x', 'https://127.0.0.1/x', 'https://push.localhost/x', 'https://a.internal/x'])
      await expect(
        h.t.owner.query(`UPDATE app.ad_partners SET push_endpoint = $1 WHERE name = 'one'`, [bad]),
      ).rejects.toThrow();
    const reader = await h.person();
    const seen = await h.t.database.withUser(reader.id, q => q.query('SELECT 1 FROM app.ad_partner_pushes'));
    expect(seen.rowCount).toBe(0);
  });
});
