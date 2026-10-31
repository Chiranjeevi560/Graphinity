// Measuring what ads lead to (docs/adr/0022-advertising-platform.md part 6a):
// a business's API keys, and the conversions its server reports with them.
// A key is shown once and kept only as its SHA-256. Reporting answers the
// same "not counted" for every kind of refusal, so keys and click ids can't
// be probed.
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Database } from '../db.ts';
import { RULE_MODELS, ruleCredit, shapleyModel, type Path, type Touch } from '../ads/attribution.ts';
import { lift } from '../ads/lift.ts';
import { cellUniform, laplace, MIN_PEOPLE } from '../ads/privacy.ts';
import { reportSecret } from './ad-reports.ts';
import { TokenBuckets, type BucketOptions, type Clock } from '../rate-limit.ts';
import { fail, pgCode, signedIn } from './common.ts';

const keyPattern = /^grk_[A-Za-z0-9_-]{43}$/;
/** ε for one lift release: four noised numbers. One person's sales count up to this much. */
const LIFT_EPSILON = 0.8;
const SALE_CLIP_MICROS = 10_000_000_000;

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

export function registerAdMeasurementRoutes(
  app: FastifyInstance,
  deps: { db: Database; enabled: () => boolean; clock: Clock; limit: BucketOptions },
) {
  const { db } = deps;
  const off = (reply: FastifyReply) => fail(reply, 404, 'ads_off', 'Advertising on Graphinity isn’t available yet.');
  const perKey = new TokenBuckets(deps.limit, deps.clock);

  const bearerKey = (header: string | undefined) => {
    const key = header?.startsWith('Bearer ') ? header.slice(7) : '';
    return keyPattern.test(key) ? key : null;
  };
  // A partner's product event (charter part 9): about a rotating id handed to its site by a tap.
  app.post(
    '/ads/partner-events',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['eidToken', 'event', 'eventId'],
          properties: {
            eidToken: { type: 'string', pattern: '^[A-Za-z0-9_-]{22}$' },
            event: { enum: ['PRODUCT_SEARCH', 'PRODUCT_VIEW', 'ADD_TO_CART', 'PURCHASE'] },
            eventId: { type: 'string', minLength: 1, maxLength: 100 },
            productSku: { type: 'string', pattern: '^[a-z0-9-]{1,80}$' },
            category: { type: 'string', pattern: '^[a-z]+(-[a-z]+)*$', maxLength: 40 },
            valueMicros: { type: 'integer', minimum: 0, maximum: 1000000000000 },
          },
        },
      },
    },
    async (req, reply) => {
      if (!deps.enabled()) return off(reply);
      const key = bearerKey(req.headers.authorization);
      if (key && !perKey.take(hashKey(key)).ok) return fail(reply, 429, 'rate_limited', 'Too many events. Slow down.');
      const b = req.body as {
        eidToken: string;
        event: string;
        eventId: string;
        productSku?: string;
        category?: string;
        valueMicros?: number;
      };
      if (key)
        await db.asSystem(
          async q =>
            (
              await q.query<{ r: string }>('SELECT app.record_partner_event($1, $2, $3, $4, $5, $6, $7) AS r', [
                hashKey(key),
                b.eidToken,
                b.event,
                b.productSku ?? null,
                b.category ?? null,
                b.eventId,
                b.valueMicros ?? 0,
              ])
            ).rows[0]?.r,
        );
      // The same whatever happened, so neither keys nor ids can be probed.
      return reply.code(202).send({ accepted: true });
    },
  );

  // A partner's list of rotating ids, matched only when at least 100 are consenting people here.
  app.post(
    '/ads/audiences/partner-match',
    {
      bodyLimit: 2 * 1024 * 1024,
      // No key, no reading a two-megabyte body.
      onRequest: async (req, reply) => {
        if (!bearerKey(req.headers.authorization)) return reply.code(202).send({ status: 'insufficient' });
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'eidTokens'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            eidTokens: { type: 'array', maxItems: 50000, items: { type: 'string', pattern: '^[A-Za-z0-9_-]{22}$' } },
          },
        },
      },
    },
    async (req, reply) => {
      if (!deps.enabled()) return off(reply);
      const key = bearerKey(req.headers.authorization);
      if (!key) return reply.code(202).send({ status: 'insufficient' });
      if (!perKey.take(hashKey(key)).ok) return fail(reply, 429, 'rate_limited', 'Too many requests. Slow down.');
      const b = req.body as { name: string; eidTokens: string[] };
      const row = await db.asSystem(
        async q =>
          (
            await q.query<{ public_id: string | null; status: string; size: number }>(
              'SELECT * FROM app.match_partner_audience($1, $2, $3)',
              [hashKey(key), b.name, b.eidTokens],
            )
          ).rows[0],
      );
      if (row?.status !== 'ready') return reply.code(202).send({ status: 'insufficient' });
      return reply.code(201).send({ status: 'ready', audience: { id: row.public_id, size: row.size } });
    },
  );

  // What a campaign truly adds: exposed against randomized ghost holdouts, members only.
  app.get(
    '/ads/campaigns/:id/lift',
    {
      config: { auth: 'required' },
      schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] } },
    },
    async (req, reply) => {
      if (!deps.enabled()) return off(reply);
      const user = signedIn(req);
      const { id } = req.params as { id: string };
      const campaign = await db.withUser(
        user.id,
        async q =>
          (
            await q.query<{ id: string; advertiser: string }>(
              `SELECT id::text, advertiser_id::text AS advertiser FROM app.ad_campaigns
             WHERE public_id = $1 AND app.is_ad_member(advertiser_id)`,
              [id],
            )
          ).rows[0],
      );
      if (!campaign) return fail(reply, 404, 'not_found', 'There’s no such campaign you run.');
      // Complete days only, sale values clipped per person, noise fixed per campaign and day, and a
      // charge to the business's budget: otherwise reporting a sale for one id and re-reading shows
      // whether that person saw the ad. Only people who allow measurement now are joined.
      const today = new Date(deps.clock.now()).toISOString().slice(0, 10);
      const yesterday = new Date(deps.clock.now() - 86_400_000).toISOString().slice(0, 10);
      const outcome = await db.asSystem(async q => {
        const release = (
          await q.query<{ outcome: string }>('SELECT outcome FROM app.release_ad_report($1, $2::date[], $3, $4)', [
            campaign.id,
            [yesterday],
            'lift',
            LIFT_EPSILON,
          ])
        ).rows[0];
        if (release?.outcome === 'exhausted') return null;
        return {
          secret: await reportSecret(q),
          counts: (
            await q.query<{ ep: number; ec: number; hp: number; hc: number; ev: number; hv: number; spend: string }>(
              `WITH window_ AS (SELECT ($3::date - 30)::timestamptz AS a, $3::date::timestamptz AS b),
                    allowed AS (SELECT ad_id FROM app.ad_identities WHERE app.ads_permitted(profile_id, 'ads_measurement')),
                    exposed AS (SELECT DISTINCT i.ad_id FROM app.ad_impressions i, window_ w JOIN allowed ON true
                                WHERE i.campaign_id = $1 AND i.ad_id = allowed.ad_id AND i.shown_at >= w.a AND i.shown_at < w.b),
                    held AS (SELECT DISTINCT g.ad_id FROM app.ad_ghost_impressions g, window_ w JOIN allowed ON true
                             WHERE g.campaign_id = $1 AND g.ad_id = allowed.ad_id AND g.shown_at >= w.a AND g.shown_at < w.b),
                    sales AS (SELECT e.ad_id, least(sum(e.value_micros), $4::bigint)::float8 AS v
                              FROM app.ad_partner_events e, window_ w
                              WHERE e.advertiser_id = $2 AND e.kind = 'PURCHASE' AND e.occurred_at >= w.a AND e.occurred_at < w.b GROUP BY 1)
               SELECT (SELECT count(*) FROM exposed)::int AS ep, (SELECT count(*) FROM exposed JOIN sales USING (ad_id))::int AS ec,
                      (SELECT count(*) FROM held)::int AS hp, (SELECT count(*) FROM held JOIN sales USING (ad_id))::int AS hc,
                      (SELECT coalesce(sum(v), 0) FROM exposed JOIN sales USING (ad_id))::float8 AS ev,
                      (SELECT coalesce(sum(v), 0) FROM held JOIN sales USING (ad_id))::float8 AS hv,
                      (SELECT coalesce(sum(i.charged_micros), 0) FROM app.ad_impressions i, window_ w
                       WHERE i.campaign_id = $1 AND i.shown_at >= w.a AND i.shown_at < w.b)::text AS spend`,
              [campaign.id, campaign.advertiser, today, SALE_CLIP_MICROS],
            )
          ).rows[0],
        };
      });
      if (!outcome)
        return fail(reply, 429, 'privacy_budget', 'This business’s reports for today are used up. Try tomorrow.');
      const { secret, counts } = outcome;
      if (!counts) return { ready: false };
      const noisy = (name: string, value: number, sensitivity: number) =>
        Math.max(
          0,
          value +
            laplace(sensitivity / (LIFT_EPSILON / 4), cellUniform(secret, `lift|${campaign.id}|${yesterday}|${name}`)),
        );
      const exposedConversions = Math.round(noisy('ec', counts.ec, 1));
      const holdoutConversions = Math.round(noisy('hc', counts.hc, 1));
      const result = lift({
        exposedPeople: counts.ep,
        exposedConversions: Math.min(counts.ep, exposedConversions),
        holdoutPeople: counts.hp,
        holdoutConversions: Math.min(counts.hp, holdoutConversions),
      });
      // Under 100 a side, or under 25 who bought, the answer is "not yet": no number to compare.
      if (!result || counts.ec + counts.hc < MIN_PEOPLE) return { ready: false };
      const perExposed = noisy('ev', counts.ev, SALE_CLIP_MICROS) / Math.max(1, counts.ep);
      const perHeld = noisy('hv', counts.hv, SALE_CLIP_MICROS) / Math.max(1, counts.hp);
      const spend = Number(counts.spend);
      return {
        ready: true,
        lift: result,
        // Only sales a partner could report with a rotating id: a held-out person with no prior tap
        // has none, so this covers joinable sales only.
        iRoas: spend > 0 ? ((perExposed - perHeld) * counts.ep) / spend : null,
      };
    },
  );

  app.post(
    '/ads/advertisers/:id/keys',
    {
      config: { auth: 'required', write: true },
      schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] } },
    },
    async (req, reply) => {
      if (!deps.enabled()) return off(reply);
      const user = signedIn(req);
      const { id } = req.params as { id: string };
      const key = `grk_${randomBytes(32).toString('base64url')}`;
      const prefix = key.slice(0, 10);
      let outcome: 'ok' | 'missing' | 'forbidden' | 'too_many';
      try {
        outcome = await db.withUser(user.id, async q => {
          const advertiser = (
            await q.query<{ id: string }>('SELECT id::text FROM app.ad_advertisers WHERE public_id = $1', [id])
          ).rows[0];
          if (!advertiser) return 'missing' as const;
          await q.query('INSERT INTO app.ad_api_keys (advertiser_id, key_hash, prefix) VALUES ($1, $2, $3)', [
            advertiser.id,
            hashKey(key),
            prefix,
          ]);
          return 'ok' as const;
        });
      } catch (err) {
        if (pgCode(err) === '42501') outcome = 'forbidden';
        else if (pgCode(err) === '23514') outcome = 'too_many';
        else throw err;
      }
      if (outcome === 'missing') return fail(reply, 404, 'not_found', 'There’s no such advertiser you run.');
      if (outcome === 'forbidden') return fail(reply, 403, 'not_owner', 'Only the business’s owner can make keys.');
      if (outcome === 'too_many')
        return fail(reply, 400, 'too_many_keys', 'Revoke a key first: at most 10 work at once.');
      // Shown this once: Graphinity keeps only its hash.
      return reply.code(201).send({ key: { value: key, prefix } });
    },
  );

  app.delete(
    '/ads/advertisers/:id/keys/:prefix',
    {
      config: { auth: 'required', write: true },
      schema: {
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            prefix: { type: 'string', pattern: '^grk_[A-Za-z0-9_-]{6}$' },
          },
          required: ['id', 'prefix'],
        },
      },
    },
    async (req, reply) => {
      if (!deps.enabled()) return off(reply);
      const user = signedIn(req);
      const { id, prefix } = req.params as { id: string; prefix: string };
      const n = await db.withUser(
        user.id,
        async q =>
          (
            await q.query(
              `UPDATE app.ad_api_keys k SET revoked_at = now() FROM app.ad_advertisers a
             WHERE a.id = k.advertiser_id AND a.public_id = $1 AND k.prefix = $2 AND k.revoked_at IS NULL`,
              [id, prefix],
            )
          ).rowCount,
      );
      if (!n) return fail(reply, 404, 'not_found', 'There’s no such working key you can revoke.');
      return { key: { prefix, revoked: true } };
    },
  );

  // An advertiser's server reporting a conversion: `authorization: Bearer grk_…`.
  app.post(
    '/ads/conversions',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['clickId', 'externalId'],
          properties: {
            clickId: { type: 'string', format: 'uuid' },
            externalId: { type: 'string', minLength: 1, maxLength: 100 },
            valueMicros: { type: 'integer', minimum: 0, maximum: 1_000_000_000_000_000 },
            currency: { type: 'string', pattern: '^[A-Z]{3}$' },
            convertedAt: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (req, reply) => {
      if (!deps.enabled()) return off(reply);
      const header = req.headers.authorization;
      const key = header?.startsWith('Bearer ') ? header.slice(7) : '';
      if (!keyPattern.test(key)) return fail(reply, 401, 'bad_key', 'Send a working API key as a bearer token.');
      const hash = hashKey(key);
      const take = perKey.take(hash);
      if (!take.ok) {
        reply.header('retry-after', String(take.retryAfterSeconds));
        return fail(reply, 429, 'rate_limited', 'Too many requests. Wait a minute, then try again.');
      }
      const b = req.body as {
        clickId: string;
        externalId: string;
        valueMicros?: number;
        currency?: string;
        convertedAt?: string;
      };
      const result = await db.asSystem(
        async q =>
          (
            await q.query<{ r: string }>('SELECT app.record_ad_conversion($1, $2, $3, $4, $5, $6) AS r', [
              hash,
              b.clickId,
              b.externalId,
              b.valueMicros ?? null,
              b.currency ?? null,
              b.convertedAt ?? new Date(deps.clock.now()).toISOString(),
            ])
          ).rows[0]?.r,
      );
      if (result === 'recorded') return reply.code(201).send({ conversion: { counted: true } });
      if (result === 'already') return { conversion: { counted: true, duplicate: true } };
      return fail(reply, 404, 'not_counted', 'That conversion wasn’t counted: check the key and the click id.');
    },
  );

  // A campaign's numbers for the business that runs it: what it showed, what was tapped and
  // spent, and its share of the business's conversions under each attribution model. Paths
  // exist only for people who allow both personalized ads and measurement (their impressions
  // name their ad identity); every other conversion credits its one click. Holdout experiments,
  // not these models, measure what a campaign truly adds (ADR 0022 part 6b).
  app.get(
    '/ads/campaigns/:id/report',
    {
      config: { auth: 'required' },
      schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] } },
    },
    async (req, reply) => {
      if (!deps.enabled()) return off(reply);
      const user = signedIn(req);
      const { id } = req.params as { id: string };
      // Moderators can read every campaign to review it; a report is for the business's own members.
      const found = await db.withUser(
        user.id,
        async q =>
          (
            await q.query<{ id: string; advertiser_id: string }>(
              'SELECT id::text, advertiser_id::text FROM app.ad_campaigns WHERE public_id = $1 AND app.is_ad_member(advertiser_id)',
              [id],
            )
          ).rows[0],
      );
      if (!found) return fail(reply, 404, 'not_found', 'There’s no such campaign you run.');
      const data = await db.asSystem(async q => {
        // Impressions are the system's alone: people's ad identities never reach a business.
        const totals = (
          await q.query<{ people: number; impressions: number; clicks: number; spent: string }>(
            // People: identities, and each untracked impression as its own (part 8's count).
            `SELECT count(DISTINCT coalesce(ad_id::text, token::text))::int AS people, count(*)::int AS impressions,
                    count(clicked_at)::int AS clicks, coalesce(sum(charged_micros), 0)::text AS spent
             FROM app.ad_impressions WHERE campaign_id = $1 AND shown_at > now() - interval '30 days'`,
            [found.id],
          )
        ).rows[0] ?? { people: 0, impressions: 0, clicks: 0, spent: '0' };
        // The business's conversions in 30 days, each with the click it came from.
        const conversions = (
          await q.query<{
            campaign: string;
            ad_id: string | null;
            clicked_at: Date;
            converted_at: Date;
            value: string;
          }>(
            `SELECT i.campaign_id::text AS campaign, i.ad_id::text, i.clicked_at, c.converted_at, c.value_micros::text AS value
             FROM app.ad_conversions c JOIN app.ad_impressions i ON i.id = c.impression_id
             WHERE c.advertiser_id = $1 AND c.converted_at > now() - interval '30 days'
             ORDER BY c.id LIMIT $2`,
            [found.advertiser_id, REPORT_CONVERSIONS],
          )
        ).rows;
        // Impressions of the business's campaigns by people who allow measurement now (only
        // these join into paths): 30 days before a conversion that may itself be 30 days old.
        const seen = (
          await q.query<{ ad_id: string; campaign: string; at: Date }>(
            `SELECT i.ad_id::text, i.campaign_id::text AS campaign, i.shown_at AS at
             FROM app.ad_impressions i JOIN app.ad_campaigns c ON c.id = i.campaign_id
             JOIN app.ad_identities d ON d.ad_id = i.ad_id AND app.ads_permitted(d.profile_id, 'ads_measurement')
             WHERE c.advertiser_id = $1 AND i.shown_at > now() - interval '60 days'
             ORDER BY i.id DESC LIMIT $2`,
            [found.advertiser_id, REPORT_IMPRESSIONS],
          )
        ).rows;
        return { totals, conversions, seen };
      });
      // Exact numbers over a handful of people would tell a business that knows its buyers who
      // tapped (part 8): under MIN_PEOPLE, nothing is shown.
      if (data.totals.people < MIN_PEOPLE)
        return { report: { days: 30, belowMinimum: true, minimumPeople: MIN_PEOPLE } };
      const report = campaignReport(found.id, data.conversions, data.seen, Date.now());
      return {
        report: {
          days: 30,
          belowMinimum: false,
          impressions: data.totals.impressions,
          clicks: data.totals.clicks,
          spentMicros: Number(data.totals.spent),
          businessConversions: data.conversions.length,
          ...report,
        },
      };
    },
  );
}

/** At most this many conversions and impressions go into one report (newest impressions first). */
const REPORT_CONVERSIONS = 10_000;
const REPORT_IMPRESSIONS = 200_000;
const WINDOW_MS = 30 * 86_400_000;

/**
 * One campaign's share of its business's conversions (and their value) under every attribution
 * model. A conversion by a person whose identity is known has a path: their impressions of the
 * business's campaigns in the 30 days before it. Any other conversion credits its one click.
 * People seen in the last 30 days who didn't convert are what the data-driven model compares
 * against.
 */
export function campaignReport(
  campaign: string,
  conversions: ReadonlyArray<{
    campaign: string;
    ad_id: string | null;
    clicked_at: Date;
    converted_at: Date;
    value: string;
  }>,
  seen: ReadonlyArray<{ ad_id: string; campaign: string; at: Date }>,
  now: number,
) {
  const byPerson = new Map<string, Touch[]>();
  for (const s of seen) {
    const list = byPerson.get(s.ad_id) ?? [];
    list.push({ campaign: s.campaign, at: s.at.getTime() });
    byPerson.set(s.ad_id, list);
  }
  const converters = new Set<string>();
  let joined = 0;
  const paths = conversions.map(c => {
    const at = c.converted_at.getTime();
    const click = [{ campaign: c.campaign, at: c.clicked_at.getTime() }];
    let touches: Touch[] = click;
    if (c.ad_id) {
      converters.add(c.ad_id);
      const before = (byPerson.get(c.ad_id) ?? []).filter(t => t.at <= at && t.at > at - WINDOW_MS);
      if (before.length) {
        touches = before;
        joined += 1;
      }
    }
    return { path: { touches, converted: true, at }, value: Number(c.value) };
  });
  const others: Path[] = [];
  for (const [adId, touches] of byPerson) {
    if (converters.has(adId)) continue;
    const recent = touches.filter(t => t.at > now - WINDOW_MS);
    if (recent.length) others.push({ touches: recent, converted: false, at: now });
  }
  const shapley = shapleyModel([...paths.map(p => p.path), ...others]);
  const models: Array<[string, (p: Path) => Map<string, number>]> = [
    ...RULE_MODELS.map(m => [m, (p: Path) => ruleCredit(p, m)] as [string, (p: Path) => Map<string, number>]),
    ['data_driven', shapley],
  ];
  const credited: Record<string, { conversions: number; valueMicros: number }> = {};
  for (const [name, model] of models) {
    let share = 0;
    let value = 0;
    for (const p of paths) {
      const w = model(p.path).get(campaign) ?? 0;
      share += w;
      value += w * p.value;
    }
    credited[name] = { conversions: Math.round(share * 100) / 100, valueMicros: Math.round(value) };
  }
  return { credited, joinedPaths: joined };
}
