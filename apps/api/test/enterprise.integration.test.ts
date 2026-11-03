// Enterprise analytics (ADR 0033) through the real server and Postgres as the restricted role: off by default,
// the owner alone manages organizations, and a key reads only noised totals, within its quota, until revoked.
import { beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './helpers/app.ts';
import { must } from './helpers/must.ts';

let h: TestApp;
let on = false;
let n = 0;

beforeAll(async () => {
  h = await startApp(() => Date.now(), { enterpriseEnabled: () => on });
  return h.close;
});

async function member() {
  const p = await h.person();
  n += 1;
  expect(
    (
      await h.call('POST', '/me/profile', p.token, {
        handle: `ent.${String(n)}`,
        country: 'IN',
        fields: ['phones-gadgets'],
        adult: true,
      })
    ).statusCode,
  ).toBe(201);
  return p;
}
async function owner() {
  const p = await member();
  await h.t.owner.query('INSERT INTO app.platform_owners (profile_id) VALUES ($1)', [p.id]);
  return p;
}
const flag = (enabled: boolean) =>
  h.t.owner.query("UPDATE app.feature_flags SET enabled = $1 WHERE name = 'enterprise_analytics'", [enabled]);
const read = (key: string, path = '/enterprise/v1/topics/phones-gadgets') =>
  h.app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${key}` } });

async function orgWithKey(o: { token: string }, dailyReads = 1000) {
  const made = await h.call('POST', '/owner/enterprise/orgs', o.token, { name: 'Phone Research Ltd', dailyReads });
  expect(made.statusCode).toBe(201);
  const id = made.json<{ org: { id: string } }>().org.id;
  const k = await h.call('POST', `/owner/enterprise/orgs/${id}/keys`, o.token);
  expect(k.statusCode).toBe(201);
  return k.json<{ key: string; prefix: string }>();
}

beforeAll(async () => {
  const product = must(
    (
      await h.t.owner.query<{ id: string }>(
        "INSERT INTO app.products (key, brand, label, k_reached) VALUES ('phone-x', 'acme', 'Acme Phone X', true) RETURNING id::text",
      )
    ).rows[0],
  ).id;
  await h.t.owner.query(
    `INSERT INTO app.olap_daily_commerce_cube (day, field_id, product_entity_id, k_distinct_contributors, dp_noisy_intent_count, holt_winters_forecast_30d)
     VALUES (current_date - 1, 'phones-gadgets', $1, 30, 42, 300), (current_date - 200, 'phones-gadgets', $1, 30, 9, NULL)`,
    [product],
  );
});

describe('enterprise analytics', () => {
  it('is off by default, in the API and in the database', async () => {
    const o = await owner();
    const { key } = await orgWithKey(o);
    const res = await read(key);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'enterprise_off' });
    // Even with the API's switch on, the database refuses while its switch is off.
    on = true;
    try {
      expect((await read(key)).statusCode).toBe(404);
    } finally {
      on = false;
    }
  });

  it('only the owner adds organizations and makes keys, and only a hash is kept', async () => {
    const someone = await member();
    expect((await h.call('POST', '/owner/enterprise/orgs', someone.token, { name: 'Sneaky Co' })).statusCode).toBe(403);
    expect((await h.call('GET', '/owner/enterprise/orgs', someone.token)).statusCode).toBe(403);
    const o = await owner();
    const { key, prefix } = await orgWithKey(o);
    expect(key).toMatch(/^gre_[A-Za-z0-9_-]{43}$/);
    const stored = await h.t.owner.query<{ key_hash: string }>(
      'SELECT key_hash FROM app.enterprise_keys WHERE prefix = $1',
      [prefix],
    );
    expect(must(stored.rows[0]).key_hash).not.toContain(key.slice(4));
    // The restricted role, as someone else, sees no organization and can't count reads for itself.
    await h.t.database.withUser(someone.id, async q => {
      expect((await q.query('SELECT 1 FROM app.enterprise_orgs')).rowCount).toBe(0);
      expect((await q.query('SELECT 1 FROM app.enterprise_keys')).rowCount).toBe(0);
      await expect(
        q.query('INSERT INTO app.enterprise_reads (org_id, day, reads) VALUES (1, current_date, 0)'),
      ).rejects.toThrow();
    });
  });

  it('reads noised totals for the last days asked, then stops at the quota, and a revoked key stops at once', async () => {
    const o = await owner();
    const { key, prefix } = await orgWithKey(o, 2);
    await flag(true);
    on = true;
    try {
      const first = await read(key);
      expect(first.statusCode).toBe(200);
      const body = first.json<{ rows: Array<{ product: string; noisyCount: number }> }>();
      // Only the last 30 days by default: the old row isn't read.
      expect(body.rows).toEqual([
        expect.objectContaining({ product: 'Acme Phone X', noisyCount: 42, forecast30d: 300 }),
      ]);
      expect((await read(key, '/enterprise/v1/topics/travel')).json<{ rows: unknown[] }>().rows).toEqual([]);
      const third = await read(key);
      expect(third.statusCode).toBe(429);
      expect(third.json()).toMatchObject({ error: 'quota' });

      const fresh = await orgWithKey(o);
      expect((await read(fresh.key, '/enterprise/v1/topics/phones-gadgets?days=90')).statusCode).toBe(200);
      expect((await h.call('DELETE', `/owner/enterprise/keys/${fresh.prefix}`, o.token)).statusCode).toBe(204);
      expect((await read(fresh.key)).json()).toMatchObject({ error: 'bad_key' });
      expect((await read(`gre_${'x'.repeat(43)}`)).statusCode).toBe(401);
      expect((await read('not-a-key')).statusCode).toBe(401);
      expect((await read(key, '/enterprise/v1/topics/phones-gadgets?days=91')).statusCode).toBe(400);
      expect(prefix).toMatch(/^gre_/);
    } finally {
      on = false;
      await flag(false);
    }
  });
});
