// Advertisers, campaigns, ads and targeting (ADR 0022 part 3, migration 0031):
// nothing while the platform is off; a business's own people manage only
// their campaigns; plain-text ads go to https addresses and are reviewed by
// moderators who aren't part of that business; money is whole micro-units;
// campaigns only move forward.
import { beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './helpers/app.ts';
import { must, type Body } from './helpers/must.ts';

let h: TestApp;
let adsOn = true;
let names = 0;

beforeAll(async () => {
  h = await startApp(() => Date.now(), { adsEnabled: () => adsOn });
  await h.t.owner.query("UPDATE app.feature_flags SET enabled = true WHERE name = 'ads'");
  return h.close;
});

async function member() {
  const p = await h.person();
  names += 1;
  const handle = `advertiser.${String(names)}`;
  expect(
    (await h.call('POST', '/me/profile', p.token, { handle, country: 'IN', fields: ['travel'], adult: true }))
      .statusCode,
  ).toBe(201);
  return { ...p, handle };
}
async function moderator() {
  const m = await member();
  await h.t.owner.query('INSERT INTO app.moderators (profile_id) VALUES ($1)', [m.id]);
  return m;
}
const advertiser = async (token: string, name = 'Goa Ferry Tickets') => {
  const res = await h.call('POST', '/ads/advertisers', token, { name, country: 'IN' });
  expect(res.statusCode, res.body).toBe(201);
  return must(res.json<{ advertiser: { id: string } }>().advertiser.id);
};
const campaignBody = {
  name: 'Monsoon ferries',
  objective: 'clicks',
  dailyBudgetMicros: 500_000_000,
  maxCpcMicros: 5_000_000,
};
const campaign = async (token: string, advertiserId: string, body: object = campaignBody) => {
  const res = await h.call('POST', `/ads/advertisers/${advertiserId}/campaigns`, token, body);
  expect(res.statusCode, res.body).toBe(201);
  return must(res.json<{ campaign: { id: string; status: string } }>().campaign);
};
const creativeBody = {
  headline: 'Ferries to the islands',
  body: 'Daily boats from Panaji, book a seat in two minutes.',
  destinationUrl: 'https://ferries.example.in/book',
};

describe('while the platform is off', () => {
  it('nothing is available, in the API or the database', async () => {
    const p = await member();
    adsOn = false;
    try {
      expect(
        (await h.call('POST', '/ads/advertisers', p.token, { name: 'Shop', country: 'IN' })).json<Body>().error,
      ).toBe('ads_off');
      expect((await h.call('GET', '/ads/advertisers', p.token)).statusCode).toBe(404);
      expect((await h.call('GET', '/ads/review', p.token)).statusCode).toBe(404);
    } finally {
      adsOn = true;
    }
    await h.t.owner.query("UPDATE app.feature_flags SET enabled = false WHERE name = 'ads'");
    try {
      await expect(
        h.t.database.withUser(p.id, q => q.query("SELECT app.create_advertiser('Shop', 'IN')")),
      ).rejects.toThrow(/not available/);
    } finally {
      await h.t.owner.query("UPDATE app.feature_flags SET enabled = true WHERE name = 'ads'");
    }
  });
});

describe('advertisers', () => {
  it('are created pending, owned by their creator, at most three each, and only by people who can post', async () => {
    const p = await member();
    const id = await advertiser(p.token);
    const mine = (await h.call('GET', '/ads/advertisers', p.token)).json<{
      advertisers: Array<Record<string, string>>;
    }>();
    expect(mine.advertisers).toEqual([
      { id, name: 'Goa Ferry Tickets', country: 'IN', status: 'pending', role: 'owner' },
    ]);
    await advertiser(p.token, 'Second shop');
    await advertiser(p.token, 'Third shop');
    expect(
      (await h.call('POST', '/ads/advertisers', p.token, { name: 'Fourth', country: 'IN' })).json<Body>().error,
    ).toBe('too_many_advertisers');
    expect((await h.call('POST', '/ads/advertisers', p.token, { name: 'X', country: 'ZZ' })).statusCode).toBe(400);
    const blocked = await member();
    await h.t.owner.query('INSERT INTO app.blocks (profile_id) VALUES ($1)', [blocked.id]);
    expect((await h.call('POST', '/ads/advertisers', blocked.token, { name: 'Shop', country: 'IN' })).statusCode).toBe(
      403,
    );
    // Nobody else sees them, and they can't be claimed directly.
    const other = await member();
    expect(
      (await h.call('GET', '/ads/advertisers', other.token)).json<{ advertisers: unknown[] }>().advertisers,
    ).toEqual([]);
    await expect(
      h.t.database.withUser(other.id, q =>
        q.query("INSERT INTO app.ad_advertisers (name, country) VALUES ('Mine', 'IN')"),
      ),
    ).rejects.toThrow();
  });
});

describe('campaigns', () => {
  it('belong to their business only, with whole-unit money and sane limits', async () => {
    const [p, other] = [await member(), await member()];
    const a = await advertiser(p.token);
    const c = await campaign(p.token, a);
    expect(c.status).toBe('draft');
    const list = (await h.call('GET', `/ads/advertisers/${a}/campaigns`, p.token)).json<{
      campaigns: Array<{ dailyBudgetMicros: number; frequencyCap: number; currency: string }>;
    }>().campaigns;
    expect(list[0]).toMatchObject({ dailyBudgetMicros: 500_000_000, frequencyCap: 3, currency: 'INR' });
    // Below one rupee a day; a bid above the day's budget; a fractional amount.
    const bad = (body: object) =>
      h.call('POST', `/ads/advertisers/${a}/campaigns`, p.token, { ...campaignBody, ...body });
    expect((await bad({ dailyBudgetMicros: 999_999 })).json<Body>().error).toBe('invalid');
    expect((await bad({ maxCpcMicros: 600_000_000 })).json<Body>().error).toBe('invalid');
    expect((await bad({ dailyBudgetMicros: 1.5 })).statusCode).toBe(400);
    // Another person can neither add to it nor see it.
    expect(
      (await h.call('POST', `/ads/advertisers/${a}/campaigns`, other.token, campaignBody)).json<Body>().error,
    ).toBe('not_found');
    expect(
      (await h.call('GET', `/ads/advertisers/${a}/campaigns`, other.token)).json<{ campaigns: unknown[] }>().campaigns,
    ).toEqual([]);
    expect(
      (await h.call('PATCH', `/ads/campaigns/${c.id}`, other.token, { status: 'active' })).json<Body>().error,
    ).toBe('not_found');
    // In the database itself, not only through the API: they can't read it or add to it.
    const advertiserRow = must(
      (await h.t.owner.query<{ id: string }>('SELECT id::text FROM app.ad_advertisers WHERE public_id = $1', [a]))
        .rows[0],
    );
    expect(
      await h.t.database.withUser(other.id, async q => (await q.query('SELECT 1 FROM app.ad_campaigns')).rowCount),
    ).toBe(0);
    await expect(
      h.t.database.withUser(other.id, q =>
        q.query(
          `INSERT INTO app.ad_campaigns (advertiser_id, name, objective, daily_budget_micros, max_cpc_micros)
           VALUES ($1, 'Hijack', 'clicks', 1000000, 10000)`,
          [advertiserRow.id],
        ),
      ),
    ).rejects.toThrow();
  });

  it('only move forward: draft, then active and paused, then ended for good', async () => {
    const p = await member();
    const c = await campaign(p.token, await advertiser(p.token));
    const set = (status: string) => h.call('PATCH', `/ads/campaigns/${c.id}`, p.token, { status });
    expect((await set('active')).json<{ campaign: { status: string } }>().campaign.status).toBe('active');
    expect((await set('paused')).statusCode).toBe(200);
    expect((await set('active')).statusCode).toBe(200);
    expect((await set('ended')).statusCode).toBe(200);
    expect((await set('active')).json<Body>().error).toBe('not_allowed_now');
    expect((await set('draft')).statusCode).toBe(400);
  });
});

describe('ads', () => {
  it('are plain text, go only to https addresses, and wait for review', async () => {
    const p = await member();
    const c = await campaign(p.token, await advertiser(p.token));
    const post = (body: object) =>
      h.call('POST', `/ads/campaigns/${c.id}/creatives`, p.token, { ...creativeBody, ...body });
    const ok = await post({});
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json<{ creative: { status: string } }>().creative.status).toBe('pending');
    for (const bad of [
      { destinationUrl: 'http://ferries.example.in' },
      { destinationUrl: 'https://user:pass@ferries.example.in' },
      { destinationUrl: 'javascript:alert(1)' },
      { headline: 'Hi' },
      { body: 'Book now ‮niarg' },
    ])
      expect((await post(bad)).json<Body>().error, JSON.stringify(bad)).toBe('invalid');
  });

  it('are approved or rejected by a moderator outside the business, with a reason for a rejection', async () => {
    const [p, mod] = [await member(), await moderator()];
    const a = await advertiser(p.token);
    const c = await campaign(p.token, a);
    const created = await h.call('POST', `/ads/campaigns/${c.id}/creatives`, p.token, creativeBody);
    const creative = must(created.json<{ creative: { id: string } }>().creative.id);
    const queue = (await h.call('GET', '/ads/review', mod.token)).json<{
      advertisers: Array<{ id: string }>;
      creatives: Array<{ id: string; headline: string }>;
    }>();
    expect(queue.advertisers.map(x => x.id)).toContain(a);
    expect(queue.creatives.find(x => x.id === creative)?.headline).toBe('Ferries to the islands');
    expect((await h.call('GET', '/ads/review', p.token)).json<Body>().error).toBe('not_a_moderator');
    const review = (token: string, body: object) =>
      h.call('POST', '/ads/review/creative', token, { id: creative, ...body });
    expect((await review(mod.token, { decision: 'reject' })).json<Body>().error).toBe('reason_needed');
    expect((await review(p.token, { decision: 'approve' })).json<Body>().error).toBe('not_a_moderator');
    expect(
      (await review(mod.token, { decision: 'approve' })).json<{ creative: { status: string } }>().creative.status,
    ).toBe('approved');
    // Reviewed once.
    expect((await review(mod.token, { decision: 'reject', reason: 'late' })).json<Body>().error).toBe('not_found');
    const { rows } = await h.t.owner.query<{ reviewed_by: string; reviewed_at: Date | null }>(
      'SELECT reviewed_by::text, reviewed_at FROM app.ad_creatives WHERE public_id = $1',
      [creative],
    );
    expect(rows[0]?.reviewed_by).toBe(mod.id);
    // The business is approved too.
    expect((await h.call('POST', '/ads/review/advertiser', mod.token, { id: a, status: 'active' })).statusCode).toBe(
      200,
    );
  });

  it('can’t be reviewed by a moderator who runs that business, nor rewritten by any moderator', async () => {
    const insider = await moderator();
    const a = await advertiser(insider.token);
    const c = await campaign(insider.token, a);
    const creative = must(
      (await h.call('POST', `/ads/campaigns/${c.id}/creatives`, insider.token, creativeBody)).json<{
        creative: { id: string };
      }>().creative.id,
    );
    expect(
      (await h.call('POST', '/ads/review/creative', insider.token, { id: creative, decision: 'approve' })).json<Body>()
        .error,
    ).toBe('own_advertiser');
    expect(
      (await h.call('POST', '/ads/review/advertiser', insider.token, { id: a, status: 'active' })).json<Body>().error,
    ).toBe('own_advertiser');
    const mod = await moderator();
    await expect(
      h.t.database.withUser(mod.id, q =>
        q.query("UPDATE app.ad_creatives SET headline = 'Something else entirely' WHERE public_id = $1", [creative]),
      ),
    ).rejects.toThrow();
    // Nor can someone who is neither a moderator nor part of the business.
    const outsider = await member();
    await expect(
      h.t.database.withUser(outsider.id, async q => {
        const r = await q.query("UPDATE app.ad_creatives SET status = 'approved' WHERE public_id = $1", [creative]);
        if (!r.rowCount) throw new Error('not updated');
      }),
    ).rejects.toThrow();
    // Two layers stop a member approving their own ad: the review policy, and the self-review
    // trigger. With the trigger off, the policy alone must still stop them.
    await h.t.owner.query('ALTER TABLE app.ad_creatives DISABLE TRIGGER ad_creatives_guard');
    try {
      const nonModerator = await member();
      await h.t.owner.query(
        "INSERT INTO app.ad_advertiser_members (advertiser_id, profile_id, role) SELECT id, $1, 'manager' FROM app.ad_advertisers WHERE public_id = $2",
        [nonModerator.id, a],
      );
      await expect(
        h.t.database.withUser(nonModerator.id, async q => {
          // A whole, valid review (time included), so only the policy is left to refuse it.
          const r = await q.query(
            "UPDATE app.ad_creatives SET status = 'approved', reviewed_at = now() WHERE public_id = $1",
            [creative],
          );
          if (!r.rowCount) throw new Error('not updated');
        }),
      ).rejects.toThrow();
    } finally {
      await h.t.owner.query('ALTER TABLE app.ad_creatives ENABLE TRIGGER ad_creatives_guard');
    }
    // A member can't approve their own ad directly either.
    await expect(
      h.t.database.withUser(insider.id, q =>
        q.query("UPDATE app.ad_creatives SET status = 'approved' WHERE public_id = $1", [creative]),
      ),
    ).rejects.toThrow();
  });
});

describe('targeting', () => {
  it('is replaced as a whole set, with keywords as plain lowercase words', async () => {
    const p = await member();
    const c = await campaign(p.token, await advertiser(p.token));
    const put = (targets: object[]) => h.call('PUT', `/ads/campaigns/${c.id}/targeting`, p.token, { targets });
    expect(
      (
        await put([
          { kind: 'field', value: 'travel' },
          { kind: 'keyword', value: 'Ferry' },
          { kind: 'country', value: 'IN' },
          { kind: 'interest', value: 'travel' },
        ])
      ).statusCode,
    ).toBe(200);
    const stored = async () =>
      (
        await h.t.owner.query<{ kind: string; value: string }>(
          'SELECT t.kind, t.value FROM app.ad_targeting t JOIN app.ad_campaigns c ON c.id = t.campaign_id WHERE c.public_id = $1 ORDER BY 1, 2',
          [c.id],
        )
      ).rows;
    expect(await stored()).toEqual([
      { kind: 'country', value: 'IN' },
      { kind: 'field', value: 'travel' },
      { kind: 'interest', value: 'travel' },
      { kind: 'keyword', value: 'ferry' },
    ]);
    expect((await put([{ kind: 'keyword', value: 'two words' }])).json<Body>().error).toBe('invalid');
    // A refused set leaves the last one as it was.
    expect(await stored()).toHaveLength(4);
    expect((await put([{ kind: 'country', value: 'india' }])).json<Body>().error).toBe('invalid');
    expect((await put([])).statusCode).toBe(200);
    expect(await stored()).toEqual([]);
  });
});
