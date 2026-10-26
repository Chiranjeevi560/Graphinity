// The operations view for moderators (docs/adr/0020-observability.md):
// SLOs and their error budgets, alerts firing, the slowest routes and each
// background job's health. Counts and times only, nothing about anyone; the
// database admits moderators and the server's own jobs (migration 0027).
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.ts';
import { loadStatus } from '../ops/store.ts';
import { isModerator } from './moderation.ts';
import { fail, signedIn } from './common.ts';

export function registerOpsRoutes(app: FastifyInstance, { db }: { db: Database }) {
  app.get('/ops/status', { config: { auth: 'required' } }, async (req, reply) => {
    const user = signedIn(req);
    const result = await db.withUser(user.id, async q =>
      (await isModerator(q)) ? { ok: true as const, status: await loadStatus(q) } : { ok: false as const },
    );
    if (!result.ok) return fail(reply, 403, 'not_a_moderator', 'This page is for moderators.');
    return result.status;
  });
}
