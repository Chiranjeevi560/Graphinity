// The platform's addresses (API specification v2): the owner's dashboard and tools, which only
// people in app.platform_owners may reach, and the handful anyone may use. The database repeats
// every rule (migrations 0040-0044). Owner answers are aggregates: nothing here names a person.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Database, Queryable } from '../db.ts';
import { experimentArms } from '../experiments/enrol.ts';
import { evaluate } from '../experiments/stats.ts';
import { GRIEVANCE_KINDS } from '../governance/legal.ts';
import { RINGS } from '../governance/rollback.ts';
import { expectedWeeks, retentionRates, unitEconomics } from '../olap/rollups.ts';
import { TDigest } from '../olap/sketches.ts';
import { PROCESSING } from '../governance/ropa.ts';
import { extractClaims } from '../intelligence/claims.ts';
import { verifyFaithfulness } from '../intelligence/faithfulness.ts';
import { runPlan, type Tool } from '../intelligence/orchestrator.ts';
import { validPreference } from '../intelligence/memory.ts';
import { HyperLogLog } from '../olap/sketches.ts';
import { asOfJoin, auditWithin, loadExperimentArms, verifyAudit } from '../platform/jobs.ts';
import { TokenBuckets, visitorAddress, visitorKey, type BucketOptions, type Clock } from '../rate-limit.ts';
import { loadStatus } from '../ops/store.ts';
import { isModerator } from './moderation.ts';
import { fail, pgCode, signedIn } from './common.ts';

const slug = { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 80 };
const MAX_NEXT = 5;
/** Below this, "related" would be noise: the embeddings of two unrelated topics are near zero. */
const MIN_SIMILARITY = 0.3;

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [i, x] of a.entries()) {
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
const digits = { type: 'string', pattern: '^[1-9][0-9]{0,15}$' };

async function isOwner(q: Queryable): Promise<boolean> {
  return (await q.query<{ ok: boolean }>('SELECT app.is_owner() AS ok')).rows[0]?.ok === true;
}

export function registerPlatformRoutes(
  app: FastifyInstance,
  deps: { db: Database; clock: Clock; limit: BucketOptions; keySecret: Buffer },
) {
  const { db } = deps;
  const buckets = new TokenBuckets(deps.limit, deps.clock);
  const stepVotes = new TokenBuckets({ capacity: 1, refillPerSecond: 1 / 86_400, maxKeys: 100_000 }, deps.clock);

  async function asOwner<T>(userId: string, reply: FastifyReply, work: (q: Queryable) => Promise<T>) {
    const result = await db.withUser(userId, async q =>
      (await isOwner(q)) ? { ok: true as const, value: await work(q) } : { ok: false as const },
    );
    return result.ok ? result.value : fail(reply, 403, 'not_owner', 'This page is for Graphinity’s owner.');
  }

  // Move a switch through its rollout rings (ADR 0028). Going backwards is allowed.
  app.post(
    '/owner/rollouts',
    {
      config: { auth: 'required', write: true, freshAuth: true },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['flag', 'ring'],
          properties: {
            flag: { type: 'string', pattern: '^[a-z_]{1,60}$' },
            ring: { type: 'integer', minimum: 0, maximum: 3 },
          },
        },
      },
    },
    async (req, reply) => {
      const { flag, ring } = req.body as { flag: string; ring: number };
      return asOwner(signedIn(req).id, reply, async q => {
        const { rows } = await q.query<{ ok: boolean }>('SELECT app.set_flag_ring($1, $2::smallint) AS ok', [
          flag,
          ring,
        ]);
        if (!rows[0]?.ok) return fail(reply, 404, 'not_found', 'There’s no switch with that name.');
        await auditWithin(q, { action: 'rollout.moved', actor: 'owner', subject: flag, detail: { ring } });
        return { rollout: { flag, percent: RINGS[ring] } };
      });
    },
  );

  // What the owner spent bringing people in during a month; correcting a month replaces it.
  app.put(
    '/owner/acquisition-spend',
    {
      config: { auth: 'required', write: true, freshAuth: true },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['month', 'currency', 'amountMicros'],
          properties: {
            month: { type: 'string', pattern: '^20[0-9]{2}-(0[1-9]|1[0-2])$' },
            currency: { type: 'string', pattern: '^[A-Z]{3}$' },
            amountMicros: { type: 'integer', minimum: 0, maximum: 1e15 },
          },
        },
      },
    },
    async (req, reply) => {
      const { month, currency, amountMicros } = req.body as { month: string; currency: string; amountMicros: number };
      return asOwner(signedIn(req).id, reply, async q => {
        await q.query(
          `INSERT INTO app.acquisition_spend (month, currency, amount_micros) VALUES ($1::date, $2, $3)
           ON CONFLICT (month, currency) DO UPDATE SET amount_micros = EXCLUDED.amount_micros`,
          [`${month}-01`, currency, amountMicros],
        );
        await auditWithin(q, { action: 'acquisition_spend.set', actor: 'owner', subject: month, detail: { currency } });
        return { saved: true };
      });
    },
  );

  app.get('/owner/dashboard/summary', { config: { auth: 'required' } }, async (req, reply) =>
    asOwner(signedIn(req).id, reply, async q => {
      const rows = (
        await q.query<{ day: Date; events: string; questions: string; answers: string; hll: Buffer }>(
          `SELECT day, events::text, questions::text, answers::text, hll_unique_users AS hll
           FROM app.olap_daily_platform_cube WHERE day > now()::date - 56`,
        )
      ).rows;
      const today = deps.clock.now();
      // Daily-rotated hashes: a union over days would count one person once a day, so "monthly"
      // here reads as a sum of daily visitors' reach, only comparable with itself.
      const within = (days: number) => {
        const u = new HyperLogLog();
        let questions = 0;
        let answers = 0;
        for (const r of rows)
          if (today - r.day.getTime() < days * 86_400_000) {
            u.merge(HyperLogLog.fromBytes(r.hll));
            questions += Number(r.questions);
            answers += Number(r.answers);
          }
        return { activeDailyHashes: u.count(), questions, answers };
      };
      const series = new Map<string, number>();
      for (const r of rows) {
        const k = r.day.toISOString().slice(0, 10);
        series.set(k, (series.get(k) ?? 0) + Number(r.events));
      }
      const models = (
        await db.asSystem(
          async s =>
            (
              await s.query<{
                name: string;
                version: number;
                status: string;
                stage: string;
                algorithm: string;
                created_at: Date;
                metrics: unknown;
              }>(
                `SELECT DISTINCT ON (name) name, version, status, stage, algorithm, created_at, metrics FROM app.ml_models
               ORDER BY name, (status = 'production') DESC, version DESC`,
              )
            ).rows,
        )
      ).map(m => ({
        name: m.name,
        version: m.version,
        status: m.status,
        stage: m.stage,
        algorithm: m.algorithm,
        metrics: m.metrics,
        createdAt: m.created_at.toISOString(),
      }));
      const experiments = (
        await q.query<{ id: string; name: string; status: string; srm: number | null; p: number }>(
          `SELECT exp_id::text AS id, name, status, srm_p_value AS srm, always_valid_p AS p FROM app.exp_definitions ORDER BY exp_id DESC LIMIT 20`,
        )
      ).rows;
      const commerce = (
        await q.query<{
          label: string;
          field: string;
          count: number;
          forecast: number | null;
          forecast90: number | null;
          interval: number | null;
        }>(
          `SELECT p.label, c.field_id AS field, c.dp_noisy_intent_count AS count, c.holt_winters_forecast_30d AS forecast, c.holt_winters_forecast_90d AS forecast90, c.conformal_interval_90 AS interval
           FROM app.olap_daily_commerce_cube c JOIN app.products p ON p.id = c.product_entity_id
           WHERE c.day > now()::date - 7 ORDER BY c.dp_noisy_intent_count DESC LIMIT 20`,
        )
      ).rows;
      const answering = (
        await q.query<{ questions: number; resolved_4d: number; answered: number; tdigest_minutes: Buffer }>(
          `SELECT questions, resolved_4d, answered, tdigest_minutes FROM app.olap_daily_answering`,
        )
      ).rows;
      const minutes = new TDigest();
      for (const a of answering) minutes.merge(TDigest.fromBytes(a.tdigest_minutes));
      const asked = answering.reduce((sum, a) => sum + a.questions, 0);
      const cohorts = (
        await q.query<{ cohort_week: string; week_offset: number; cohort_size: number; active: number }>(
          `SELECT cohort_week::text AS cohort_week, week_offset, cohort_size, active FROM app.olap_cohort_retention
           WHERE cohort_week > now()::date - 91 AND cohort_size >= 25`,
        )
      ).rows;
      const retention = retentionRates(cohorts);
      const recent = (
        await q.query<{ person_weeks: string }>(
          `SELECT coalesce(sum(active), 0)::text AS person_weeks
           FROM app.olap_cohort_retention WHERE cohort_week + week_offset * 7 > now()::date - 28`,
        )
      ).rows[0];
      const income = await db.asSystem(
        async s =>
          (
            await s.query<{ currency: string; micros: string }>(
              `SELECT c.currency, sum(i.charged_micros)::text AS micros FROM app.ad_impressions i
               JOIN app.ad_campaigns c ON c.id = i.campaign_id
               WHERE i.shown_at > now() - interval '28 days' AND i.charged_micros > 0 GROUP BY c.currency`,
            )
          ).rows,
      );
      // The latest finished month with a figure, against who joined in it: the two sides must cover one whole period.
      const spends = (
        await q.query<{ currency: string; micros: string; joined: string }>(
          `SELECT DISTINCT ON (s.currency) s.currency, s.amount_micros::text AS micros,
                  (SELECT coalesce(sum(c.size), 0) FROM (
                     SELECT max(r.cohort_size) AS size FROM app.olap_cohort_retention r
                     WHERE r.cohort_week >= s.month AND r.cohort_week < s.month + interval '1 month' GROUP BY r.cohort_week
                   ) c)::text AS joined
           FROM app.acquisition_spend s WHERE s.month < date_trunc('month', now()) ORDER BY s.currency, s.month DESC`,
        )
      ).rows;
      const failedPushes = await db.asSystem(async s =>
        Number(
          (
            await s.query<{ n: string }>(
              `SELECT count(*)::text AS n FROM app.ad_partner_pushes WHERE NOT delivered AND day > now()::date - 7`,
            )
          ).rows[0]?.n,
        ),
      );
      const lifetimeWeeks = expectedWeeks(cohorts, deps.clock.now());
      const economics = [...new Set([...income, ...spends].map(r => r.currency))].sort().map(currency => {
        const spend = spends.find(r => r.currency === currency);
        return {
          currency,
          lifetimeWeeks,
          ...unitEconomics({
            revenueMicros: Number(income.find(r => r.currency === currency)?.micros ?? 0),
            personWeeks: Number(recent?.person_weeks ?? 0),
            lifetimeWeeks,
            spendMicros: spend ? Number(spend.micros) : null,
            joined: Number(spend?.joined ?? 0),
          }),
        };
      });
      const together = (
        await q.query<{ from: string; to: string; people: number; lift: number }>(
          `SELECT a.label AS from, b.label AS to, r.people, r.lift FROM app.olap_commerce_rules r
           JOIN app.products a ON a.id = r.from_product JOIN app.products b ON b.id = r.to_product
           ORDER BY r.lift DESC LIMIT 20`,
        )
      ).rows;
      return {
        answering: {
          questions: asked,
          resolvedRate: asked ? answering.reduce((sum, a) => sum + a.resolved_4d, 0) / asked : null,
          answeredRate: asked ? answering.reduce((sum, a) => sum + a.answered, 0) / asked : null,
          medianMinutes: minutes.total ? minutes.quantile(0.5) : null,
          p95Minutes: minutes.total ? minutes.quantile(0.95) : null,
        },
        retention,
        economics,
        failedPushes,
        together,
        totals: { day: within(1), week: within(7), month: within(28) },
        daily: [...series].sort().map(([day, events]) => ({ day, events })),
        health: await loadStatus(q),
        models,
        evaluations: (
          await q.query<{ name: string; metrics: unknown; at: Date }>(
            'SELECT name, metrics, evaluated_at AS at FROM app.model_evaluations ORDER BY name LIMIT 50',
          )
        ).rows.map(e => ({ name: e.name, metrics: e.metrics, at: e.at.toISOString() })),
        experiments,
        commerce,
        audit: await verifyAudit(q),
      };
    }),
  );

  app.post(
    '/knowledge-graph/bitemporal/query',
    {
      config: { auth: 'required' },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['entityKey', 'validAt', 'transactionAt'],
          properties: {
            entityKey: slug,
            validAt: { type: 'string', format: 'date-time' },
            transactionAt: { type: 'string', format: 'date-time' },
            maxHops: { type: 'integer', minimum: 1, maximum: 3 },
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body as { entityKey: string; validAt: string; transactionAt: string; maxHops?: number };
      return asOwner(signedIn(req).id, reply, () =>
        db.asSystem(async s => {
          const { rows } = await s.query<{
            source: string;
            target: string;
            relation: string;
            weight: number;
            hops: number;
          }>(
            `WITH RECURSIVE walk AS (
               SELECT n.id, 0 AS hops FROM app.kg_nodes n WHERE n.key = $1
               UNION
               SELECT e.target_node_id, w.hops + 1 FROM walk w JOIN app.kg_bitemporal_edges e ON e.source_node_id = w.id
               WHERE w.hops < $4 AND e.valid_from <= $2 AND $2 < e.valid_to AND e.tx_from <= $3 AND $3 < e.tx_to)
             SELECT a.key AS source, b.key AS target, e.relation_type AS relation, e.weight, min(w.hops) AS hops
             FROM walk w JOIN app.kg_bitemporal_edges e ON e.source_node_id = w.id
             JOIN app.kg_nodes a ON a.id = e.source_node_id JOIN app.kg_nodes b ON b.id = e.target_node_id
             WHERE w.hops < $4 AND e.valid_from <= $2 AND $2 < e.valid_to AND e.tx_from <= $3 AND $3 < e.tx_to
             GROUP BY 1, 2, 3, 4 LIMIT 500`,
            [b.entityKey, b.validAt, b.transactionAt, b.maxHops ?? 2],
          );
          return { edges: rows };
        }),
      );
    },
  );

  // A step within one visit, pooled: no person, no session id, nothing to follow anyone by.
  app.post(
    '/knowledge-graph/transitions',
    {
      config: { auth: 'optional' },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['from', 'to'],
          properties: { from: slug, to: slug, previous: slug },
        },
      },
    },
    async (req, reply) => {
      const take = buckets.take(req.user ? `u:${req.user.id}` : visitorKey(visitorAddress(req.ip), deps.keySecret));
      if (!take.ok) {
        reply.header('retry-after', String(take.retryAfterSeconds));
        return fail(reply, 429, 'rate_limited', 'Too many requests. Wait a minute, then try again.');
      }
      const b = req.body as { from: string; to: string; previous?: string };
      if (b.from === b.to) return reply.code(204).send();
      // Pooled with no person, and still only from someone who agreed to anonymous measurement. The same answer
      // either way: a page doesn't need to know, and shouldn't have to ask.
      if (!req.user || req.headers['sec-gpc'] === '1') return reply.code(204).send();
      const agreed = await db.withUser(
        req.user.id,
        async q =>
          (
            await q.query(
              `SELECT 1 FROM app.user_consent_settings
               WHERE user_id = app.current_user_id() AND category = 'anonymous_analytics' AND enabled`,
            )
          ).rowCount,
      );
      if (!agreed) return reply.code(204).send();
      // One person's say on a pair of topics, once a day: otherwise a single account could put any pair on everyone's pages.
      if (!stepVotes.take(`${req.user.id}:${b.from}:${b.to}`).ok) return reply.code(204).send();
      await db.asSystem(async q => {
        // Only topics we know: an open address must not fill the table with made-up keys.
        const known = await q.query('SELECT 1 FROM app.fields WHERE slug = ANY($1)', [
          [b.from, b.to, ...(b.previous ? [b.previous] : [])],
        ]);
        if (known.rowCount !== (b.previous && b.previous !== b.from && b.previous !== b.to ? 3 : 2)) return;
        for (const prior of b.previous ? ['', b.previous] : [''])
          await q.query(
            `INSERT INTO app.kg_session_transitions (from_key, to_key, prior_key) VALUES ($1, $2, $3)
             ON CONFLICT (from_key, to_key, prior_key) DO UPDATE SET
               decayed_transition_count = app.kg_session_transitions.decayed_transition_count
                 * exp(-extract(epoch FROM now() - app.kg_session_transitions.updated_at) / (30 * 86400)) + 1,
               updated_at = now()`,
            [b.from, b.to, prior],
          );
      });
      return reply.code(204).send();
    },
  );

  app.get(
    '/knowledge-graph/next',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['current'],
          properties: { current: slug, previous: slug },
        },
      },
    },
    async req => {
      const { current, previous } = req.query as { current: string; previous?: string };
      const { rows, similar, names } = await db.asSystem(async q => {
        const steps = (
          await q.query<{ item: string; c: number; prior_key: string }>(
            `SELECT to_key AS item, decayed_transition_count AS c, prior_key FROM app.kg_session_transitions
             WHERE from_key = $1 AND prior_key IN ('', $2)`,
            [current, previous ?? ''],
          )
        ).rows;
        // Topics near this one in the knowledge graph: what a new topic with no journeys yet can offer.
        const near = (
          await q.query<{ item: string; e: number[]; mine: number[] }>(
            `SELECT n.key AS item, e.embedding AS e, me.embedding AS mine
             FROM app.kg_nodes self JOIN app.kg_node_embeddings me ON me.node_id = self.id
             JOIN app.kg_nodes n ON n.kind = 'field' AND n.id <> self.id
             JOIN app.kg_node_embeddings e ON e.node_id = n.id
             WHERE self.kind = 'field' AND self.key = $1`,
            [current],
          )
        ).rows;
        const fields = (await q.query<{ slug: string; name: string }>('SELECT slug, name FROM app.fields')).rows;
        return { rows: steps, similar: near, names: new Map(fields.map(f => [f.slug, f.name])) };
      });
      const second = rows.filter(r => r.prior_key !== '');
      // Pooled counts, shown from five steps up. Steps aren't per person: someone repeating one can reach
      // five; nothing depends on this for ranking.
      const base = second.reduce((a, r) => a + r.c, 0) >= 5 ? second : rows.filter(r => r.prior_key === '');
      const total = base.reduce((a, r) => a + r.c, 0);
      const journeys =
        total < 5
          ? []
          : base
              .filter(r => r.item !== previous && names.has(r.item))
              .map(r => ({
                field: r.item,
                name: names.get(r.item) ?? r.item,
                share: r.c / total,
                because: 'journeys' as const,
              }))
              .sort((a, b) => b.share - a.share)
              .slice(0, 5)
              // In order, without the shares: on a rare topic an exact share could give away one reader's step.
              .map(({ field, name, because }) => ({ field, name, because }));
      const shown = new Set([current, previous, ...journeys.map(j => j.field)]);
      const related = similar
        .filter(r => !shown.has(r.item) && names.has(r.item))
        .map(r => ({ field: r.item, name: names.get(r.item) ?? r.item, score: cosine(r.mine, r.e) }))
        .filter(r => r.score >= MIN_SIMILARITY)
        .sort((a, b) => b.score - a.score || a.field.localeCompare(b.field))
        .slice(0, Math.max(0, MAX_NEXT - journeys.length))
        .map(r => ({ field: r.field, name: r.name, because: 'related' as const }));
      return { next: [...journeys, ...related] };
    },
  );

  app.post(
    '/feature-store/as-of-join',
    {
      config: { auth: 'required' },
      bodyLimit: 256 * 1024,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['entityType', 'featureGroups', 'observationTimestamps'],
          properties: {
            entityType: { enum: ['field', 'product', 'campaign'] },
            featureGroups: {
              type: 'array',
              minItems: 1,
              maxItems: 10,
              items: { type: 'string', pattern: '^[a-z_]{1,64}$' },
            },
            observationTimestamps: {
              type: 'array',
              minItems: 1,
              maxItems: 5000,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['entityId', 'observedAt'],
                properties: {
                  entityId: { type: 'string', maxLength: 100, minLength: 1 },
                  observedAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body as {
        entityType: string;
        featureGroups: string[];
        observationTimestamps: Array<{ entityId: string; observedAt: string }>;
      };
      return asOwner(signedIn(req).id, reply, () =>
        db.asSystem(async q => ({ rows: await asOfJoin(q, b.entityType, b.featureGroups, b.observationTimestamps) })),
      );
    },
  );

  app.get(
    '/experiments/evaluate',
    {
      config: { auth: 'required' },
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['experimentId'],
          properties: { experimentId: digits },
        },
      },
    },
    async (req, reply) => {
      const { experimentId } = req.query as { experimentId: string };
      return asOwner(signedIn(req).id, reply, () =>
        db.asSystem(async q => {
          const e = (
            await q.query<{ share: number; p: number; status: string }>(
              'SELECT control_share AS share, always_valid_p AS p, status FROM app.exp_definitions WHERE exp_id = $1',
              [experimentId],
            )
          ).rows[0];
          if (!e) return { found: false };
          const { control, treatment } = await loadExperimentArms(q, experimentId);
          return {
            found: true,
            status: e.status,
            units: { control: control.y.length, treatment: treatment.y.length },
            ...evaluate(control, treatment, [e.share, 1 - e.share], e.p),
          };
        }),
      );
    },
  );

  // A signed-in person's experiment arms. The unit is a keyed hash, per layer.
  app.get('/me/experiments', { config: { auth: 'required' } }, async req => experimentArms(db, signedIn(req).id));

  app.get(
    '/commerce/intelligence/forecast',
    {
      config: { auth: 'required' },
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['fieldSlug'],
          properties: { fieldSlug: slug },
        },
      },
    },
    async (req, reply) => {
      const { fieldSlug } = req.query as { fieldSlug: string };
      return asOwner(signedIn(req).id, reply, async q => ({
        products: (
          await q.query(
            `SELECT p.label, c.day::text AS day, c.dp_noisy_intent_count AS "noisyCount", c.holt_winters_forecast_30d AS "forecast30d",
                    c.holt_winters_forecast_90d AS "forecast90", c.conformal_interval_90 AS "interval90"
             FROM app.olap_daily_commerce_cube c JOIN app.products p ON p.id = c.product_entity_id
             WHERE c.field_id = $1 AND c.day > now()::date - 7 ORDER BY c.dp_noisy_intent_count DESC LIMIT 50`,
            [fieldSlug],
          )
        ).rows,
        // Rules aren't per field: people ask about things across fields, which is the point of them.
        together: (
          await q.query(
            `SELECT a.label AS from, b.label AS to, r.people, r.confidence, r.lift FROM app.olap_commerce_rules r
             JOIN app.products a ON a.id = r.from_product JOIN app.products b ON b.id = r.to_product
             ORDER BY r.lift DESC LIMIT 50`,
          )
        ).rows,
      }));
    },
  );

  // What people reported in a question's answers: only their numbers and sentences, each cited.
  // A DAG of read-only tools; nothing here writes an answer, and every sentence passes the verifier.
  app.get(
    '/questions/:id/evidence',
    {
      config: { auth: 'optional' },
      schema: { params: { type: 'object', properties: { id: digits }, required: ['id'] } },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const viewer = req.user?.id ?? null;
      const allowed = buckets.take(viewer ? `u:${viewer}` : visitorKey(visitorAddress(req.ip), deps.keySecret));
      if (!allowed.ok) {
        reply.header('retry-after', String(allowed.retryAfterSeconds));
        return fail(reply, 429, 'rate_limited', 'Too many requests. Wait a minute, then try again.');
      }
      type Answers = Array<{ id: string; body: string }>;
      const tools = new Map<string, Tool<null>>([
        [
          'answers',
          {
            name: 'answers',
            readOnly: true,
            timeoutMs: 1_000,
            run: () =>
              db.withUser(
                viewer,
                async q =>
                  (
                    await q.query<{ id: string; body: string }>(
                      `SELECT a.id::text, a.body FROM app.answers a
                       WHERE a.question_id = $1 AND NOT app.is_answer_hidden(a.id) AND NOT app.is_question_hidden(a.question_id) ORDER BY a.id LIMIT 200`,
                      [id],
                    )
                  ).rows,
              ),
          },
        ],
        [
          'claims',
          {
            name: 'claims',
            readOnly: true,
            timeoutMs: 200,
            run: i =>
              Promise.resolve(
                ((i.answers ?? []) as Answers).flatMap(a => extractClaims(a.body).map(c => ({ ...c, answer: a.id }))),
              ),
          },
        ],
      ]);
      const results = await runPlan(
        [
          { id: 'a', tool: 'answers', input: {} },
          { id: 'c', tool: 'claims', input: { answers: { $from: 'a' } }, after: ['a'] },
        ],
        tools,
        null,
      );
      const a = results.get('a');
      const c = results.get('c');
      if (!a?.ok || !c?.ok)
        return fail(reply, 503, 'unavailable', 'This can’t be worked out right now. Try again in a minute.');
      const answers = a.value as Answers;
      const claims = c.value as Array<ReturnType<typeof extractClaims>[number] & { answer: string }>;
      const bodies = new Map(answers.map(x => [x.id, x.body]));
      return {
        claims: claims
          .slice(0, 100)
          // Each quote checked against its own answer only: one comparison, not every answer's.
          .filter(
            x =>
              verifyFaithfulness(x.sentence, [{ id: x.answer, text: bodies.get(x.answer) ?? '' }]).dropped.length === 0,
          )
          .map(x => ({
            metric: x.metric,
            value: x.value,
            currency: x.currency ?? null,
            port: x.port ?? null,
            outcome: x.outcome,
            quote: x.sentence,
            answerId: x.answer,
          })),
      };
    },
  );

  // Memory (charter §10.3): the person's to see, set and clear, only with their consent.
  app.get('/me/memory', { config: { auth: 'required' } }, async req => {
    const user = signedIn(req);
    return db.withUser(user.id, async q => ({
      entries: (
        await q.query(
          `SELECT tier, key, value, strength, reviews, seen_at AS "seenAt" FROM app.memory_entries WHERE user_id = $1 ORDER BY tier, key`,
          [user.id],
        )
      ).rows,
    }));
  });
  app.put(
    '/me/memory/preferences/:name',
    {
      config: { auth: 'required', write: true },
      schema: {
        params: {
          type: 'object',
          properties: { name: { type: 'string', pattern: '^[a-z]{1,20}$' } },
          required: ['name'],
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['value'],
          properties: { value: { type: 'string', maxLength: 40 } },
        },
      },
    },
    async (req, reply) => {
      const user = signedIn(req);
      const { name } = req.params as { name: string };
      const { value } = req.body as { value: string };
      if (!validPreference(name, value))
        return fail(reply, 400, 'invalid_preference', 'That isn’t one of the choices.');
      try {
        const saved = await db.withUser(user.id, q =>
          q.query(
            `INSERT INTO app.memory_entries (user_id, tier, key, value)
             SELECT $1, 'procedural', $2, $3 WHERE app.memory_allowed_locked($1)
             ON CONFLICT (user_id, tier, key) DO UPDATE SET value = excluded.value, seen_at = now()`,
            [user.id, name, value],
          ),
        );
        // Memory was off, or was being turned off this instant: the lock settles which came first.
        if (!saved.rowCount)
          return await fail(reply, 403, 'consent_required', 'Turn on remembering in Privacy settings first.');
      } catch (err) {
        if ((err as { code?: string }).code === '42501')
          return fail(reply, 403, 'consent_required', 'Turn on remembering in Privacy settings first.');
        throw err;
      }
      return { saved: { name, value } };
    },
  );
  app.delete('/me/memory', { config: { auth: 'required', write: true } }, async req => {
    const user = signedIn(req);
    const n = await db.withUser(
      user.id,
      async q => (await q.query('DELETE FROM app.memory_entries WHERE user_id = $1', [user.id])).rowCount,
    );
    return { deleted: n ?? 0 };
  });

  // Complaints (India IT Rules 2021; for a lawyer to confirm): clocks come from the database.
  app.post(
    '/grievances',
    {
      config: { auth: 'required', write: true },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'body'],
          properties: {
            kind: { enum: [...GRIEVANCE_KINDS] },
            body: { type: 'string', minLength: 10, maxLength: 4000 },
            questionId: digits,
            sworn: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const user = signedIn(req);
      const b = req.body as { kind: string; body: string; questionId?: string; sworn?: boolean };
      if (b.kind === 'copyright' && !b.sworn)
        return fail(reply, 400, 'sworn_required', 'A copyright notice needs your sworn statement that it is accurate.');
      const row = await db
        .withUser(user.id, async q => {
          const r = (
            await q.query<{ public_id: string; reference: string; acknowledge_by: Date; resolve_by: Date }>(
              `INSERT INTO app.grievances (user_id, kind, body, question_id, sworn, acknowledge_by, resolve_by)
             VALUES ($1, $2, $3, (SELECT id FROM app.questions WHERE id = $4), $5, now(), now())
             RETURNING public_id::text, reference, acknowledge_by, resolve_by`,
              [user.id, b.kind, b.body.trim(), b.questionId ?? null, b.sworn === true],
            )
          ).rows[0];
          await auditWithin(q, {
            action: 'grievance.received',
            actor: 'person',
            subject: r?.public_id ?? '',
            detail: { kind: b.kind },
          });
          return r;
        })
        .catch((err: unknown) => {
          if (pgCode(err) === 'GR001') return 'too_many' as const;
          throw err;
        });
      if (row === 'too_many')
        return fail(
          reply,
          429,
          'too_many_open',
          'You have 5 complaints still open. We’ll answer those first; you can send another after one is resolved.',
        );
      return reply.code(201).send({
        grievance: {
          id: row?.public_id,
          reference: row?.reference,
          acknowledgeBy: row?.acknowledge_by.toISOString(),
          resolveBy: row?.resolve_by.toISOString(),
        },
      });
    },
  );
  // The record of processing (GDPR Art. 30): public, as a privacy notice is.
  app.get('/privacy/ropa', () => Promise.resolve({ draft: true, processing: PROCESSING }));

  // Decisions about a person's own posts, with reasons, and the appeal (DSA Art. 17, 20).
  app.get('/me/statements', { config: { auth: 'required' } }, async req => {
    const user = signedIn(req);
    const { rows } = await db.withUser(user.id, q =>
      q.query(
        `SELECT public_id AS id, question_id::text AS "questionId", restriction, facts, legal_ground AS "legalGround",
                terms_ground AS "termsGround", automated, redress, issued_at AS "issuedAt", appeal_by AS "appealBy",
                appeal_status AS "appealStatus"
         FROM app.statements_of_reasons WHERE affected_id = $1 ORDER BY issued_at DESC LIMIT 50`,
        [user.id],
      ),
    );
    return { statements: rows };
  });
  app.post(
    '/me/statements/:id/appeal',
    {
      config: { auth: 'required', write: true },
      schema: {
        params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['why'],
          properties: { why: { type: 'string', minLength: 10, maxLength: 2000 } },
        },
      },
    },
    async (req, reply) => {
      const user = signedIn(req);
      const { id } = req.params as { id: string };
      const { why } = req.body as { why: string };
      const done = await db.withUser(user.id, async q => {
        const { rows } = await q.query<{ ok: boolean }>('SELECT app.appeal_statement($1, $2) AS ok', [id, why.trim()]);
        const ok = rows[0]?.ok === true;
        if (ok) await auditWithin(q, { action: 'statement.appealed', actor: 'person', subject: id, detail: {} });
        return ok;
      });
      if (!done)
        return fail(
          reply,
          409,
          'cannot_appeal',
          'This can’t be appealed: it was already appealed, or the 14 days have passed.',
        );
      return reply.code(201).send({ appeal: { received: true } });
    },
  );
  app.get('/ops/appeals', { config: { auth: 'required', freshAuth: true } }, async (req, reply) => {
    const user = signedIn(req);
    const result = await db.withUser(user.id, async q =>
      (await isModerator(q))
        ? {
            appeals: (
              await q.query(
                `SELECT public_id AS id, restriction, facts, appeal_text AS why, appealed_at AS "appealedAt"
                 FROM app.statements_of_reasons WHERE appeal_status = 'appealed' ORDER BY appealed_at LIMIT 100`,
              )
            ).rows,
          }
        : null,
    );
    return result ?? fail(reply, 403, 'not_a_moderator', 'This page is for moderators.');
  });
  app.post(
    '/ops/appeals/:id',
    {
      config: { auth: 'required', write: true, freshAuth: true },
      schema: {
        params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['decision'],
          properties: { decision: { enum: ['uphold', 'overturn'] } },
        },
      },
    },
    async (req, reply) => {
      const user = signedIn(req);
      const { id } = req.params as { id: string };
      const { decision } = req.body as { decision: 'uphold' | 'overturn' };
      const outcome = await db.withUser(user.id, async q => {
        if (!(await isModerator(q))) return 'forbidden';
        const { rows } = await q.query<{ r: string }>('SELECT app.decide_appeal($1, $2) AS r', [
          id,
          decision === 'uphold',
        ]);
        const result = rows[0]?.r ?? 'not_open';
        if (result === 'decided')
          await auditWithin(q, { action: `statement.${decision}`, actor: 'moderator', subject: id, detail: {} });
        return result;
      });
      if (outcome === 'forbidden') return fail(reply, 403, 'not_a_moderator', 'This page is for moderators.');
      if (outcome === 'same_person')
        return fail(reply, 403, 'same_person', 'Another moderator has to decide this appeal.');
      if (outcome !== 'decided') return fail(reply, 404, 'not_found', 'There’s no open appeal with that id.');
      return { appeal: { id, decision } };
    },
  );
  app.get(
    '/ops/grievances',
    {
      config: { auth: 'required', freshAuth: true },
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { page: { type: 'string', pattern: '^[0-9]{1,4}$' } },
        },
      },
    },
    async (req, reply) => {
      const user = signedIn(req);
      const page = Number((req.query as { page?: string }).page ?? 0);
      const result = await db.withUser(user.id, async q =>
        (await isModerator(q))
          ? {
              rows: (
                await q.query(
                  `SELECT public_id AS id, reference, kind, body, received_at AS "receivedAt", acknowledge_by AS "acknowledgeBy",
                        resolve_by AS "resolveBy", acknowledged_at AS "acknowledgedAt"
                 FROM app.grievances WHERE resolved_at IS NULL ORDER BY resolve_by, id LIMIT 100 OFFSET $1`,
                  [page * 100],
                )
              ).rows,
              open: Number(
                (await q.query<{ n: string }>('SELECT count(*) AS n FROM app.grievances WHERE resolved_at IS NULL'))
                  .rows[0]?.n ?? 0,
              ),
            }
          : null,
      );
      return result ?? fail(reply, 403, 'not_a_moderator', 'This page is for moderators.');
    },
  );
  app.patch(
    '/ops/grievances/:id',
    {
      config: { auth: 'required', write: true, freshAuth: true },
      schema: {
        params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['action'],
          properties: {
            action: { enum: ['acknowledge', 'resolve'] },
            outcome: { type: 'string', minLength: 5, maxLength: 2000 },
          },
        },
      },
    },
    async (req, reply) => {
      const user = signedIn(req);
      const { id } = req.params as { id: string };
      const b = req.body as { action: 'acknowledge' | 'resolve'; outcome?: string };
      if (b.action === 'resolve' && !b.outcome) return fail(reply, 400, 'outcome_required', 'Say what was decided.');
      const changed = await db.withUser(user.id, async q => {
        if (!(await isModerator(q))) return null;
        const { rowCount } = await q.query(
          b.action === 'acknowledge'
            ? `UPDATE app.grievances SET acknowledged_at = coalesce(acknowledged_at, clock_timestamp()) WHERE public_id = $1 AND resolved_at IS NULL`
            : `UPDATE app.grievances SET resolved_at = clock_timestamp(), outcome = $2,
                   acknowledged_at = coalesce(acknowledged_at, clock_timestamp()) WHERE public_id = $1 AND resolved_at IS NULL`,
          b.action === 'acknowledge' ? [id] : [id, b.outcome],
        );
        if (rowCount)
          await auditWithin(q, { action: `grievance.${b.action}`, actor: 'moderator', subject: id, detail: {} });
        return rowCount;
      });
      if (changed === null) return fail(reply, 403, 'not_a_moderator', 'This page is for moderators.');
      if (!changed) return fail(reply, 404, 'not_found', 'There’s no open complaint with that id.');
      return { ok: true };
    },
  );
}
