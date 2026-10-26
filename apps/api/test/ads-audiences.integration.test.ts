// Audiences (ADR 0022 part 7, migration 0036): made of people who allow
// personalized ads now, built only by the server, never smaller than 100,
// never shown person by person, and gone the moment someone turns
// personalized ads off. Campaigns can target their own business's ready
// audiences; reminders are capped at 3 a day and 7 a week.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildAudiences } from '../src/ads/audience-build.ts';
import { startAdWorld } from './helpers/ads.ts';
import { must, type Body } from './helpers/must.ts';

let w: Awaited<ReturnType<typeof startAdWorld>>;
beforeAll(async () => {
  w = await startAdWorld('aud', ['ads', 'ads_behavioral', 'ads_audiences']);
  return w.h.close;
});

let crowds = 0;
/**
 * `n` people who allow personalized ads, made straight in the database (the API would take
 * minutes), each with the given interests and country. Returns their profile and ad ids.
 */
async function crowd(n: number, interests: Record<string, number>, country = 'IN', allows = true) {
  crowds += 1;
  const ids = Array.from({ length: n }, () => randomUUID());
  const o = w.h.t.owner;
  // A profile needs a topic by commit: both in one statement.
  await o.query(
    `WITH p AS (
       INSERT INTO app.profiles (id, handle, country, adult_confirmed_at)
       SELECT id, 'crowd' || $2 || '.' || ord, $3, now() FROM unnest($1::uuid[]) WITH ORDINALITY AS t(id, ord)
       RETURNING id)
     INSERT INTO app.profile_fields (profile_id, field) SELECT id, 'travel' FROM p`,
    [ids, String(crowds), country],
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

const make = (owner: { token: string }, advertiser: string, body: object) =>
  w.h.call('POST', `/ads/advertisers/${advertiser}/audiences`, owner.token, body);
const list = async (owner: { token: string }, advertiser: string) =>
  (await w.h.call('GET', `/ads/advertisers/${advertiser}/audiences`, owner.token)).json<{
    audiences: Array<{ id: string; name: string; status: string; size: number | null }>;
  }>().audiences;
const membersOf = async (audience: string) =>
  must(
    (
      await w.h.t.owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM app.ad_audience_members m JOIN app.ad_audiences a ON a.id = m.audience_id
         WHERE a.public_id = $1`,
        [audience],
      )
    ).rows[0],
  ).n;
const build = () => buildAudiences(w.h.t.database);
let topics = 0;
/**
 * Topics are the fixed list of fields, so each test's segment owns a band of interest scores
 * instead: higher than every earlier test's crowd, so it matches only its own.
 */
const band = () => {
  topics += 1;
  return 100 + topics * 10;
};

describe('segments', () => {
  it('are built from people who match and allow it, sized only above 100, and never shown person by person', async () => {
    const live = await w.liveCampaign([{ kind: 'keyword', value: 'segmentone' }]);
    const min = band();
    await crowd(120, { travel: min + 1 });
    await crowd(30, { travel: 1 });
    // Matching, with an ad identity, but not allowing personalized ads (never said yes): left out.
    await crowd(10, { travel: min + 1 }, 'IN', false);
    const res = await make(live.owner, live.advertiser, {
      name: 'Keen travellers',
      kind: 'segment',
      rule: { all: [{ interest: 'travel', min }, { country: 'IN' }] },
    });
    expect(res.statusCode, res.body).toBe(201);
    const made = res.json<{ audience: { id: string; status: string; size: number | null } }>().audience;
    expect([made.status, made.size]).toEqual(['building', null]);
    await build();
    const [listed] = await list(live.owner, live.advertiser);
    expect([listed?.status, listed?.size]).toEqual(['ready', 100]);
    expect(await membersOf(made.id)).toBe(120);
    // Another person can't list them, and nobody but the system reads a member.
    expect(
      (await w.h.call('GET', `/ads/advertisers/${live.advertiser}/audiences`, (await w.member()).token)).statusCode,
    ).toBe(404);
    const seen = await w.h.t.database.withUser(
      live.owner.id,
      async q => (await q.query('SELECT 1 FROM app.ad_audience_members')).rowCount,
    );
    expect(seen).toBe(0);
    // Nor does anyone outside the business read the audience itself.
    const stranger = await w.member();
    expect(
      await w.h.t.database.withUser(stranger.id, async q => (await q.query('SELECT 1 FROM app.ad_audiences')).rowCount),
    ).toBe(0);
  });

  it('under 100 people are insufficient: no members stored, no size, and the database refuses calling them ready', async () => {
    const live = await w.liveCampaign([{ kind: 'keyword', value: 'segmenttwo' }]);
    const min = band();
    await crowd(99, { travel: min + 1 });
    const made = (
      await make(live.owner, live.advertiser, {
        name: 'Too few',
        kind: 'segment',
        rule: { all: [{ interest: 'travel', min }] },
      })
    ).json<{ audience: { id: string } }>().audience;
    await build();
    const [listed] = await list(live.owner, live.advertiser);
    expect([listed?.status, listed?.size]).toEqual(['insufficient', null]);
    expect(await membersOf(made.id)).toBe(0);
    await expect(
      w.h.t.database.asSystem(q =>
        q.query("UPDATE app.ad_audiences SET status = 'ready', size = 99 WHERE public_id = $1", [made.id]),
      ),
    ).rejects.toThrow(/check/);
    // And a business can't size or ready its own.
    await expect(
      w.h.t.database.withUser(live.owner.id, q =>
        q.query("UPDATE app.ad_audiences SET status = 'ready', size = 500 WHERE public_id = $1", [made.id]),
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
  });

  it('lose a person the moment they turn personalized ads off', async () => {
    const live = await w.liveCampaign([{ kind: 'keyword', value: 'segmentthree' }]);
    const min = band();
    const { ids } = await crowd(101, { travel: min + 1 });
    const made = (
      await make(live.owner, live.advertiser, {
        name: 'Leaving',
        kind: 'segment',
        rule: { all: [{ interest: 'travel', min }] },
      })
    ).json<{ audience: { id: string } }>().audience;
    await build();
    expect(await membersOf(made.id)).toBe(101);
    // As the person themselves, through the database: turning it off rotates their ad identity.
    await w.h.t.database.withUser(must(ids[0]), q =>
      q.query(
        "UPDATE app.user_consent_settings SET enabled = false WHERE user_id = $1 AND category = 'ads_personalization'",
        [ids[0]],
      ),
    );
    expect(await membersOf(made.id)).toBe(100);
    // The database adds nobody who doesn't allow it, whatever the job tries.
    const outsider = (await crowd(1, {}, 'IN', false)).adIds[0];
    await expect(
      w.h.t.database.asSystem(q =>
        q.query(
          `INSERT INTO app.ad_audience_members (audience_id, ad_id, event_at)
           SELECT id, $2, now() FROM app.ad_audiences WHERE public_id = $1`,
          [made.id, outsider],
        ),
      ),
    ).rejects.toThrow(/allow personalized ads/);
  });
});

describe('targeting an audience', () => {
  it('shows the ad to people in a ready audience only, and only the business’s own audiences can be targeted', async () => {
    const live = await w.liveCampaign([{ kind: 'keyword', value: 'audiencead' }]);
    const min = band();
    await crowd(100, { travel: min + 1 });
    const audience = (
      await make(live.owner, live.advertiser, {
        name: 'Readers',
        kind: 'segment',
        rule: { all: [{ interest: 'travel', min }] },
      })
    ).json<{ audience: { id: string } }>().audience.id;
    const target = (targets: object[]) =>
      w.h.call('PUT', `/ads/campaigns/${live.campaign}/targeting`, live.owner.token, { targets });
    expect(
      (
        await target([
          { kind: 'keyword', value: 'audiencead' },
          { kind: 'audience', value: audience },
        ])
      ).statusCode,
    ).toBe(200);
    // A reader in it: a person who allows personalized ads, with the interest.
    const reader = await w.member();
    await w.h.call('PUT', '/me/consents', reader.token, {
      choices: [{ category: 'ads_personalization', enabled: true }],
    });
    await w.h.t.owner.query('INSERT INTO app.ad_identities (profile_id) VALUES ($1) ON CONFLICT DO NOTHING', [
      reader.id,
    ]);
    await w.h.t.owner.query(
      'INSERT INTO app.ad_interests (ad_id, field, score) SELECT ad_id, $2, $3 FROM app.ad_identities WHERE profile_id = $1',
      [reader.id, 'travel', min + 1],
    );
    const other = await w.member();
    await w.server().refresh();
    const shown = async (token?: string) =>
      (await w.select(token, { placement: 'search', query: 'ferry audiencead' })).some(
        a => a.headline === live.headline,
      );
    // Not built yet: nobody.
    expect(await shown(reader.token)).toBe(false);
    await build();
    await w.server().refresh();
    expect(await shown(reader.token)).toBe(true);
    expect(await shown(other.token)).toBe(false);
    expect(await shown()).toBe(false);
    // Audiences switched off: no audience matches.
    await w.h.t.owner.query("UPDATE app.feature_flags SET enabled = false WHERE name = 'ads_audiences'");
    try {
      expect(await shown(reader.token)).toBe(false);
    } finally {
      await w.h.t.owner.query("UPDATE app.feature_flags SET enabled = true WHERE name = 'ads_audiences'");
    }
    // Another business's audience can't be targeted.
    const rival = await w.liveCampaign([{ kind: 'keyword', value: 'rivalad' }]);
    expect(
      (
        await w.h.call('PUT', `/ads/campaigns/${rival.campaign}/targeting`, rival.owner.token, {
          targets: [{ kind: 'audience', value: audience }],
        })
      ).json<Body>().error,
    ).toBe('not_allowed');
  });
});

describe('ad reminders', () => {
  it('reach people who recently tapped the campaign, 3 times a day and 7 a week at most', async () => {
    const live = await w.liveCampaign([{ kind: 'keyword', value: 'reminderad' }], { frequencyCap: 10 });
    const { adIds } = await crowd(100, {});
    // Their taps, 2 days ago, and one 40 days ago that is too old to count.
    await w.h.t.owner.query(
      `INSERT INTO app.ad_impressions (campaign_id, creative_id, ad_id, placement, price_micros, shown_at, clicked_at)
       SELECT c.id, cr.id, x.ad_id, 'search', 1000, now() - interval '2 days', now() - interval '2 days'
       FROM app.ad_campaigns c JOIN app.ad_creatives cr ON cr.campaign_id = c.id, unnest($2::uuid[]) AS x(ad_id)
       WHERE c.public_id = $1`,
      [live.campaign, adIds.slice(0, 99)],
    );
    await w.h.t.owner.query(
      `INSERT INTO app.ad_impressions (campaign_id, creative_id, ad_id, placement, price_micros, shown_at, clicked_at)
       SELECT c.id, cr.id, $2, 'search', 1000, now() - interval '40 days', now() - interval '40 days'
       FROM app.ad_campaigns c JOIN app.ad_creatives cr ON cr.campaign_id = c.id WHERE c.public_id = $1`,
      [live.campaign, adIds[99]],
    );
    const res = await make(live.owner, live.advertiser, {
      name: 'Tapped',
      kind: 'retargeting',
      campaignId: live.campaign,
    });
    expect(res.statusCode, res.body).toBe(201);
    const reminder = res.json<{ audience: { id: string } }>().audience.id;
    await build();
    // 99 recent tappers: under the floor.
    expect((await list(live.owner, live.advertiser)).find(a => a.id === reminder)?.status).toBe('insufficient');
    // A signed-in reader who tapped too makes 100.
    const reader = await w.member();
    await w.h.call('PUT', '/me/consents', reader.token, {
      choices: [{ category: 'ads_personalization', enabled: true }],
    });
    await w.h.t.owner.query('INSERT INTO app.ad_identities (profile_id) VALUES ($1) ON CONFLICT DO NOTHING', [
      reader.id,
    ]);
    await w.h.t.owner.query(
      `INSERT INTO app.ad_impressions (campaign_id, creative_id, ad_id, placement, price_micros, shown_at, clicked_at)
       SELECT c.id, cr.id, d.ad_id, 'search', 1000, now() - interval '1 day', now() - interval '1 day'
       FROM app.ad_campaigns c JOIN app.ad_creatives cr ON cr.campaign_id = c.id, app.ad_identities d
       WHERE c.public_id = $1 AND d.profile_id = $2`,
      [live.campaign, reader.id],
    );
    await build();
    expect((await list(live.owner, live.advertiser)).find(a => a.id === reminder)?.status).toBe('ready');
    await w.h.call('PUT', `/ads/campaigns/${live.campaign}/targeting`, live.owner.token, {
      targets: [
        { kind: 'keyword', value: 'reminderad' },
        { kind: 'audience', value: reminder },
      ],
    });
    await w.server().refresh();
    const shown = async () =>
      (await w.select(reader.token, { placement: 'search', query: 'ferry reminderad' })).some(
        a => a.headline === live.headline,
      );
    expect([await shown(), await shown(), await shown(), await shown()]).toEqual([true, true, true, false]);
    // A week's worth already seen: no more this week, even on a fresh day.
    await w.h.t.owner.query(
      `UPDATE app.ad_impressions SET shown_at = now() - interval '3 days'
       WHERE ad_id = (SELECT ad_id FROM app.ad_identities WHERE profile_id = $1) AND clicked_at IS NULL`,
      [reader.id],
    );
    expect([await shown(), await shown(), await shown(), await shown()]).toEqual([true, true, true, false]);
    await w.h.t.owner.query(
      `UPDATE app.ad_impressions SET shown_at = now() - interval '3 days'
       WHERE ad_id = (SELECT ad_id FROM app.ad_identities WHERE profile_id = $1) AND clicked_at IS NULL`,
      [reader.id],
    );
    // 6 shown in the week, plus the tap's own impression yesterday: 7, the weekly cap.
    expect(await shown()).toBe(false);
  });

  it('come only from the business’s own campaigns', async () => {
    const live = await w.liveCampaign([{ kind: 'keyword', value: 'ownreminder' }]);
    const rival = await w.liveCampaign([{ kind: 'keyword', value: 'rivalreminder' }]);
    const res = await make(rival.owner, rival.advertiser, {
      name: 'Theirs',
      kind: 'retargeting',
      campaignId: live.campaign,
    });
    expect(res.json<Body>().error).toBe('not_own');
  });
});

describe('look-alikes', () => {
  it('find people like a ready seed, at the size asked, never including the seed', async () => {
    const live = await w.liveCampaign([{ kind: 'keyword', value: 'lookalikead' }]);
    const min = band();
    // The seed: 120 keen travellers who also look up visas. Candidates: 1,000 more like them
    // (the same mix, less keen) and 2,000 cooks; earlier tests' crowds care only for travel.
    await crowd(120, { travel: min + 1, 'visas-immigration': (min + 1) * 0.4 });
    const travellers = await crowd(1000, { travel: 5, 'visas-immigration': 2 });
    await crowd(2000, { 'food-cooking': 5 });
    const seed = (
      await make(live.owner, live.advertiser, {
        name: 'Seed',
        kind: 'segment',
        rule: { all: [{ interest: 'travel', min }] },
      })
    ).json<{ audience: { id: string } }>().audience.id;
    const res = await make(live.owner, live.advertiser, {
      name: 'Like them',
      kind: 'lookalike',
      seedAudienceId: seed,
      expansion: 0.05,
    });
    expect(res.statusCode, res.body).toBe(201);
    const alike = res.json<{ audience: { id: string } }>().audience.id;
    await build();
    const audiences = await list(live.owner, live.advertiser);
    expect(audiences.find(a => a.id === alike)?.status).toBe('ready');
    const members = (
      await w.h.t.owner.query<{ ad_id: string }>(
        `SELECT m.ad_id::text FROM app.ad_audience_members m JOIN app.ad_audiences a ON a.id = m.audience_id
         WHERE a.public_id = $1`,
        [alike],
      )
    ).rows.map(r => r.ad_id);
    expect(members.length).toBeGreaterThanOrEqual(100);
    const travelling = new Set(travellers.adIds);
    // Every look-alike is a traveller, none of them from the seed.
    expect(members.every(m => travelling.has(m))).toBe(true);
    // A look-alike can't seed another, nor another business's audience.
    expect(
      (
        await make(live.owner, live.advertiser, {
          name: 'Again',
          kind: 'lookalike',
          seedAudienceId: alike,
          expansion: 0.01,
        })
      ).json<Body>().error,
    ).toBe('not_own');
  });
});

describe('the switch', () => {
  it('refuses making audiences while audiences are off, and a body of the wrong shape', async () => {
    const live = await w.liveCampaign([{ kind: 'keyword', value: 'switchad' }]);
    const segment = { name: 'X', kind: 'segment', rule: { all: [{ country: 'IN' }] } };
    expect(
      (await make(live.owner, live.advertiser, { ...segment, campaignId: live.campaign })).json<Body>().error,
    ).toBe('invalid');
    expect((await make(live.owner, live.advertiser, { name: 'Y', kind: 'lookalike' })).json<Body>().error).toBe(
      'invalid',
    );
    await w.h.t.owner.query("UPDATE app.feature_flags SET enabled = false WHERE name = 'ads_audiences'");
    try {
      expect((await make(live.owner, live.advertiser, segment)).json<Body>().error).toBe('not_allowed');
      // And the job builds nothing.
      expect(await build()).toBe(0);
    } finally {
      await w.h.t.owner.query("UPDATE app.feature_flags SET enabled = true WHERE name = 'ads_audiences'");
    }
    const made = (await make(live.owner, live.advertiser, segment)).json<{ audience: { id: string } }>().audience.id;
    expect((await w.h.call('DELETE', `/ads/audiences/${made}`, (await w.member()).token)).statusCode).toBe(404);
    expect((await w.h.call('DELETE', `/ads/audiences/${made}`, live.owner.token)).statusCode).toBe(200);
    expect((await w.h.call('DELETE', `/ads/audiences/${made}`, live.owner.token)).statusCode).toBe(404);
  });
});
