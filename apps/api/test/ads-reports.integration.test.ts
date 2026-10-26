// Private campaign reports (ADR 0022 part 8, migration 0037): complete UTC
// days only; per-person contributions clipped; fixed noise per cell, so
// asking again changes nothing; cells under 25 people or 50 impressions
// suppressed; a daily privacy budget, charged once per new release; and
// only the business's own members, never the database's other users.
import { beforeAll, describe, expect, it } from 'vitest';
import { trueCells } from '../src/routes/ad-reports.ts';
import { crowd, startAdWorld } from './helpers/ads.ts';
import { must, type Body } from './helpers/must.ts';

let w: Awaited<ReturnType<typeof startAdWorld>>;
beforeAll(async () => {
  w = await startAdWorld('rep', ['ads', 'ads_behavioral']);
  return w.h.close;
});

const DAY = 86_400_000;
const utcDay = (offset: number) =>
  new Date(Math.floor(Date.now() / DAY) * DAY + offset * DAY).toISOString().slice(0, 10);
const yesterday = () => utcDay(-1);

/** `n` impressions yesterday at noon UTC for each ad id (null: one untracked viewer each), some tapped. */
async function shown(campaign: string, adIds: ReadonlyArray<string | null>, each = 1, tapped = 0, country = 'IN') {
  await w.h.t.owner.query(
    `INSERT INTO app.ad_impressions (campaign_id, creative_id, ad_id, placement, price_micros, shown_at, clicked_at, country)
     SELECT c.id, cr.id, x.ad_id, 'search', 1000, $3::timestamptz, CASE WHEN x.ord <= $5 AND g = 1 THEN $3::timestamptz END, $6
     FROM app.ad_campaigns c JOIN app.ad_creatives cr ON cr.campaign_id = c.id,
          unnest($2::uuid[]) WITH ORDINALITY AS x(ad_id, ord), generate_series(1, $4) AS g
     WHERE c.public_id = $1`,
    [campaign, adIds, `${yesterday()}T12:00:00Z`, each, tapped, country],
  );
}

const ask = (token: string, body: object) => w.h.call('POST', '/ads/reports/private', token, body);
type Report = {
  report: {
    cells: Array<{ value: string; day: string; impressions: number; clicks: number; conversions: number }>;
    suppressed: number;
    privacy: { epsilonCharged: number; epsilonRemainingToday: number };
  };
};

describe('private reports', () => {
  it('show a campaign’s complete days with fixed noise, and asking again costs nothing and changes nothing', async () => {
    const live = await w.liveCampaign([{ kind: 'keyword', value: 'reportone' }]);
    const { adIds } = await crowd(w, 40, {});
    // Each shown it 20 times (the most one person counts for): 800, far above the floor.
    await shown(live.campaign, adIds, 20, 20);
    const body = { campaignId: live.campaign, startDate: yesterday(), endDate: yesterday(), breakdown: 'day' };
    const first = await ask(live.owner.token, body);
    expect(first.statusCode, first.body).toBe(200);
    const r = first.json<Report>().report;
    expect(r.cells).toHaveLength(1);
    const [cell] = r.cells;
    expect(cell?.day).toBe(yesterday());
    // 800 impressions with Laplace noise of scale 100: off by more than 1,500 once in 3 million.
    expect(Math.abs((cell?.impressions ?? 0) - 800)).toBeLessThan(1500);
    expect(r.privacy).toMatchObject({ epsilonCharged: 0.6, epsilonRemainingToday: 1.4 });
    const again = (await ask(live.owner.token, body)).json<Report>().report;
    expect(again.cells).toEqual(r.cells);
    expect(again.privacy).toMatchObject({ epsilonCharged: 0, epsilonRemainingToday: 1.4 });
    // Nothing of who: no person's id anywhere, and no ids but the campaign's own.
    for (const id of adIds) expect(first.body).not.toContain(id);
    expect(first.body.replace(live.campaign, '')).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
  });

  it('suppress a day with fewer than 25 people behind it', async () => {
    const live = await w.liveCampaign([{ kind: 'keyword', value: 'reporttwo' }]);
    const { adIds } = await crowd(w, 24, {});
    await shown(live.campaign, adIds, 10);
    const r = (
      await ask(live.owner.token, {
        campaignId: live.campaign,
        startDate: yesterday(),
        endDate: yesterday(),
        breakdown: 'day',
      })
    ).json<Report>().report;
    expect([r.cells, r.suppressed]).toEqual([[], 1]);
  });

  it('cover complete days only, and at most 92 of them', async () => {
    const live = await w.liveCampaign([{ kind: 'keyword', value: 'reportthree' }]);
    const range = (startDate: string, endDate: string) =>
      ask(live.owner.token, { campaignId: live.campaign, startDate, endDate, breakdown: 'day' });
    expect((await range(yesterday(), utcDay(0))).json<Body>().error).toBe('day_not_over');
    expect((await range(yesterday(), utcDay(-2))).json<Body>().error).toBe('invalid_range');
    expect((await range(utcDay(-100), yesterday())).json<Body>().error).toBe('invalid_range');
    expect((await range(utcDay(-92), yesterday())).statusCode).toBe(200);
    // The database refuses releasing today however it's asked.
    const id = must(
      (
        await w.h.t.owner.query<{ id: string }>('SELECT id::text FROM app.ad_campaigns WHERE public_id = $1', [
          live.campaign,
        ])
      ).rows[0],
    ).id;
    await expect(
      w.h.t.database.asSystem(q =>
        q.query("SELECT * FROM app.release_ad_report($1, ARRAY[(now() AT TIME ZONE 'UTC')::date], 'day', 0.6)", [id]),
      ),
    ).rejects.toThrow(/complete days/);
  });

  it('stop releasing new details once the day’s budget is spent, while what was seen stays available', async () => {
    const live = await w.liveCampaign([{ kind: 'keyword', value: 'reportfour' }]);
    const { adIds } = await crowd(w, 30, {});
    await shown(live.campaign, adIds, 2);
    const by = (breakdown: string) =>
      ask(live.owner.token, { campaignId: live.campaign, startDate: yesterday(), endDate: yesterday(), breakdown });
    expect((await by('day')).json<Report>().report.privacy.epsilonRemainingToday).toBeCloseTo(1.4, 6);
    expect((await by('country')).json<Report>().report.privacy.epsilonRemainingToday).toBeCloseTo(0.8, 6);
    // Placement costs 1.2 (a person can be in both placements): more than is left.
    const refused = await by('placement');
    expect([refused.statusCode, refused.json<Body>().error]).toEqual([429, 'privacy_budget_spent']);
    expect((await by('day')).statusCode).toBe(200);
    // The budget is per business: another business's is untouched.
    const rival = await w.liveCampaign([{ kind: 'keyword', value: 'reportrival' }]);
    expect(
      (
        await ask(rival.owner.token, {
          campaignId: rival.campaign,
          startDate: yesterday(),
          endDate: yesterday(),
          breakdown: 'placement',
        })
      ).json<Report>().report.privacy.epsilonRemainingToday,
    ).toBeCloseTo(0.8, 6);
    // And the database never lets the ledger pass 2.0.
    await expect(
      w.h.t.owner.query(
        `UPDATE app.ad_privacy_budget_ledger SET epsilon_spent = 2.5
         WHERE advertiser_id = (SELECT id FROM app.ad_advertisers WHERE public_id = $1)`,
        [live.advertiser],
      ),
    ).rejects.toThrow(/check/);
  });

  it('clip each person’s share of a cell, and count conversions on the day they arrived', async () => {
    const live = await w.liveCampaign([{ kind: 'keyword', value: 'reportfive' }]);
    const { adIds } = await crowd(w, 30, {});
    await shown(live.campaign, adIds, 1);
    // One person shown it 1,000 times counts as 20; an untracked viewer's impressions count one each.
    await shown(live.campaign, adIds.slice(0, 1), 999);
    await shown(live.campaign, [null, null], 1);
    const id = must(
      (
        await w.h.t.owner.query<{ id: string }>('SELECT id::text FROM app.ad_campaigns WHERE public_id = $1', [
          live.campaign,
        ])
      ).rows[0],
    ).id;
    const from = new Date(`${yesterday()}T00:00:00Z`);
    const to = new Date(from.getTime() + DAY);
    const [cell] = await w.h.t.database.asSystem(q => trueCells(q, id, 'day', from, to));
    expect(cell).toMatchObject({ people: 32, impressions: 29 + 20 + 2 });
    // Two conversions by one person, received yesterday though bought three days ago: clipped to
    // one, and counted on the day they arrived (a day already reported can't change later).
    await w.h.t.owner.query(
      `INSERT INTO app.ad_conversions (advertiser_id, impression_id, external_id, converted_at, received_at)
       SELECT c.advertiser_id, i.id, 'o-' || i.id, $4::timestamptz, $2::timestamptz
       FROM app.ad_impressions i JOIN app.ad_campaigns c ON c.id = i.campaign_id
       WHERE c.public_id = $1 AND i.ad_id = $3 LIMIT 2`,
      [live.campaign, `${yesterday()}T13:00:00Z`, adIds[0], `${utcDay(-3)}T13:00:00Z`],
    );
    const [after] = await w.h.t.database.asSystem(q => trueCells(q, id, 'day', from, to));
    expect(after?.conversions).toBe(1);
  });

  it('refuse an audience breakdown when one person could be in more cells than a day’s budget hides', async () => {
    const live = await w.liveCampaign([{ kind: 'keyword', value: 'reportseven' }]);
    // Four audiences targeted: a person in all four would be in four cells (4 × 0.6 > 2.0).
    await w.h.t.owner.query(
      `WITH c AS (SELECT id, advertiser_id FROM app.ad_campaigns WHERE public_id = $1),
            a AS (INSERT INTO app.ad_audiences (advertiser_id, name, kind, rule)
                  SELECT c.advertiser_id, 'A' || g, 'segment', '{"all":[{"country":"IN"}]}' FROM c, generate_series(1, 4) g
                  RETURNING public_id)
       INSERT INTO app.ad_targeting (campaign_id, kind, value) SELECT c.id, 'audience', a.public_id::text FROM c, a`,
      [live.campaign],
    );
    const by = (breakdown: string) =>
      ask(live.owner.token, { campaignId: live.campaign, startDate: yesterday(), endDate: yesterday(), breakdown });
    expect((await by('audience')).json<Body>().error).toBe('too_fine');
    expect((await by('day')).statusCode).toBe(200);
  });

  it('are for the business’s own members only, and the database keeps the secret and the budget to itself', async () => {
    const live = await w.liveCampaign([{ kind: 'keyword', value: 'reportsix' }]);
    const body = { campaignId: live.campaign, startDate: yesterday(), endDate: yesterday(), breakdown: 'day' };
    expect((await ask((await w.member()).token, body)).statusCode).toBe(404);
    const moderator = await w.member();
    await w.h.t.owner.query('INSERT INTO app.moderators (profile_id) VALUES ($1)', [moderator.id]);
    expect((await ask(moderator.token, body)).statusCode).toBe(404);
    await ask(live.owner.token, body);
    const asUser = (sql: string) => w.h.t.database.withUser(live.owner.id, async q => (await q.query(sql)).rowCount);
    expect(await asUser('SELECT 1 FROM app.ad_report_secret')).toBe(0);
    await expect(
      w.h.t.database.withUser(live.owner.id, q =>
        q.query("SELECT * FROM app.release_ad_report(1, ARRAY['2020-01-01'::date], 'day', 0.1)"),
      ),
    ).rejects.toThrow(/released by the server/);
    await expect(
      w.h.t.database.withUser(live.owner.id, q =>
        q.query("INSERT INTO app.ad_privacy_budget_ledger (advertiser_id, epoch) VALUES (1, '2020-01-01')"),
      ),
    ).rejects.toThrow(/permission/);
    // Their own ledger they can read.
    expect(await asUser('SELECT 1 FROM app.ad_privacy_budget_ledger')).toBe(1);
  });
});
