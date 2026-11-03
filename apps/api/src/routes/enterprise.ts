// Enterprise analytics (ADR 0033): organizations read noised topic demand with their own key, and the owner
// manages who may. Every rule is also in the database (migration 0070): the switch, the key, the quota and the
// 25-person floor are checked by app.enterprise_topic_demand, which is the only way to read.
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Database, Queryable } from '../db.ts';
import { auditWithin } from '../platform/jobs.ts';
import { TokenBuckets, type BucketOptions, type Clock } from '../rate-limit.ts';
import { fail, signedIn } from './common.ts';

const keyPattern = /^gre_[A-Za-z0-9_-]{43}$/;
const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

export function registerEnterpriseRoutes(
  app: FastifyInstance,
  deps: { db: Database; enabled: () => boolean; clock: Clock; limit: BucketOptions },
) {
  const { db } = deps;
  const perKey = new TokenBuckets(deps.limit, deps.clock);
  const off = (reply: FastifyReply) =>
    fail(reply, 404, 'enterprise_off', 'Enterprise analytics on Graphinity isn’t available yet.');

  async function asOwner<T>(userId: string, reply: FastifyReply, work: (q: Queryable) => Promise<T>) {
    const result = await db.withUser(userId, async q =>
      (await q.query<{ ok: boolean }>('SELECT app.is_owner() AS ok')).rows[0]?.ok === true
        ? { ok: true as const, value: await work(q) }
        : { ok: false as const },
    );
    return result.ok ? result.value : fail(reply, 403, 'not_owner', 'This page is for Graphinity’s owner.');
  }

  // An organization's server: `authorization: Bearer gre_…`. Products people asked about in a topic, per day.
  app.get(
    '/enterprise/v1/topics/:field',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['field'],
          properties: { field: { type: 'string', pattern: '^[a-z]+(-[a-z]+)*$', maxLength: 40 } },
        },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { days: { type: 'string', pattern: '^([1-9]|[1-8][0-9]|90)$' } },
        },
      },
    },
    async (req, reply) => {
      if (!deps.enabled()) return off(reply);
      const header = req.headers.authorization;
      const key = header?.startsWith('Bearer ') ? header.slice(7) : '';
      if (!keyPattern.test(key)) return fail(reply, 401, 'bad_key', 'Send your organization’s key as a Bearer token.');
      if (!perKey.take(hashKey(key)).ok) return fail(reply, 429, 'rate_limited', 'Too many requests. Slow down.');
      const { field } = req.params as { field: string };
      const days = Number((req.query as { days?: string }).days ?? '30');
      const { rows } = await db.asSystem(q =>
        q.query<{
          outcome: string;
          day: string | null;
          product: string | null;
          noisy_count: number | null;
        }>(
          `SELECT outcome, day::text AS day, product, noisy_count
           FROM app.enterprise_topic_demand($1, $2, $3)`,
          [hashKey(key), field, days],
        ),
      );
      const outcome = rows[0]?.outcome ?? 'ok';
      if (outcome === 'off') return off(reply);
      if (outcome === 'unknown') return fail(reply, 401, 'bad_key', 'That key isn’t valid, or was revoked.');
      if (outcome === 'quota')
        return fail(reply, 429, 'quota', 'Your organization has used today’s reads. They reset at midnight UTC.');
      return {
        field,
        days,
        // Each count has Laplace noise and covers 25 people or more; small or noisy days can read as 0.
        rows: rows.map(r => ({ day: r.day, product: r.product, noisyCount: r.noisy_count })),
      };
    },
  );

  app.get('/owner/enterprise/orgs', { config: { auth: 'required' } }, async (req, reply) =>
    asOwner(signedIn(req).id, reply, async q => ({
      orgs: (
        await q.query(
          `SELECT o.public_id AS id, o.name, o.daily_reads AS "dailyReads",
                  coalesce((SELECT r.reads FROM app.enterprise_reads r WHERE r.org_id = o.id AND r.day = current_date), 0) AS "readsToday",
                  coalesce((SELECT json_agg(json_build_object('prefix', k.prefix, 'revoked', k.revoked_at IS NOT NULL) ORDER BY k.id)
                            FROM app.enterprise_keys k WHERE k.org_id = o.id), '[]') AS keys
           FROM app.enterprise_orgs o ORDER BY o.id LIMIT 200`,
        )
      ).rows,
    })),
  );

  app.post(
    '/owner/enterprise/orgs',
    {
      config: { auth: 'required', write: true, freshAuth: true },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 100, pattern: '^\\S(.*\\S)?$' },
            dailyReads: { type: 'integer', minimum: 1, maximum: 100000 },
          },
        },
      },
    },
    async (req, reply) => {
      const { name, dailyReads } = req.body as { name: string; dailyReads?: number };
      return asOwner(signedIn(req).id, reply, async q => {
        const org = (
          await q.query<{ id: string }>(
            'INSERT INTO app.enterprise_orgs (name, daily_reads) VALUES ($1, $2) RETURNING public_id::text AS id',
            [name, dailyReads ?? 1000],
          )
        ).rows[0];
        await auditWithin(q, { action: 'enterprise.org_added', actor: 'owner', subject: org?.id ?? '', detail: {} });
        return reply.code(201).send({ org: { id: org?.id, name, dailyReads: dailyReads ?? 1000 } });
      });
    },
  );

  // The key is shown once, here; only its hash is kept.
  app.post(
    '/owner/enterprise/orgs/:id/keys',
    {
      config: { auth: 'required', write: true, freshAuth: true },
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const key = `gre_${randomBytes(32).toString('base64url')}`;
      const prefix = key.slice(0, 10);
      return asOwner(signedIn(req).id, reply, async q => {
        const org = (
          await q.query<{ id: string }>('SELECT id::text FROM app.enterprise_orgs WHERE public_id = $1', [id])
        ).rows[0];
        if (!org) return fail(reply, 404, 'not_found', 'There’s no such organization.');
        await q.query('INSERT INTO app.enterprise_keys (org_id, key_hash, prefix) VALUES ($1, $2, $3)', [
          org.id,
          hashKey(key),
          prefix,
        ]);
        await auditWithin(q, { action: 'enterprise.key_made', actor: 'owner', subject: prefix, detail: {} });
        return reply.code(201).send({ key, prefix });
      });
    },
  );

  app.delete(
    '/owner/enterprise/keys/:prefix',
    {
      config: { auth: 'required', write: true, freshAuth: true },
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['prefix'],
          properties: { prefix: { type: 'string', pattern: '^gre_[A-Za-z0-9_-]{6}$' } },
        },
      },
    },
    async (req, reply) => {
      const { prefix } = req.params as { prefix: string };
      return asOwner(signedIn(req).id, reply, async q => {
        const { rowCount } = await q.query(
          'UPDATE app.enterprise_keys SET revoked_at = now() WHERE prefix = $1 AND revoked_at IS NULL',
          [prefix],
        );
        if (!rowCount) return fail(reply, 404, 'not_found', 'There’s no live key with that start.');
        await auditWithin(q, { action: 'enterprise.key_revoked', actor: 'owner', subject: prefix, detail: {} });
        return reply.code(204).send();
      });
    },
  );
}
