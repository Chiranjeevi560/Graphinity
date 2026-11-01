// Ads for people (docs/adr/0022-advertising-platform.md): what their
// advertising profile says about them, with a way to remove any of it; and
// the ads themselves, chosen apart from knowledge results (part 4) and
// counted only when tapped. Ads are asked for on their own: no search,
// question or recommendation response ever carries one.
import { extractProducts } from '../commerce/entity.ts';
import type { FastifyInstance } from 'fastify';
import type { AdServer } from '../ads/serve.ts';
import type { Database } from '../db.ts';
import { TokenBuckets, visitorAddress, visitorKey, type BucketOptions, type Clock } from '../rate-limit.ts';
import { fieldsOfTopics } from '../ads/inbound.ts';
import { tokenize } from '../ml/text-embedding.ts';
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
    /** Clicks per person or address that can cost a business anything. */
    chargeLimit: BucketOptions;
  },
) {
  const { db } = deps;
  const buckets = new TokenBuckets(deps.limit, deps.clock);
  // ponytail: one server's memory, and people behind one address share it, which errs for the advertiser. Shared counters when there are two servers.
  const charges = new TokenBuckets(deps.chargeLimit, deps.clock);
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

  const partnerSignalsAllowed = (viewer: string) =>
    db.asSystem(
      async q =>
        (
          await q.query<{ ok: boolean }>(
            "SELECT app.flag_on('ads_partner_sites') AND app.ads_permitted($1, 'ads_partner_sites') AS ok",
            [viewer],
          )
        ).rows[0]?.ok === true,
    );

  // Whether a page should ask for ads at all, and whether this person's browser signals may be read.
  app.get('/ads/status', { config: { auth: 'optional' } }, async req => {
    if (!deps.enabled()) return { on: false, partnerSignals: false };
    const viewer = req.user?.id ?? null;
    if (!viewer || req.headers['sec-gpc'] === '1') return { on: true, partnerSignals: false };
    return { on: true, partnerSignals: await partnerSignalsAllowed(viewer) };
  });

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
            // Seen on arrival from outside: never stored, used only with partner-sites permission.
            landingQuery: { type: 'string', maxLength: 200 },
            browserTopics: { type: 'array', maxItems: 16, items: { type: 'integer', minimum: 1, maximum: 2000 } },
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
        landingQuery?: string;
        browserTopics?: number[];
      };
      let fields = body.field ? [body.field] : [];
      let title: string | null = null;
      if (body.placement === 'question') {
        if (!body.questionId) return fail(reply, 400, 'invalid_request', 'Say which question the ads are for.');
        // A question the reader may not see, or one moderators hid, has no ads.
        const question = await db.withUser(
          viewer,
          async q =>
            (
              await q.query<{ field: string; title: string; hidden: boolean }>(
                'SELECT field, title, app.is_question_hidden(id) AS hidden FROM app.questions WHERE id = $1',
                [body.questionId],
              )
            ).rows[0],
        );
        if (!question || question.hidden) return { ads: [] };
        fields = [question.field];
        title = question.title;
      }
      const ads = await deps.server.serve({
        placement: body.placement,
        fields,
        query: body.query ? cleanLine(body.query) : null,
        viewer,
        now: deps.clock.now(),
        // What a bidder may know of the page: its categories, never which page (an id leads to its words).
        path: '/',
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
        gpc: req.headers['sec-gpc'] === '1',
        ...(body.landingQuery || body.browserTopics
          ? {
              inbound: {
                words: body.landingQuery ? tokenize(cleanLine(body.landingQuery)).slice(0, 12) : [],
                fields: fieldsOfTopics(body.browserTopics ?? []),
              },
            }
          : {}),
      });
      // Products on this page, for the browser's own interest groups: only with permission, and no GPC.
      const words = title ?? body.query ?? '';
      const intent =
        viewer && words && req.headers['sec-gpc'] !== '1' && (await partnerSignalsAllowed(viewer))
          ? extractProducts(words).map(p => p.key)
          : [];
      return {
        ads: ads.map(a => ({ ...a, label: 'Sponsored' })),
        ...(intent.length ? { intentProducts: intent } : {}),
      };
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
      const key = viewer ? `u:${viewer}` : visitorKey(visitorAddress(req.ip), deps.keySecret);
      const row = await db.asSystem(
        async q =>
          (
            await q.query<{ destination: string; click_id: string | null }>(
              'SELECT destination, click_id::text FROM app.record_ad_click($1, $2, $3)',
              [token, viewer, charges.take(key).ok],
            )
          ).rows[0],
      );
      if (!row) {
        // Not one of ours: an outside bidder's ad (part 9a), counted once, charged to nobody here.
        const partner = await db.asSystem(
          async q =>
            (await q.query<{ url: string | null }>('SELECT app.record_partner_click($1) AS url', [token])).rows[0]?.url,
        );
        if (partner) return { destination: partner };
        return fail(reply, 404, 'not_found', 'This ad isn’t available any more.');
      }
      // A click id the advertiser can report a sale back with, only for people who allow measurement.
      const gpc = req.headers['sec-gpc'] === '1';
      const eid =
        viewer && !gpc
          ? await deps.server.tapEid?.(viewer, deps.clock.now(), req.headers['user-agent'] ?? null, token)
          : null;
      const clickId = gpc ? null : row.click_id;
      if (!clickId && !eid) return { destination: row.destination };
      const url = new URL(row.destination);
      if (clickId) url.searchParams.set('gr_click', clickId);
      if (eid) url.searchParams.set('gr_eid', eid);
      return { destination: url.toString() };
    },
  );
}
