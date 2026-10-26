// Measuring what ads lead to (docs/adr/0022-advertising-platform.md part 6a):
// a business's API keys, and the conversions its server reports with them.
// A key is shown once and kept only as its SHA-256. Reporting answers the
// same "not counted" for every kind of refusal, so keys and click ids can't
// be probed.
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Database } from '../db.ts';
import { RULE_MODELS, ruleCredit, shapleyModel, type Path, type Touch } from '../ads/attribution.ts';
import { MIN_PEOPLE } from '../ads/privacy.ts';
import { TokenBuckets, type BucketOptions, type Clock } from '../rate-limit.ts';
import { fail, pgCode, signedIn } from './common.ts';

const keyPattern = /^grk_[A-Za-z0-9_-]{43}$/;
export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

export function registerAdMeasurementRoutes(
  app: FastifyInstance,
  deps: { db: Database; enabled: () => boolean; clock: Clock; limit: BucketOptions },
) {
  const { db } = deps;
  const off = (reply: FastifyReply) => fail(reply, 404, 'ads_off', 'Advertising on Graphinity isn’t available yet.');
  const perKey = new TokenBuckets(deps.limit, deps.clock);

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
