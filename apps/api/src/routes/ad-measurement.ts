// Measuring what ads lead to (docs/adr/0022-advertising-platform.md part 6a):
// a business's API keys, and the conversions its server reports with them.
// A key is shown once and kept only as its SHA-256. Reporting answers the
// same "not counted" for every kind of refusal, so keys and click ids can't
// be probed.
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Database } from '../db.ts';
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
}
