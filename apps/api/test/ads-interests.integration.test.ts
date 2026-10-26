// The advertising interest graph (ADR 0022 part 2, migration 0030): a search
// or a read becomes a decaying topic score for the person's ad identity, only
// while ads_personalization is permitted; never the words; visible to the
// person, removable, exported; gone when they withdraw, or when it fades.
import { beforeAll, describe, expect, it } from 'vitest';
import { searchTopic } from '../src/ads/interests.ts';
import { startApp, type TestApp } from './helpers/app.ts';
import { must, type Body } from './helpers/must.ts';

let h: TestApp;
let names = 0;

beforeAll(async () => {
  h = await startApp(() => Date.now());
  await h.t.owner.query("UPDATE app.feature_flags SET enabled = true WHERE name IN ('ads', 'ads_behavioral')");
  await h.t.owner.query('UPDATE app.ad_jurisdiction_rules SET legal_approved = true');
  return h.close;
});

async function member(allow: boolean) {
  const p = await h.person();
  names += 1;
  expect(
    (
      await h.call('POST', '/me/profile', p.token, {
        handle: `interest.${String(names)}`,
        country: 'IN',
        fields: ['travel'],
        adult: true,
      })
    ).statusCode,
  ).toBe(201);
  await h.t.owner.query("UPDATE app.profiles SET created_at = now() - interval '2 days' WHERE id = $1", [p.id]);
  if (allow)
    expect(
      (await h.call('PUT', '/me/consents', p.token, { choices: [{ category: 'ads_personalization', enabled: true }] }))
        .statusCode,
    ).toBe(200);
  return p;
}

async function ask(token: string, title: string, field = 'imports-customs') {
  const res = await h.call('POST', '/questions', token, { title, field });
  expect(res.statusCode, res.body).toBe(201);
  return must(res.json<{ question: { id: string } }>().question.id);
}

const interests = async (token: string) =>
  (await h.call('GET', '/me/ad-interests', token)).json<{
    interests: Array<{ field: { slug: string }; strength: number }>;
  }>().interests;
const raw = (id: string) =>
  h.t.owner.query<{ field: string; score: number }>(
    `SELECT a.field, a.score FROM app.ad_interests a JOIN app.ad_identities i ON i.ad_id = a.ad_id
     WHERE i.profile_id = $1 ORDER BY a.field`,
    [id],
  );

describe('the topic of a search', () => {
  it('is its own filter, or what most of its top three results are about', () => {
    expect(searchTopic('travel', ['money-tax', 'money-tax'])).toBe('travel');
    expect(searchTopic(null, ['travel', 'money-tax', 'money-tax', 'travel', 'travel'])).toBe('money-tax');
    expect(searchTopic(null, ['travel', 'money-tax'])).toBe('travel');
    expect(searchTopic(null, [])).toBeNull();
  });
});

describe('interest signals', () => {
  it('are recorded from reads and searches only for people who allow it, as topics, never words', async () => {
    const asker = await member(false);
    const q = await ask(asker.token, 'Customs duty on a camera lens at Chennai?');
    const [yes, no] = [await member(true), await member(false)];
    for (const p of [yes, no]) {
      await h.call('GET', `/questions/${q}`, p.token);
      await h.call('POST', '/search', p.token, { query: 'customs duty camera lens' });
    }
    expect((await raw(no.id)).rows).toEqual([]);
    const rows = (await raw(yes.id)).rows;
    expect(rows.map(r => r.field)).toEqual(['imports-customs']);
    // A read (1) and a search (2), a moment apart.
    expect(rows[0]?.score).toBeCloseTo(3, 3);
    // Nothing of what was typed is kept anywhere in the ad tables.
    const dump = await h.t.owner.query('SELECT row_to_json(a)::text AS t FROM app.ad_interests a');
    expect(dump.rows.map(r => (r as { t: string }).t).join(' ')).not.toMatch(/camera|lens|customs duty/);
  });

  it('fade by half every 30 days and add up', async () => {
    const asker = await member(false);
    const q = await ask(asker.token, 'Is the ferry to the islands running in June?', 'travel');
    const p = await member(true);
    await h.call('GET', `/questions/${q}`, p.token);
    await h.t.owner.query(
      `UPDATE app.ad_interests a SET updated_at = updated_at - interval '30 days'
       FROM app.ad_identities i WHERE i.ad_id = a.ad_id AND i.profile_id = $1`,
      [p.id],
    );
    await h.call('GET', `/questions/${q}`, p.token);
    expect((await raw(p.id)).rows[0]?.score).toBeCloseTo(1.5, 3);
  });

  it('can be recorded only for the signed-in person, at a sane weight', async () => {
    const [a, b] = [await member(true), await member(true)];
    await expect(
      h.t.database.withUser(a.id, q => q.query("SELECT app.record_ad_interest($1, 'travel', 1)", [b.id])),
    ).rejects.toThrow(/signed-in person/);
    await expect(
      h.t.database.withUser(a.id, q => q.query("SELECT app.record_ad_interest($1, 'travel', 50)", [a.id])),
    ).rejects.toThrow(/at most 10/);
    expect(
      await h.t.database.withUser(a.id, async q => (await q.query('SELECT 1 FROM app.ad_interests')).rowCount),
    ).toBe(0);
  });
});

describe('the person’s advertising profile', () => {
  it('shows their topics relative to the strongest, lets them remove one, and is in their export', async () => {
    const p = await member(true);
    await h.t.database.withUser(p.id, async q => {
      await q.query("SELECT app.record_ad_interest($1, 'travel', 4)", [p.id]);
      await q.query("SELECT app.record_ad_interest($1, 'money-tax', 1)", [p.id]);
    });
    expect((await interests(p.token)).map(i => [i.field.slug, i.strength])).toEqual([
      ['travel', 100],
      ['money-tax', 25],
    ]);
    const exported = (await h.call('GET', '/me/data-export', p.token)).json<{
      adInterests: Array<{ field: string }>;
    }>();
    expect(exported.adInterests.map(i => i.field)).toEqual(['travel', 'money-tax']);
    expect((await h.call('DELETE', '/me/ad-interests/travel', p.token)).statusCode).toBe(200);
    expect((await interests(p.token)).map(i => i.field.slug)).toEqual(['money-tax']);
    expect((await h.call('DELETE', '/me/ad-interests/travel', p.token)).json<Body>().error).toBe('not_found');
    // Someone else's view of it: nothing.
    const other = await member(false);
    expect(await interests(other.token)).toEqual([]);
  });

  it('is gone the moment they turn personalized ads off, and new signals stop', async () => {
    const p = await member(true);
    await h.t.database.withUser(p.id, q => q.query("SELECT app.record_ad_interest($1, 'travel', 2)", [p.id]));
    await h.call('PUT', '/me/consents', p.token, { choices: [{ category: 'ads_personalization', enabled: false }] });
    expect((await raw(p.id)).rows).toEqual([]);
    expect(
      await h.t.database.withUser(
        p.id,
        async q =>
          (await q.query<{ ok: boolean }>("SELECT app.record_ad_interest($1, 'travel', 2) AS ok", [p.id])).rows[0]?.ok,
      ),
    ).toBe(false);
  });

  it('fades out after 13 months, or once almost nothing is left, by the server’s own job only', async () => {
    const [old, faint, fresh] = [await member(true), await member(true), await member(true)];
    for (const p of [old, faint, fresh])
      await h.t.database.withUser(p.id, q => q.query("SELECT app.record_ad_interest($1, 'travel', 1)", [p.id]));
    await h.t.owner.query(
      `UPDATE app.ad_interests a SET updated_at = now() - interval '14 months', score = 1000
       FROM app.ad_identities i WHERE i.ad_id = a.ad_id AND i.profile_id = $1`,
      [old.id],
    );
    await h.t.owner.query(
      `UPDATE app.ad_interests a SET score = 0.001
       FROM app.ad_identities i WHERE i.ad_id = a.ad_id AND i.profile_id = $1`,
      [faint.id],
    );
    await expect(h.t.database.withUser(fresh.id, q => q.query('SELECT app.expire_ad_interests()'))).rejects.toThrow();
    await h.t.database.asSystem(q => q.query('SELECT app.expire_ad_interests()'));
    expect((await raw(old.id)).rows).toEqual([]);
    expect((await raw(faint.id)).rows).toEqual([]);
    expect((await raw(fresh.id)).rows).toHaveLength(1);
  });
});
