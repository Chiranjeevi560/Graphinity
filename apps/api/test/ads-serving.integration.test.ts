// Serving ads (ADR 0022 part 4, migration 0032), through the real server: no
// ads while the platform is off; contextual ads for everyone, interest ads
// only for people who allow them; frequency caps only where a person is
// tracked by their choice; clicks counted once and charged only when valid;
// and knowledge results identical with ads on or off, by data and by code.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAdServer } from '../src/ads/serve.ts';
import { startApp, type TestApp } from './helpers/app.ts';
import { must, type Body } from './helpers/must.ts';

let h: TestApp;
let adsOn = true;
let names = 0;
const server = { current: null as ReturnType<typeof createAdServer> | null };

beforeAll(async () => {
  h = await startApp(() => Date.now(), {
    adsEnabled: () => adsOn,
    // The real ad server over the test database, refreshed on demand in each test.
    adServer: {
      serve: (input: Parameters<ReturnType<typeof createAdServer>['serve']>[0]) => must(server.current).serve(input),
      refresh: () => must(server.current).refresh(),
    },
  });
  server.current = createAdServer(h.t.database);
  await h.t.owner.query("UPDATE app.feature_flags SET enabled = true WHERE name IN ('ads', 'ads_behavioral')");
  await h.t.owner.query('UPDATE app.ad_jurisdiction_rules SET legal_approved = true');
  return h.close;
});

async function member(country = 'IN') {
  const p = await h.person();
  names += 1;
  const handle = `serve.${String(names)}`;
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
    (await h.call('POST', '/ads/advertisers', owner.token, { name: `Business ${String(names)}`, country: 'IN' })).json<{
      advertiser: { id: string };
    }>().advertiser.id,
  );
  const campaign = must(
    (
      await h.call('POST', `/ads/advertisers/${advertiser}/campaigns`, owner.token, {
        name: 'Ferries',
        objective: 'clicks',
        dailyBudgetMicros: 50_000_000,
        // Each newer campaign bids a little more, so the one under test wins its auction
        // against those earlier tests left running.
        maxCpcMicros: 2_000_000 + names * 10_000,
        ...over,
      })
    ).json<{ campaign: { id: string } }>().campaign.id,
  );
  await h.call('POST', `/ads/campaigns/${campaign}/creatives`, owner.token, {
    headline: `Ferries ${String(names)}`,
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
  await must(server.current).refresh();
  return { owner, campaign, headline: `Ferries ${String(names)}` };
}

async function question(field = 'travel') {
  const asker = await member();
  const res = await h.call('POST', '/questions', asker.token, {
    title: `Is the night ferry to the islands safe in June, case ${String(names)}?`,
    field,
  });
  return must(res.json<{ question: { id: string } }>().question.id);
}

type Ad = { token: string; headline: string; domain: string; label: string; advertiser: string };
const select = async (token: string | undefined, body: object) =>
  (await h.call('POST', '/ads/select', token, body)).json<{ ads: Ad[] }>().ads;

describe('while the platform is off', () => {
  it('pages simply have no ads, and taps lead nowhere', async () => {
    const live = await liveCampaign([{ kind: 'field', value: 'travel' }]);
    const q = await question();
    adsOn = false;
    try {
      expect(await select(undefined, { placement: 'question', questionId: q })).toEqual([]);
      expect((await h.call('POST', `/ads/click/${crypto.randomUUID()}`)).statusCode).toBe(404);
    } finally {
      adsOn = true;
    }
    const { rows } = await h.t.owner.query(
      'SELECT 1 FROM app.ad_impressions i JOIN app.ad_campaigns c ON c.id = i.campaign_id WHERE c.public_id = $1',
      [live.campaign],
    );
    expect(rows).toEqual([]);
  });
});

describe('choosing ads', () => {
  it('shows contextual ads to anyone, labelled, with only the destination’s domain, naming nobody', async () => {
    const live = await liveCampaign([{ kind: 'field', value: 'travel' }]);
    const q = await question();
    const ads = await select(undefined, { placement: 'question', questionId: q });
    const ad = must(ads.find(a => a.headline === live.headline));
    expect(ad).toMatchObject({ label: 'Sponsored', domain: 'ferries.example.in' });
    expect(JSON.stringify(ad)).not.toContain('/book');
    const reader = await member();
    await select(reader.token, { placement: 'question', questionId: q });
    const { rows } = await h.t.owner.query<{ ad_id: string | null }>(
      'SELECT i.ad_id FROM app.ad_impressions i JOIN app.ad_campaigns c ON c.id = i.campaign_id WHERE c.public_id = $1',
      [live.campaign],
    );
    // A reader who hasn't allowed personalized ads isn't tracked, signed in or not.
    expect(rows.every(r => r.ad_id === null)).toBe(true);
  });

  it('shows interest ads only to people who allow them and have that interest, capped per day', async () => {
    const live = await liveCampaign([{ kind: 'interest', value: 'money-tax' }], { frequencyCap: 1 });
    const [fan, stranger] = [await member(), await member()];
    for (const p of [fan, stranger])
      await h.call('PUT', '/me/consents', p.token, { choices: [{ category: 'ads_personalization', enabled: true }] });
    await h.t.database.withUser(fan.id, q => q.query("SELECT app.record_ad_interest($1, 'money-tax', 2)", [fan.id]));
    const shown = async (token: string | undefined) =>
      (await select(token, { placement: 'search', query: 'income tax return' })).some(
        a => a.headline === live.headline,
      );
    expect(await shown(undefined)).toBe(false);
    expect(await shown(stranger.token)).toBe(false);
    expect(await shown(fan.token)).toBe(true);
    // Capped at once a day for them.
    expect(await shown(fan.token)).toBe(false);
    const { rows } = await h.t.owner.query<{ tracked: boolean }>(
      `SELECT i.ad_id IS NOT NULL AS tracked FROM app.ad_impressions i JOIN app.ad_campaigns c ON c.id = i.campaign_id
       WHERE c.public_id = $1`,
      [live.campaign],
    );
    expect(rows).toEqual([{ tracked: true }]);
    // Withdrawing removes the link at once.
    await h.call('PUT', '/me/consents', fan.token, { choices: [{ category: 'ads_personalization', enabled: false }] });
    const after = await h.t.owner.query<{ tracked: boolean }>(
      `SELECT i.ad_id IS NOT NULL AS tracked FROM app.ad_impressions i JOIN app.ad_campaigns c ON c.id = i.campaign_id
       WHERE c.public_id = $1`,
      [live.campaign],
    );
    expect(after.rows).toEqual([{ tracked: false }]);
  });

  it('matches query words and country, and shows nothing on a hidden question', async () => {
    const live = await liveCampaign([
      { kind: 'keyword', value: 'ferry' },
      { kind: 'country', value: 'IN' },
    ]);
    const [indian, american] = [await member('IN'), await member('US')];
    const has = (ads: Ad[]) => ads.some(a => a.headline === live.headline);
    expect(has(await select(indian.token, { placement: 'search', query: 'night ferry to goa' }))).toBe(true);
    expect(has(await select(american.token, { placement: 'search', query: 'night ferry to goa' }))).toBe(false);
    expect(has(await select(indian.token, { placement: 'search', query: 'train to goa' }))).toBe(false);
    // Signed out: country unknown, so country-targeted ads don't serve.
    expect(has(await select(undefined, { placement: 'search', query: 'night ferry to goa' }))).toBe(false);
    // A hidden question has no ads, even for its author, who can still open it.
    const author = await member();
    const q = must(
      (
        await h.call('POST', '/questions', author.token, {
          title: `Is the night ferry to the islands safe in July, case ${String(names)}?`,
          field: 'travel',
        })
      ).json<{ question: { id: string } }>().question.id,
    );
    expect((await select(author.token, { placement: 'question', questionId: q })).length).toBeGreaterThan(0);
    await h.t.owner.query(
      "INSERT INTO app.decisions (question_id, decision, decided_by) SELECT $1, 'remove', id FROM app.profiles LIMIT 1",
      [q],
    );
    expect((await h.call('GET', `/questions/${q}`, author.token)).statusCode).toBe(200);
    expect(await select(author.token, { placement: 'question', questionId: q })).toEqual([]);
    expect(await select(undefined, { placement: 'question', questionId: q })).toEqual([]);
  });
});

describe('clicks', () => {
  it('are counted once, charged their price only when valid, and lead to the destination', async () => {
    const live = await liveCampaign([{ kind: 'field', value: 'travel' }], {
      dailyBudgetMicros: 30_000_000,
      maxCpcMicros: 9_000_000,
    });
    const q = await question();
    const charged = async () =>
      Number(
        must(
          (
            await h.t.owner.query<{ s: string }>(
              `SELECT coalesce(sum(i.charged_micros), 0)::text AS s FROM app.ad_impressions i
               JOIN app.ad_campaigns c ON c.id = i.campaign_id WHERE c.public_id = $1`,
              [live.campaign],
            )
          ).rows[0],
        ).s,
      );
    const tokenFor = async (viewer?: string) =>
      must((await select(viewer, { placement: 'question', questionId: q })).find(a => a.headline === live.headline))
        .token;
    const first = await tokenFor();
    const tap = await h.call('POST', `/ads/click/${first}`);
    expect(tap.json<{ destination: string }>().destination).toBe('https://ferries.example.in/book');
    const once = await charged();
    expect(once).toBeGreaterThan(0);
    const clickOf = async (token: string) =>
      must(
        (
          await h.t.owner.query<{ clicked_at: Date; charged_micros: string }>(
            'SELECT clicked_at, charged_micros::text FROM app.ad_impressions WHERE token = $1',
            [token],
          )
        ).rows[0],
      );
    const firstClick = await clickOf(first);
    // Tapped again, even by the business's own staff: the first click stands as it was.
    await h.call('POST', `/ads/click/${first}`);
    await h.call('POST', `/ads/click/${first}`, live.owner.token);
    expect(await clickOf(first)).toEqual(firstClick);
    expect(await charged()).toBe(once);
    // The business's own staff: counted, never charged.
    await h.call('POST', `/ads/click/${await tokenFor()}`, live.owner.token);
    expect(await charged()).toBe(once);
    // Too old to click.
    const stale = await tokenFor();
    await h.t.owner.query("UPDATE app.ad_impressions SET shown_at = now() - interval '2 hours' WHERE token = $1", [
      stale,
    ]);
    expect((await h.call('POST', `/ads/click/${stale}`)).json<Body>().error).toBe('not_found');
    expect((await h.call('POST', `/ads/click/${crypto.randomUUID()}`)).statusCode).toBe(404);
  });

  it('never take a campaign past its day’s budget, even all at once', async () => {
    const live = await liveCampaign([{ kind: 'field', value: 'travel' }], {
      dailyBudgetMicros: 20_000_000,
      maxCpcMicros: 20_000_000,
    });
    const q = await question();
    const tokens: string[] = [];
    for (let i = 0; i < 6; i++) {
      const ad = (await select(undefined, { placement: 'question', questionId: q })).find(
        a => a.headline === live.headline,
      );
      if (ad) tokens.push(ad.token);
      // Pacing may hold it back; show it anyway for this test by refreshing spend.
      await must(server.current).refresh();
    }
    await Promise.all(tokens.map(t => h.call('POST', `/ads/click/${t}`)));
    const { rows } = await h.t.owner.query<{ s: string }>(
      `SELECT coalesce(sum(i.charged_micros), 0)::text AS s FROM app.ad_impressions i
       JOIN app.ad_campaigns c ON c.id = i.campaign_id WHERE c.public_id = $1`,
      [live.campaign],
    );
    expect(Number(must(rows[0]).s)).toBeLessThanOrEqual(20_000_000);
    // And it did spend: the cap held, it didn't just refuse everything.
    expect(Number(must(rows[0]).s)).toBeGreaterThan(0);
  });

  it('take one campaign at a time, so two clicks at once can’t both squeeze under the budget', async () => {
    // Bids far above the campaigns earlier tests left (some with a strong click record), to win its slots.
    const live = await liveCampaign([{ kind: 'field', value: 'travel' }], {
      dailyBudgetMicros: 900_000_000,
      maxCpcMicros: 900_000_000,
    });
    const q = await question();
    const [t1, t2] = [
      must((await select(undefined, { placement: 'question', questionId: q })).find(a => a.headline === live.headline))
        .token,
      must((await select(undefined, { placement: 'question', questionId: q })).find(a => a.headline === live.headline))
        .token,
    ];
    // Each priced over half the day's budget: only one of the two may be charged.
    await h.t.owner.query('UPDATE app.ad_impressions SET price_micros = 20000000 WHERE token = ANY($1)', [[t1, t2]]);
    await h.t.owner.query(
      'UPDATE app.ad_campaigns SET max_cpc_micros = 20000000, daily_budget_micros = 30000000 WHERE public_id = $1',
      [live.campaign],
    );
    const [a, b] = [new pg.Client(h.t.ownerUrl), new pg.Client(h.t.ownerUrl)];
    await a.connect();
    await b.connect();
    try {
      await a.query('BEGIN');
      await a.query('SELECT * FROM app.record_ad_click($1, NULL)', [t1]);
      // The second click starts while the first is still uncommitted.
      const second = b.query('SELECT * FROM app.record_ad_click($1, NULL)', [t2]);
      await new Promise(resolve => setTimeout(resolve, 200));
      await a.query('COMMIT');
      await second;
    } finally {
      await a.end();
      await b.end();
    }
    const { rows } = await h.t.owner.query<{ s: string }>(
      'SELECT sum(charged_micros)::text AS s FROM app.ad_impressions WHERE token = ANY($1)',
      [[t1, t2]],
    );
    expect(Number(must(rows[0]).s)).toBe(20_000_000);
  });

  it('are refused past the rate limit, like any other writing request', async () => {
    const p = await member();
    let limited = false;
    for (let i = 0; i < 80 && !limited; i++)
      limited =
        (await h.call('POST', '/ads/select', p.token, { placement: 'search', query: 'ferry' })).statusCode === 429;
    expect(limited).toBe(true);
  });
});

describe('knowledge results stay apart from ads', () => {
  it('are the same with advertising on or off', async () => {
    await liveCampaign([{ kind: 'field', value: 'travel' }]);
    const q = await question();
    const reader = await member();
    const strip = (body: string) => JSON.parse(body.replace(/"searchId":"[^"]+",?/g, '')) as unknown;
    const look = async () => ({
      page: strip((await h.call('GET', `/questions/${q}`, reader.token)).body),
      search: strip((await h.call('POST', '/search', reader.token, { query: 'night ferry islands june' })).body),
    });
    const on = await look();
    adsOn = false;
    await h.t.owner.query("UPDATE app.feature_flags SET enabled = false WHERE name = 'ads'");
    try {
      expect(await look()).toEqual(on);
    } finally {
      adsOn = true;
      await h.t.owner.query("UPDATE app.feature_flags SET enabled = true WHERE name = 'ads'");
    }
    expect(JSON.stringify(on)).not.toMatch(/Sponsored|Ferries \d/);
  });

  it('come from code that never reads ad code', () => {
    const src = join(import.meta.dirname, '..', 'src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(src);
    const knowledge = files.filter(f =>
      /[/\\](search|recommendations)[/\\]|[/\\](routing|routing-score|consensus|reputation|precheck|graph-.*|personal-graph-algorithms)\.ts$/.test(
        f,
      ),
    );
    expect(knowledge.length).toBeGreaterThan(10);
    for (const f of knowledge) expect(readFileSync(f, 'utf8'), f).not.toMatch(/from '\.{1,2}\/(\.\.\/)?ads\//);
  });
});
