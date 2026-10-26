// Advertisers, campaigns, ads and targeting (docs/adr/0022-advertising-platform.md
// part 3): for the people who run a business's advertising, and the
// moderators who review it. Everything answers "not available" while the
// ads switch is off. The database decides who may do what (migration 0031);
// this code explains refusals in plain words. Money is in micro-units of the
// campaign's currency (1 rupee = 1,000,000).
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Database, Queryable } from '../db.ts';
import { cleanLine } from '../text.ts';
import { isModerator } from './moderation.ts';
import { fail, pgCode, signedIn } from './common.ts';

const uuid = { type: 'string', format: 'uuid' };
const idParams = { type: 'object', properties: { id: uuid }, required: ['id'] };
const micros = (max: number) => ({ type: 'integer', minimum: 1, maximum: max });
const offMessage = 'Advertising on Graphinity isn’t available yet.';

const campaignBody = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'objective', 'dailyBudgetMicros', 'maxCpcMicros'],
  properties: {
    name: { type: 'string', maxLength: 240 },
    objective: { enum: ['awareness', 'clicks', 'conversions'] },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    dailyBudgetMicros: micros(100_000_000_000_000),
    totalBudgetMicros: micros(1_000_000_000_000_000),
    maxCpcMicros: micros(100_000_000_000),
    frequencyCap: { type: 'integer', minimum: 1, maximum: 20 },
    startsAt: { type: 'string', format: 'date-time' },
    endsAt: { type: 'string', format: 'date-time' },
  },
};

interface CampaignRow {
  public_id: string;
  name: string;
  objective: string;
  status: string;
  currency: string;
  daily_budget_micros: string;
  total_budget_micros: string | null;
  max_cpc_micros: string;
  frequency_cap: number;
  starts_at: Date;
  ends_at: Date | null;
}
const campaignColumns = `c.public_id::text, c.name, c.objective, c.status, c.currency, c.daily_budget_micros::text,
  c.total_budget_micros::text, c.max_cpc_micros::text, c.frequency_cap, c.starts_at, c.ends_at`;
const campaignOut = (c: CampaignRow) => ({
  id: c.public_id,
  name: c.name,
  objective: c.objective,
  status: c.status,
  currency: c.currency,
  dailyBudgetMicros: Number(c.daily_budget_micros),
  totalBudgetMicros: c.total_budget_micros === null ? null : Number(c.total_budget_micros),
  maxCpcMicros: Number(c.max_cpc_micros),
  frequencyCap: c.frequency_cap,
  startsAt: c.starts_at.toISOString(),
  endsAt: c.ends_at?.toISOString() ?? null,
});

/** The database's refusals, in plain words. Returns null for anything else (rethrow). */
function refusal(reply: FastifyReply, err: unknown) {
  const code = pgCode(err);
  const message = (err as { message?: string }).message ?? '';
  if (code === '42501' && /own advertiser/.test(message))
    return fail(reply, 403, 'own_advertiser', 'Another moderator has to decide about your own business.');
  if (code === '42501') return fail(reply, 403, 'not_allowed', 'You can’t change this.');
  if (code === '23514' && /at most 3/.test(message))
    return fail(reply, 400, 'too_many_advertisers', 'You can run at most 3 advertisers.');
  if (code === '23514' && /ended campaign|back to draft|stays reviewed/.test(message))
    return fail(reply, 409, 'not_allowed_now', 'That change isn’t possible from where it is now.');
  if (code === '23503') return fail(reply, 400, 'invalid', 'That country isn’t one Graphinity knows.');
  if (code === '23514' || code === '22P02' || code === '22008')
    return fail(reply, 400, 'invalid', 'Some of that isn’t valid. Check the lengths, the amounts and the address.');
  return null;
}

/**
 * Runs the database work; a refusal the database made becomes its plain-words
 * reply, anything else is rethrown. Replies are built outside, after it.
 */
async function attempt<T>(reply: FastifyReply, work: () => Promise<T>): Promise<{ ok: T } | { refused: FastifyReply }> {
  try {
    return { ok: await work() };
  } catch (err) {
    const r = refusal(reply, err);
    if (r) return { refused: r };
    throw err;
  }
}

export function registerAdvertiserRoutes(
  app: FastifyInstance,
  { db, enabled }: { db: Database; enabled: () => boolean },
) {
  const off = (reply: FastifyReply) => fail(reply, 404, 'ads_off', offMessage);
  const campaignOf = async (q: Queryable, publicId: string) =>
    (await q.query<{ id: string }>('SELECT id::text FROM app.ad_campaigns WHERE public_id = $1', [publicId])).rows[0];
  const missingCampaign = (reply: FastifyReply) => fail(reply, 404, 'not_found', 'There’s no such campaign you run.');
  const notModerator = (reply: FastifyReply) => fail(reply, 403, 'not_a_moderator', 'This page is for moderators.');

  app.post(
    '/ads/advertisers',
    {
      config: { auth: 'required', write: true },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'country'],
          properties: { name: { type: 'string', maxLength: 240 }, country: { type: 'string', pattern: '^[A-Z]{2}$' } },
        },
      },
    },
    async (req, reply) => {
      if (!enabled()) return off(reply);
      const user = signedIn(req);
      const body = req.body as { name: string; country: string };
      const name = cleanLine(body.name);
      const outcome = await attempt(reply, () =>
        db.withUser(
          user.id,
          async q =>
            (await q.query<{ id: string }>('SELECT app.create_advertiser($1, $2)::text AS id', [name, body.country]))
              .rows[0]?.id,
        ),
      );
      if ('refused' in outcome) return outcome.refused;
      return reply.code(201).send({ advertiser: { id: outcome.ok, name, country: body.country, status: 'pending' } });
    },
  );

  app.get('/ads/advertisers', { config: { auth: 'required' } }, async (req, reply) => {
    if (!enabled()) return off(reply);
    const user = signedIn(req);
    const rows = await db.withUser(
      user.id,
      async q =>
        (
          await q.query<{ id: string; name: string; country: string; status: string; role: string }>(
            `SELECT a.public_id::text AS id, a.name, a.country, a.status, m.role
             FROM app.ad_advertisers a JOIN app.ad_advertiser_members m ON m.advertiser_id = a.id
             WHERE m.profile_id = $1 ORDER BY a.created_at`,
            [user.id],
          )
        ).rows,
    );
    return { advertisers: rows };
  });

  app.post(
    '/ads/advertisers/:id/campaigns',
    { config: { auth: 'required', write: true }, schema: { params: idParams, body: campaignBody } },
    async (req, reply) => {
      if (!enabled()) return off(reply);
      const user = signedIn(req);
      const { id } = req.params as { id: string };
      const b = req.body as {
        name: string;
        objective: string;
        currency?: string;
        dailyBudgetMicros: number;
        totalBudgetMicros?: number;
        maxCpcMicros: number;
        frequencyCap?: number;
        startsAt?: string;
        endsAt?: string;
      };
      const outcome = await attempt(reply, () =>
        db.withUser(user.id, async q => {
          const advertiser = (
            await q.query<{ id: string }>('SELECT id::text FROM app.ad_advertisers WHERE public_id = $1', [id])
          ).rows[0];
          if (!advertiser) return null;
          return (
            await q.query<CampaignRow>(
              `INSERT INTO app.ad_campaigns AS c (advertiser_id, name, objective, currency, daily_budget_micros,
                 total_budget_micros, max_cpc_micros, frequency_cap, starts_at, ends_at)
               VALUES ($1, $2, $3, coalesce($4, 'INR'), $5, $6, $7, coalesce($8, 3), coalesce($9::timestamptz, now()), $10)
               RETURNING ${campaignColumns}`,
              [
                advertiser.id,
                cleanLine(b.name),
                b.objective,
                b.currency ?? null,
                b.dailyBudgetMicros,
                b.totalBudgetMicros ?? null,
                b.maxCpcMicros,
                b.frequencyCap ?? null,
                b.startsAt ?? null,
                b.endsAt ?? null,
              ],
            )
          ).rows[0];
        }),
      );
      if ('refused' in outcome) return outcome.refused;
      if (!outcome.ok) return fail(reply, 404, 'not_found', 'There’s no such advertiser you run.');
      return reply.code(201).send({ campaign: campaignOut(outcome.ok) });
    },
  );

  app.get(
    '/ads/advertisers/:id/campaigns',
    { config: { auth: 'required' }, schema: { params: idParams } },
    async (req, reply) => {
      if (!enabled()) return off(reply);
      const user = signedIn(req);
      const { id } = req.params as { id: string };
      const rows = await db.withUser(
        user.id,
        async q =>
          (
            await q.query<CampaignRow>(
              `SELECT ${campaignColumns} FROM app.ad_campaigns c JOIN app.ad_advertisers a ON a.id = c.advertiser_id
               WHERE a.public_id = $1 ORDER BY c.created_at`,
              [id],
            )
          ).rows,
      );
      return { campaigns: rows.map(campaignOut) };
    },
  );

  app.patch(
    '/ads/campaigns/:id',
    {
      config: { auth: 'required', write: true },
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            name: { type: 'string', maxLength: 240 },
            status: { enum: ['active', 'paused', 'ended'] },
            dailyBudgetMicros: micros(100_000_000_000_000),
            maxCpcMicros: micros(100_000_000_000),
            frequencyCap: { type: 'integer', minimum: 1, maximum: 20 },
          },
        },
      },
    },
    async (req, reply) => {
      if (!enabled()) return off(reply);
      const user = signedIn(req);
      const { id } = req.params as { id: string };
      const b = req.body as {
        name?: string;
        status?: string;
        dailyBudgetMicros?: number;
        maxCpcMicros?: number;
        frequencyCap?: number;
      };
      const outcome = await attempt(reply, () =>
        db.withUser(
          user.id,
          async q =>
            (
              await q.query<CampaignRow>(
                `UPDATE app.ad_campaigns c SET name = coalesce($2, name), status = coalesce($3, status),
                   daily_budget_micros = coalesce($4, daily_budget_micros), max_cpc_micros = coalesce($5, max_cpc_micros),
                   frequency_cap = coalesce($6, frequency_cap)
                 WHERE public_id = $1 RETURNING ${campaignColumns}`,
                [
                  id,
                  b.name === undefined ? null : cleanLine(b.name),
                  b.status ?? null,
                  b.dailyBudgetMicros ?? null,
                  b.maxCpcMicros ?? null,
                  b.frequencyCap ?? null,
                ],
              )
            ).rows[0],
        ),
      );
      if ('refused' in outcome) return outcome.refused;
      if (!outcome.ok) return missingCampaign(reply);
      return { campaign: campaignOut(outcome.ok) };
    },
  );

  app.post(
    '/ads/campaigns/:id/creatives',
    {
      config: { auth: 'required', write: true },
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['headline', 'body', 'destinationUrl'],
          properties: {
            headline: { type: 'string', maxLength: 180 },
            body: { type: 'string', maxLength: 450 },
            destinationUrl: { type: 'string', maxLength: 500 },
          },
        },
      },
    },
    async (req, reply) => {
      if (!enabled()) return off(reply);
      const user = signedIn(req);
      const { id } = req.params as { id: string };
      const b = req.body as { headline: string; body: string; destinationUrl: string };
      const outcome = await attempt(reply, () =>
        db.withUser(user.id, async q => {
          const campaign = await campaignOf(q, id);
          if (!campaign) return null;
          return (
            await q.query<{ id: string }>(
              `INSERT INTO app.ad_creatives (campaign_id, headline, body, destination_url)
               VALUES ($1, $2, $3, $4) RETURNING public_id::text AS id`,
              [campaign.id, cleanLine(b.headline), cleanLine(b.body), b.destinationUrl],
            )
          ).rows[0];
        }),
      );
      if ('refused' in outcome) return outcome.refused;
      if (!outcome.ok) return missingCampaign(reply);
      return reply.code(201).send({ creative: { id: outcome.ok.id, status: 'pending' } });
    },
  );

  app.put(
    '/ads/campaigns/:id/targeting',
    {
      config: { auth: 'required', write: true },
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['targets'],
          properties: {
            targets: {
              type: 'array',
              maxItems: 100,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['kind', 'value'],
                properties: {
                  kind: { enum: ['field', 'keyword', 'country', 'interest'] },
                  value: { type: 'string', maxLength: 40 },
                },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      if (!enabled()) return off(reply);
      const user = signedIn(req);
      const { id } = req.params as { id: string };
      const { targets } = req.body as { targets: Array<{ kind: string; value: string }> };
      const outcome = await attempt(reply, () =>
        db.withUser(user.id, async q => {
          const campaign = await campaignOf(q, id);
          if (!campaign) return false;
          await q.query('DELETE FROM app.ad_targeting WHERE campaign_id = $1', [campaign.id]);
          for (const t of targets)
            await q.query(
              'INSERT INTO app.ad_targeting (campaign_id, kind, value) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
              [campaign.id, t.kind, t.kind === 'keyword' ? t.value.toLowerCase() : t.value],
            );
          return true;
        }),
      );
      if ('refused' in outcome) return outcome.refused;
      if (!outcome.ok) return missingCampaign(reply);
      return { targeting: targets };
    },
  );

  // Moderators: businesses and ads waiting for a decision.
  app.get('/ads/review', { config: { auth: 'required' } }, async (req, reply) => {
    if (!enabled()) return off(reply);
    const user = signedIn(req);
    const result = await db.withUser(user.id, async q => {
      if (!(await isModerator(q))) return null;
      const advertisers = (
        await q.query<{ id: string; name: string; country: string }>(
          "SELECT public_id::text AS id, name, country FROM app.ad_advertisers WHERE status = 'pending' ORDER BY created_at LIMIT 50",
        )
      ).rows;
      const creatives = (
        await q.query<{ id: string; advertiser: string; headline: string; body: string; destination_url: string }>(
          `SELECT cr.public_id::text AS id, a.name AS advertiser, cr.headline, cr.body, cr.destination_url
           FROM app.ad_creatives cr JOIN app.ad_campaigns c ON c.id = cr.campaign_id
           JOIN app.ad_advertisers a ON a.id = c.advertiser_id
           WHERE cr.status = 'pending' ORDER BY cr.created_at LIMIT 50`,
        )
      ).rows;
      return {
        advertisers,
        creatives: creatives.map(c => ({
          id: c.id,
          advertiser: c.advertiser,
          headline: c.headline,
          body: c.body,
          destinationUrl: c.destination_url,
        })),
      };
    });
    if (!result) return notModerator(reply);
    return result;
  });

  app.post(
    '/ads/review/advertiser',
    {
      config: { auth: 'required', write: true },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'status'],
          properties: { id: uuid, status: { enum: ['active', 'suspended'] } },
        },
      },
    },
    async (req, reply) => {
      if (!enabled()) return off(reply);
      const user = signedIn(req);
      const { id, status } = req.body as { id: string; status: string };
      const outcome = await attempt(reply, () =>
        db.withUser(user.id, async q => {
          if (!(await isModerator(q))) return 'forbidden' as const;
          const r = await q.query('UPDATE app.ad_advertisers SET status = $2 WHERE public_id = $1', [id, status]);
          return r.rowCount ? ('ok' as const) : ('missing' as const);
        }),
      );
      if ('refused' in outcome) return outcome.refused;
      if (outcome.ok === 'forbidden') return notModerator(reply);
      if (outcome.ok === 'missing') return fail(reply, 404, 'not_found', 'There’s no such advertiser.');
      return { advertiser: { id, status } };
    },
  );

  app.post(
    '/ads/review/creative',
    {
      config: { auth: 'required', write: true },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'decision'],
          properties: {
            id: uuid,
            decision: { enum: ['approve', 'reject'] },
            reason: { type: 'string', maxLength: 900 },
          },
        },
      },
    },
    async (req, reply) => {
      if (!enabled()) return off(reply);
      const user = signedIn(req);
      const { id, decision, reason } = req.body as { id: string; decision: 'approve' | 'reject'; reason?: string };
      if (decision === 'reject' && !reason?.trim())
        return fail(reply, 400, 'reason_needed', 'Say why it was rejected, so the advertiser can fix it.');
      const outcome = await attempt(reply, () =>
        db.withUser(user.id, async q => {
          if (!(await isModerator(q))) return 'forbidden' as const;
          const r = await q.query(
            "UPDATE app.ad_creatives SET status = $2, reject_reason = $3 WHERE public_id = $1 AND status = 'pending'",
            [
              id,
              decision === 'approve' ? 'approved' : 'rejected',
              decision === 'reject' ? cleanLine(reason ?? '') : null,
            ],
          );
          return r.rowCount ? ('ok' as const) : ('missing' as const);
        }),
      );
      if ('refused' in outcome) return outcome.refused;
      if (outcome.ok === 'forbidden') return notModerator(reply);
      if (outcome.ok === 'missing') return fail(reply, 404, 'not_found', 'This ad isn’t waiting for review.');
      return { creative: { id, status: decision === 'approve' ? 'approved' : 'rejected' } };
    },
  );
}
