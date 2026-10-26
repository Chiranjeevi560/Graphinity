// What a person's advertising profile says about them (docs/adr/0022-advertising-platform.md):
// their interest topics, strongest first, and a way to remove any of them.
// Their own only: the database answers for the signed-in person alone.
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.ts';
import { fail, signedIn } from './common.ts';

export function registerAdRoutes(app: FastifyInstance, { db }: { db: Database }) {
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
}
