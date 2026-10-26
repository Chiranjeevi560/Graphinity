// Private campaign reports (docs/adr/0022-advertising-platform.md part 8), for
// a business's members: a campaign's impressions, clicks and conversions by
// day, country, placement or audience, over complete UTC days only, with
// per-person contributions clipped, fixed Laplace noise per cell, small
// cells suppressed, and a daily privacy budget charged once per new release.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Database, Queryable } from '../db.ts';
import {
  CLIP,
  EPSILON_DAILY,
  EPSILON_PER_METRIC,
  MIN_IMPRESSIONS,
  MIN_PEOPLE,
  privateCells,
  releaseCost,
  type Breakdown,
  type TrueCell,
} from '../ads/privacy.ts';
import type { Clock } from '../rate-limit.ts';
import { fail, signedIn } from './common.ts';

const DAY_MS = 86_400_000;
/** At most this many days in one report. */
export const MAX_REPORT_DAYS = 92;

/** The report secret, made on first use. As the system. */
export async function reportSecret(q: Queryable): Promise<Buffer> {
  await q.query('INSERT INTO app.ad_report_secret (secret) VALUES ($1) ON CONFLICT (id) DO NOTHING', [randomBytes(32)]);
  const row = (await q.query<{ secret: Buffer }>('SELECT secret FROM app.ad_report_secret')).rows[0];
  if (!row) throw new Error('no report secret');
  return row.secret;
}

const VALUE: Record<Breakdown, string> = {
  day: "to_char(%(at)s AT TIME ZONE 'UTC', 'YYYY-MM-DD')",
  country: "coalesce(i.country, 'unknown')",
  placement: 'i.placement',
  audience: "coalesce(au.public_id::text, 'none')",
};

/** Each cell's true, clipped counts. As the system. */
export async function trueCells(
  q: Queryable,
  campaign: string,
  breakdown: Breakdown,
  from: Date,
  to: Date,
): Promise<TrueCell[]> {
  const value = (at: string) => VALUE[breakdown].replace('%(at)s', at);
  // A person (or, untracked, an impression) counts at most CLIP times per cell; conversions by
  // the day they were received, which never changes once the day is over.
  const { rows } = await q.query<{
    day: string;
    value: string;
    people: number;
    impressions: number;
    clicks: number;
    conversions: number;
  }>(
    `WITH shown AS (
       SELECT to_char(i.shown_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, ${value('i.shown_at')} AS value,
              coalesce(i.ad_id::text, i.token::text) AS who, count(*) AS n
       FROM app.ad_impressions i LEFT JOIN app.ad_audiences au ON au.id = i.audience_id
       WHERE i.campaign_id = $1 AND i.shown_at >= $2 AND i.shown_at < $3 GROUP BY 1, 2, 3),
     tapped AS (
       SELECT to_char(i.clicked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, ${value('i.clicked_at')} AS value,
              coalesce(i.ad_id::text, i.token::text) AS who, count(*) AS n
       FROM app.ad_impressions i LEFT JOIN app.ad_audiences au ON au.id = i.audience_id
       WHERE i.campaign_id = $1 AND i.clicked_at >= $2 AND i.clicked_at < $3 GROUP BY 1, 2, 3),
     bought AS (
       SELECT to_char(c.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, ${value('c.received_at')} AS value,
              coalesce(i.ad_id::text, i.token::text) AS who, count(*) AS n
       FROM app.ad_conversions c JOIN app.ad_impressions i ON i.id = c.impression_id
       LEFT JOIN app.ad_audiences au ON au.id = i.audience_id
       WHERE i.campaign_id = $1 AND c.received_at >= $2 AND c.received_at < $3 GROUP BY 1, 2, 3),
     s AS (SELECT day, value, count(*)::int AS people, sum(least(n, $4))::int AS impressions FROM shown GROUP BY 1, 2),
     t AS (SELECT day, value, sum(least(n, $5))::int AS clicks FROM tapped GROUP BY 1, 2),
     b AS (SELECT day, value, sum(least(n, $6))::int AS conversions FROM bought GROUP BY 1, 2)
     SELECT day, value, coalesce(s.people, 0) AS people, coalesce(s.impressions, 0) AS impressions,
            coalesce(t.clicks, 0) AS clicks, coalesce(b.conversions, 0) AS conversions
     FROM s FULL JOIN t USING (day, value) FULL JOIN b USING (day, value)
     ORDER BY day, value`,
    [campaign, from, to, CLIP.impressions, CLIP.clicks, CLIP.conversions],
  );
  return rows;
}

const date = { type: 'string', format: 'date' };

export function registerAdReportRoutes(
  app: FastifyInstance,
  { db, enabled, clock }: { db: Database; enabled: () => boolean; clock: Clock },
) {
  const off = (reply: FastifyReply) => fail(reply, 404, 'ads_off', 'Advertising on Graphinity isn’t available yet.');

  app.post(
    '/ads/reports/private',
    {
      config: { auth: 'required' },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['campaignId', 'startDate', 'endDate', 'breakdown'],
          properties: {
            campaignId: { type: 'string', format: 'uuid' },
            startDate: date,
            endDate: date,
            breakdown: { enum: ['day', 'country', 'placement', 'audience'] },
          },
        },
      },
    },
    async (req, reply) => {
      if (!enabled()) return off(reply);
      const user = signedIn(req);
      const b = req.body as { campaignId: string; startDate: string; endDate: string; breakdown: Breakdown };
      const from = new Date(`${b.startDate}T00:00:00Z`);
      const to = new Date(new Date(`${b.endDate}T00:00:00Z`).getTime() + DAY_MS);
      const today = Math.floor(clock.now() / DAY_MS) * DAY_MS;
      const days = Math.round((to.getTime() - from.getTime()) / DAY_MS);
      if (days < 1 || days > MAX_REPORT_DAYS)
        return fail(
          reply,
          400,
          'invalid_range',
          `Choose from 1 to ${String(MAX_REPORT_DAYS)} days, ending no earlier than they start.`,
        );
      if (to.getTime() > today)
        return fail(reply, 400, 'day_not_over', 'Reports cover whole days only: end the range yesterday or earlier.');
      // A campaign of a business this person is a member of (moderators reviewing it don't count).
      const campaign = await db.withUser(
        user.id,
        async q =>
          (
            await q.query<{ id: string; audiences: number }>(
              `SELECT c.id::text, (SELECT count(*)::int FROM app.ad_targeting t WHERE t.campaign_id = c.id AND t.kind = 'audience') AS audiences
               FROM app.ad_campaigns c WHERE c.public_id = $1 AND app.is_ad_member(c.advertiser_id)`,
              [b.campaignId],
            )
          ).rows[0],
      );
      if (!campaign) return fail(reply, 404, 'not_found', 'There’s no such campaign you run.');
      const cost = releaseCost(b.breakdown, campaign.audiences);
      // A person in many of the campaign's audiences would appear in that many cells: more than a
      // day's budget can hide.
      if (cost > EPSILON_DAILY)
        return fail(reply, 400, 'too_fine', 'This campaign targets too many audiences to break it down by audience.');
      const result = await db.asSystem(async q => {
        const dayList = Array.from({ length: days }, (_, i) =>
          new Date(from.getTime() + i * DAY_MS).toISOString().slice(0, 10),
        );
        const charge = (
          await q.query<{ outcome: 'free' | 'charged' | 'exhausted'; remaining: string }>(
            'SELECT outcome, remaining::text FROM app.release_ad_report($1, $2::date[], $3, $4)',
            [campaign.id, dayList, b.breakdown, cost],
          )
        ).rows[0];
        if (!charge || charge.outcome === 'exhausted')
          return { exhausted: true as const, remaining: charge?.remaining ?? '0' };
        const cells = await trueCells(q, campaign.id, b.breakdown, from, to);
        return { charge, shown: privateCells(campaign.id, b.breakdown, cells, await reportSecret(q)) };
      });
      if ('exhausted' in result)
        return fail(
          reply,
          429,
          'privacy_budget_spent',
          'Today’s privacy budget for new report details is used up. Reports you’ve already seen stay available; new ones can be asked for tomorrow (UTC).',
        );
      return {
        report: {
          campaignId: b.campaignId,
          breakdown: b.breakdown,
          startDate: b.startDate,
          endDate: b.endDate,
          cells: result.shown.cells,
          suppressed: result.shown.suppressed,
          privacy: {
            epsilonCharged: result.charge.outcome === 'charged' ? cost : 0,
            epsilonRemainingToday: Number(result.charge.remaining),
            epsilonPerMetric: EPSILON_PER_METRIC,
            clipping: CLIP,
            minimumPeople: MIN_PEOPLE,
            minimumImpressions: MIN_IMPRESSIONS,
          },
        },
      };
    },
  );
}
