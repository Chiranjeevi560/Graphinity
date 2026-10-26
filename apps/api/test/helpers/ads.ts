// A test world for the advertising platform (ADR 0022): a server whose ad
// switch a test can flip, the real ad server over the test database
// (refreshed on demand), and helpers for people, live campaigns and
// questions. Each world's campaigns bid a little more than the last, so the
// one under test wins its auction against those earlier tests left running.
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { createAdServer } from '../../src/ads/serve.ts';
import { startApp, type TestApp } from './app.ts';
import { must } from './must.ts';

export type Ad = { token: string; headline: string; domain: string; label: string; advertiser: string };

export async function startAdWorld(prefix: string, flags: readonly string[] = ['ads', 'ads_behavioral']) {
  let names = 0;
  let on = true;
  const holder: { server: ReturnType<typeof createAdServer> | null } = { server: null };
  const h: TestApp = await startApp(() => Date.now(), {
    adsEnabled: () => on,
    adServer: {
      serve: (input: Parameters<ReturnType<typeof createAdServer>['serve']>[0]) => must(holder.server).serve(input),
      refresh: () => must(holder.server).refresh(),
    },
  });
  holder.server = createAdServer(h.t.database);
  await h.t.owner.query('UPDATE app.feature_flags SET enabled = true WHERE name = ANY($1)', [[...flags]]);
  await h.t.owner.query('UPDATE app.ad_jurisdiction_rules SET legal_approved = true');
  const server = () => must(holder.server);

  async function member(country = 'IN') {
    const p = await h.person();
    names += 1;
    const handle = `${prefix}.${String(names)}`;
    expect(
      (await h.call('POST', '/me/profile', p.token, { handle, country, fields: ['travel'], adult: true })).statusCode,
    ).toBe(201);
    await h.t.owner.query("UPDATE app.profiles SET created_at = now() - interval '2 days' WHERE id = $1", [p.id]);
    return { ...p, handle };
  }

  /** A business with one active campaign and one approved ad, targeted as given. */
  async function liveCampaign(targets: Array<{ kind: string; value: string }>, over: Record<string, number> = {}) {
    const owner = await member();
    const advertiser = must(
      (
        await h.call('POST', '/ads/advertisers', owner.token, { name: `Business ${String(names)}`, country: 'IN' })
      ).json<{
        advertiser: { id: string };
      }>().advertiser.id,
    );
    const campaign = must(
      (
        await h.call('POST', `/ads/advertisers/${advertiser}/campaigns`, owner.token, {
          name: 'Ferries',
          objective: 'clicks',
          dailyBudgetMicros: 50_000_000,
          maxCpcMicros: 2_000_000 + names * 10_000,
          ...over,
        })
      ).json<{ campaign: { id: string } }>().campaign.id,
    );
    const headline = `Ferries ${String(names)}`;
    await h.call('POST', `/ads/campaigns/${campaign}/creatives`, owner.token, {
      headline,
      body: 'Daily boats from Panaji, book a seat in two minutes.',
      destinationUrl: 'https://ferries.example.in/book',
    });
    await h.call('PUT', `/ads/campaigns/${campaign}/targeting`, owner.token, { targets });
    await h.call('PATCH', `/ads/campaigns/${campaign}`, owner.token, { status: 'active' });
    // Approved, as a moderator would.
    await h.t.owner.query("UPDATE app.ad_advertisers SET status = 'active' WHERE public_id = $1", [advertiser]);
    await h.t.owner.query('ALTER TABLE app.ad_creatives DISABLE TRIGGER ad_creatives_guard');
    await h.t.owner.query(
      `UPDATE app.ad_creatives SET status = 'approved', reviewed_at = now()
       WHERE campaign_id = (SELECT id FROM app.ad_campaigns WHERE public_id = $1)`,
      [campaign],
    );
    await h.t.owner.query('ALTER TABLE app.ad_creatives ENABLE TRIGGER ad_creatives_guard');
    await server().refresh();
    return { owner, advertiser, campaign, headline };
  }

  async function question(field = 'travel') {
    const asker = await member();
    const res = await h.call('POST', '/questions', asker.token, {
      title: `Is the night ferry to the islands safe in June, case ${String(names)}?`,
      field,
    });
    return must(res.json<{ question: { id: string } }>().question.id);
  }

  const select = async (token: string | undefined, body: object) =>
    (await h.call('POST', '/ads/select', token, body)).json<{ ads: Ad[] }>().ads;

  return {
    h,
    member,
    liveCampaign,
    question,
    select,
    server,
    names: () => names,
    setOn: (value: boolean) => {
      on = value;
    },
  };
}

/**
 * `n` people made straight in the database (the API would take minutes), each with a topic,
 * the given decayed interests and country, an ad identity, and, unless `allows` is false, a yes
 * to personalized ads. Returns their profile and ad ids.
 */
export async function crowd(
  w: { h: TestApp },
  n: number,
  interests: Record<string, number>,
  country = 'IN',
  allows = true,
) {
  const ids = Array.from({ length: n }, () => randomUUID());
  const tag = randomUUID().slice(0, 8);
  const o = w.h.t.owner;
  // A profile needs a topic by commit: both in one statement.
  await o.query(
    `WITH p AS (
       INSERT INTO app.profiles (id, handle, country, adult_confirmed_at)
       SELECT id, 'crowd' || $2 || '.' || ord, $3, now() FROM unnest($1::uuid[]) WITH ORDINALITY AS t(id, ord)
       RETURNING id)
     INSERT INTO app.profile_fields (profile_id, field) SELECT id, 'travel' FROM p`,
    [ids, tag, country],
  );
  if (allows)
    await o.query(
      `INSERT INTO app.user_consent_settings (user_id, category, enabled, policy_version)
       SELECT id, 'ads_personalization', true, c.policy_version FROM unnest($1::uuid[]) AS t(id)
       JOIN app.consent_categories c ON c.name = 'ads_personalization'`,
      [ids],
    );
  await o.query('INSERT INTO app.ad_identities (profile_id) SELECT unnest($1::uuid[])', [ids]);
  for (const [field, score] of Object.entries(interests))
    await o.query(
      `INSERT INTO app.ad_interests (ad_id, field, score)
       SELECT ad_id, $2, $3 FROM app.ad_identities WHERE profile_id = ANY($1)`,
      [ids, field, score],
    );
  const adIds = (
    await o.query<{ ad_id: string }>('SELECT ad_id::text FROM app.ad_identities WHERE profile_id = ANY($1)', [ids])
  ).rows.map(r => r.ad_id);
  return { ids, adIds };
}
