// A test world for the advertising platform (ADR 0022): a server whose ad
// switch a test can flip, the real ad server over the test database
// (refreshed on demand), and helpers for people, live campaigns and
// questions. Each world's campaigns bid a little more than the last, so the
// one under test wins its auction against those earlier tests left running.
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
