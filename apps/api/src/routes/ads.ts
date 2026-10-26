// Ads for people (docs/adr/0022-advertising-platform.md): what their
// advertising profile says about them, with a way to remove any of it; and
// the ads themselves, chosen apart from knowledge results (part 4) and
// counted only when tapped. Ads are asked for on their own: no search,
// question or recommendation response ever carries one.
import type { FastifyInstance } from 'fastify';
import type { AdServer } from '../ads/serve.ts';
import type { Database } from '../db.ts';
import { TokenBuckets, visitorAddress, visitorKey, type BucketOptions, type Clock } from '../rate-limit.ts';
import { cleanLine } from '../text.ts';
import { fail, signedIn } from './common.ts';

export function registerAdRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    enabled: () => boolean;
    server: AdServer;
    clock: Clock;
    limit: BucketOptions;
    keySecret: Buffer;
  },
) {
  const { db } = deps;
  const buckets = new TokenBuckets(deps.limit, deps.clock);
  const allowed = (userId: string | null, ip: string) =>
    buckets.take(userId ? `u:${userId}` : visitorKey(visitorAddress(ip), deps.keySecret));
  app.get('/me/ad-interests', { config: { auth: 'required' } }, async req => {
    const user = signedIn(req);
    const rows = await db.withUser(
      user.id,
      async q =>
        (
          await q.query<{ field: string; name: string; score: number; updated_at: Date }>(
            'SELECT field, name, score, updated_at FROM app.my_ad_interests()',
          )
        ).rows,
    );
    return {
      interests: rows.map(r => ({
        field: { slug: r.field, name: r.name },
        // 0-100: relative to the strongest, so the number says only how the topics compare.
        strength: Math.round((100 * r.score) / Math.max(...rows.map(x => x.score), Number.MIN_VALUE)),
        updatedAt: r.updated_at.toISOString(),
      })),
    };
  });

  app.delete(
    '/me/ad-interests/:field',
    {
      config: { auth: 'required', write: true },
      schema: {
        params: {
          type: 'object',
          properties: { field: { type: 'string', pattern: '^[a-z]+(-[a-z]+)*$', maxLength: 40 } },
          required: ['field'],
        },
      },
    },
    async (req, reply) => {
      const user = signedIn(req);
      const { field } = req.params as { field: string };
      const removed = await db.withUser(
        user.id,
        async q => (await q.query<{ ok: boolean }>('SELECT app.forget_ad_interest($1) AS ok', [field])).rows[0]?.ok,
      );
      if (!removed) return fail(reply, 404, 'not_found', 'Your advertising profile has no such topic.');
      return { removed: { field } };
    },
  );

  // Ads for a place on a page. While advertising is off, none: the page simply has no ads.
  app.post(
    '/ads/select',
    {
      config: { auth: 'optional' },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['placement'],
          properties: {
            placement: { enum: ['search', 'question'] },
            questionId: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' },
            query: { type: 'string', maxLength: 600 },
            field: { type: 'string', pattern: '^[a-z]+(-[a-z]+)*$', maxLength: 40 },
          },
        },
      },
    },
    async (req, reply) => {
      if (!deps.enabled()) return { ads: [] };
      const viewer = req.user?.id ?? null;
      const take = allowed(viewer, req.ip);
      if (!take.ok) {
        reply.header('retry-after', String(take.retryAfterSeconds));
        return fail(reply, 429, 'rate_limited', 'Too many requests. Wait a minute, then try again.');
      }
      const body = req.body as {
        placement: 'search' | 'question';
        questionId?: string;
        query?: string;
        field?: string;
      };
      let fields = body.field ? [body.field] : [];
      if (body.placement === 'question') {
        if (!body.questionId) return fail(reply, 400, 'invalid_request', 'Say which question the ads are for.');
        // A question the reader may not see, or one moderators hid, has no ads.
        const question = await db.withUser(
          viewer,
          async q =>
            (
              await q.query<{ field: string; hidden: boolean }>(
                'SELECT field, app.is_question_hidden(id) AS hidden FROM app.questions WHERE id = $1',
                [body.questionId],
              )
            ).rows[0],
        );
        if (!question || question.hidden) return { ads: [] };
        fields = [question.field];
      }
      const ads = await deps.server.serve({
        placement: body.placement,
        fields,
        query: body.query ? cleanLine(body.query) : null,
        viewer,
        now: deps.clock.now(),
      });
      return { ads: ads.map(a => ({ ...a, label: 'Sponsored' })) };
    },
  );

  // A tap on an ad: counted once, charged only if valid (record_ad_click), then the destination.
  app.post(
    '/ads/click/:token',
    {
      config: { auth: 'optional' },
      schema: {
        params: { type: 'object', properties: { token: { type: 'string', format: 'uuid' } }, required: ['token'] },
      },
    },
    async (req, reply) => {
      if (!deps.enabled()) return fail(reply, 404, 'not_found', 'This ad isn’t available any more.');
      const viewer = req.user?.id ?? null;
      const take = allowed(viewer, req.ip);
      if (!take.ok) {
        reply.header('retry-after', String(take.retryAfterSeconds));
        return fail(reply, 429, 'rate_limited', 'Too many requests. Wait a minute, then try again.');
      }
      const { token } = req.params as { token: string };
      const row = await db.asSystem(
        async q =>
          (
            await q.query<{ destination: string; click_id: string | null }>(
              'SELECT destination, click_id::text FROM app.record_ad_click($1, $2)',
              [token, viewer],
            )
          ).rows[0],
      );
      if (!row) return fail(reply, 404, 'not_found', 'This ad isn’t available any more.');
      // A click id the advertiser can report a sale back with, only for people who allow measurement.
      if (!row.click_id) return { destination: row.destination };
      const url = new URL(row.destination);
      url.searchParams.set('gr_click', row.click_id);
      return { destination: url.toString() };
    },
  );
}
