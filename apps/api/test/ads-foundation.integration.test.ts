// The advertising platform's privacy foundation (ADR 0022, migration 0029):
// whether a person's data may be used for an ad purpose is decided in the
// database from the switches, the law for their country (approved by a
// lawyer) and their own choice; ad systems know people only by a rotating
// random id; and no ad table can ever point at a person directly.
import { beforeAll, describe, expect, it } from 'vitest';
import { adIdentity, adsPermitted, AD_PURPOSES, type AdPurpose } from '../src/ads/identity.ts';
import { startApp, type TestApp } from './helpers/app.ts';
import { type Body } from './helpers/must.ts';

let h: TestApp;
let names = 0;

beforeAll(async () => {
  h = await startApp(() => Date.now());
  return h.close;
});

async function member(country = 'IN') {
  const p = await h.person();
  names += 1;
  expect(
    (
      await h.call('POST', '/me/profile', p.token, {
        handle: `ads.${String(names)}`,
        country,
        fields: ['travel'],
        adult: true,
      })
    ).statusCode,
  ).toBe(201);
  return p;
}

const flags = (
  on: boolean,
  names = ['ads', 'ads_behavioral', 'ads_measurement', 'ads_cross_device', 'ads_partner_sites'],
) => h.t.owner.query('UPDATE app.feature_flags SET enabled = $1 WHERE name = ANY($2)', [on, names]);
const approve = (on: boolean) => h.t.owner.query('UPDATE app.ad_jurisdiction_rules SET legal_approved = $1', [on]);
const choose = (token: string, category: string, enabled: boolean) =>
  h.call('PUT', '/me/consents', token, { choices: [{ category, enabled }] });
const permitted = (id: string, purpose: AdPurpose) => h.t.database.asSystem(q => adsPermitted(q, id, purpose));

describe('what ad systems may use', () => {
  it('nothing while the platform is off, whatever anyone chose', async () => {
    const p = await member();
    for (const purpose of AD_PURPOSES) expect(await permitted(p.id, purpose)).toBe(false);
    // Not even offered: the choice can't be turned on.
    expect((await choose(p.token, 'ads_personalization', true)).json<Body>().error).toBe('unknown_consent_category');
    const { categories } = (await h.call('GET', '/me/consents', p.token)).json<{
      categories: Array<{ name: string }>;
    }>();
    expect(categories.some(c => c.name.startsWith('ads_'))).toBe(false);
  });

  it('only with the switches on, a lawyer’s approval for the country, and the person’s yes', async () => {
    const p = await member();
    await flags(true);
    try {
      // Offered now, and off until chosen.
      const { categories } = (await h.call('GET', '/me/consents', p.token)).json<{
        categories: Array<{ name: string; enabled: boolean }>;
      }>();
      expect(categories.filter(c => c.name.startsWith('ads_')).map(c => [c.name, c.enabled])).toEqual(
        [...AD_PURPOSES].sort().map(n => [n, false]),
      );
      expect((await choose(p.token, 'ads_personalization', true)).statusCode).toBe(200);
      // Chosen, but no lawyer has approved the rule: still no.
      expect(await permitted(p.id, 'ads_personalization')).toBe(false);
      await approve(true);
      expect(await permitted(p.id, 'ads_personalization')).toBe(true);
      // Another purpose the person never chose stays off (opt-in everywhere by default).
      expect(await permitted(p.id, 'ads_measurement')).toBe(false);
      // The purpose's own switch.
      await flags(false, ['ads_behavioral']);
      expect(await permitted(p.id, 'ads_personalization')).toBe(false);
      await flags(true, ['ads_behavioral']);
      // The master switch.
      await flags(false, ['ads']);
      expect(await permitted(p.id, 'ads_personalization')).toBe(false);
      await flags(true, ['ads']);
      // Their no.
      await choose(p.token, 'ads_personalization', false);
      expect(await permitted(p.id, 'ads_personalization')).toBe(false);
    } finally {
      await flags(false);
      await approve(false);
    }
  });

  it('follows the person’s own country before the default, prohibited or opt-out', async () => {
    const [india, usa] = [await member('IN'), await member('US')];
    await flags(true);
    await approve(true);
    try {
      await choose(india.token, 'ads_personalization', true);
      await choose(usa.token, 'ads_personalization', true);
      await h.t.owner.query(
        "INSERT INTO app.ad_jurisdiction_rules (country, purpose, basis, legal_approved) VALUES ('IN', 'ads_personalization', 'prohibited', true)",
      );
      expect(await permitted(india.id, 'ads_personalization')).toBe(false);
      expect(await permitted(usa.id, 'ads_personalization')).toBe(true);
      // Where the law allows opting out: on unless they said no.
      await h.t.owner.query(
        "INSERT INTO app.ad_jurisdiction_rules (country, purpose, basis, legal_approved) VALUES ('US', 'ads_measurement', 'opt_out', true)",
      );
      expect(await permitted(usa.id, 'ads_measurement')).toBe(true);
      await choose(usa.token, 'ads_measurement', false);
      expect(await permitted(usa.id, 'ads_measurement')).toBe(false);
      // A country rule not yet approved blocks there, even if the default is approved.
      await h.t.owner.query(
        "INSERT INTO app.ad_jurisdiction_rules (country, purpose, basis, legal_approved) VALUES ('US', 'ads_cross_device', 'opt_in', false)",
      );
      await choose(usa.token, 'ads_cross_device', true);
      expect(await permitted(usa.id, 'ads_cross_device')).toBe(false);
    } finally {
      await h.t.owner.query('DELETE FROM app.ad_jurisdiction_rules WHERE country IS NOT NULL');
      await flags(false);
      await approve(false);
    }
  });

  it('lets anyone who said yes withdraw even after the platform is switched off', async () => {
    const p = await member();
    await flags(true);
    await choose(p.token, 'ads_personalization', true);
    await flags(false);
    const { categories } = (await h.call('GET', '/me/consents', p.token)).json<{
      categories: Array<{ name: string }>;
    }>();
    expect(categories.map(c => c.name)).toContain('ads_personalization');
    expect((await choose(p.token, 'ads_personalization', false)).statusCode).toBe(200);
    // And the database itself refuses turning one on while it isn't offered.
    await expect(
      h.t.database.withUser(p.id, q =>
        q.query(
          "UPDATE app.user_consent_settings SET enabled = true WHERE user_id = $1 AND category = 'ads_personalization'",
          [p.id],
        ),
      ),
    ).rejects.toThrow(/not offered/);
  });
});

describe('ad identities', () => {
  it('are stable random ids, and change the moment personalized ads are turned off', async () => {
    const p = await member();
    const first = await h.t.database.asSystem(q => adIdentity(q, p.id));
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(first).not.toBe(p.id);
    expect(await h.t.database.asSystem(q => adIdentity(q, p.id))).toBe(first);
    await flags(true);
    try {
      // Saying yes keeps it; saying no rotates it.
      await choose(p.token, 'ads_personalization', true);
      expect(await h.t.database.asSystem(q => adIdentity(q, p.id))).toBe(first);
      await choose(p.token, 'ads_personalization', false);
      const second = await h.t.database.asSystem(q => adIdentity(q, p.id));
      expect(second).not.toBe(first);
      const { rows } = await h.t.owner.query<{ epoch: number }>(
        'SELECT epoch FROM app.ad_identities WHERE profile_id = $1',
        [p.id],
      );
      expect(rows[0]?.epoch).toBe(2);
    } finally {
      await flags(false);
    }
  });

  it('are visible to the server’s own jobs only, and the law’s rules to nobody’s edits', async () => {
    const p = await member();
    await h.t.database.asSystem(q => adIdentity(q, p.id));
    expect(
      await h.t.database.withUser(p.id, async q => (await q.query('SELECT 1 FROM app.ad_identities')).rowCount),
    ).toBe(0);
    await expect(h.t.database.withUser(p.id, q => adIdentity(q, p.id))).rejects.toThrow();
    await expect(
      h.t.database.asSystem(q => q.query('UPDATE app.ad_jurisdiction_rules SET legal_approved = true')),
    ).rejects.toThrow();
  });

  it('go with the account', async () => {
    const p = await member();
    await h.t.database.asSystem(q => adIdentity(q, p.id));
    expect((await h.call('DELETE', '/me', p.token, { confirm: true })).statusCode).toBeLessThan(300);
    expect((await h.t.owner.query('SELECT 1 FROM app.ad_identities WHERE profile_id = $1', [p.id])).rowCount).toBe(0);
  });
});

describe('the separation of people from ad systems', () => {
  it('no ad table but the identity map refers to a person', async () => {
    const { rows } = await h.t.owner.query<{ table: string }>(
      `SELECT DISTINCT c.conrelid::regclass::text AS table
       FROM pg_constraint c
       WHERE c.contype = 'f' AND c.confrelid = 'app.profiles'::regclass
         AND c.conrelid::regclass::text LIKE 'app.ad\\_%'`,
    );
    // Advertiser accounts (people who run ads) arrive with campaigns and are listed here when they do.
    expect(rows.map(r => r.table)).toEqual(['app.ad_identities']);
    const columns = await h.t.owner.query<{ table: string; column: string }>(
      `SELECT table_name AS table, column_name AS column FROM information_schema.columns
       WHERE table_schema = 'app' AND table_name LIKE 'ad\\_%' AND table_name <> 'ad_identities'
         AND column_name IN ('profile_id', 'user_id', 'asker_id', 'answerer_id', 'handle')`,
    );
    expect(columns.rows).toEqual([]);
  });
});
