// The graph everyone sees on the home page, from real data only and with
// nobody identifiable: how many people know each field, a random sample of
// members as the sets of fields they know (no names, no ids, a new shuffle
// each time), and recent activity per field. docs/GRAPH.md.
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.ts';
import type { Clock } from '../rate-limit.ts';

/** Enough to draw clusters that feel alive; more adds nothing a phone can show. */
export const GRAPH_SAMPLE = 300;
const RECENT_EVENTS = 40;
/** Built at most once a minute, whoever asks: the page is the same for everyone. */
const KEEP_MS = 60_000;

export function registerGraphRoutes(app: FastifyInstance, { db, clock }: { db: Database; clock: Clock }) {
  let kept: { at: number; body: Promise<object> } | null = null;

  app.get('/graph', async (_req, reply) => {
    // Short-lived: it changes as people join and ask.
    reply.header('cache-control', 'public, max-age=300');
    if (!kept || clock.now() - kept.at > KEEP_MS) {
      const body = build();
      kept = { at: clock.now(), body };
      // A failed build isn't kept: the next request tries again.
      body.catch(() => { kept = null; });
    }
    return kept.body;
  });

  async function build() {
    const graph = await db.withUser(null, async q => {
      const fields = (await q.query<{ slug: string; name: string; members: number }>(
        `SELECT f.slug, f.name, count(pf.profile_id)::int AS members
         FROM app.fields f LEFT JOIN app.profile_fields pf ON pf.field = f.slug
         GROUP BY f.slug, f.name, f.position ORDER BY f.position`)).rows;
      const people = (await q.query<{ fields: string[] }>(
        `SELECT array_agg(pf.field ORDER BY pf.field) AS fields
         FROM app.profile_fields pf
         GROUP BY pf.profile_id
         ORDER BY random() LIMIT ${String(GRAPH_SAMPLE)}`)).rows;
      // What happened lately, per field: questions asked and answers given.
      // Removed or hidden posts are left out by row-level security, as everywhere.
      const recent = (await q.query<{ field: string; kind: 'question' | 'answer' }>(
        `SELECT field, kind FROM (
           SELECT q.field, 'question' AS kind, q.created_at AS at FROM app.questions q
           WHERE q.created_at > now() - interval '1 day'
           UNION ALL
           SELECT q.field, 'answer', a.created_at FROM app.answers a JOIN app.questions q ON q.id = a.question_id
           WHERE a.created_at > now() - interval '1 day'
         ) e ORDER BY at DESC LIMIT ${String(RECENT_EVENTS)}`)).rows;
      const counts = (await q.query<{ members: number; questions: number; answers: number }>(
        `SELECT (SELECT count(DISTINCT profile_id) FROM app.profile_fields)::int AS members,
                (SELECT count(*) FROM app.questions WHERE created_at > now() - interval '1 day')::int AS questions,
                (SELECT count(*) FROM app.answers WHERE created_at > now() - interval '1 day')::int AS answers`)).rows[0];
      // How many people know both of each pair of fields, from everyone (the
      // sample above is only for drawing). Under 5 the number stays here:
      // set against public profiles, it could point at who.
      const links = (await q.query<{ a: string; b: string; shared: number | null }>(
        `SELECT x.field AS a, y.field AS b, CASE WHEN count(*) >= 5 THEN count(*)::int END AS shared
         FROM app.profile_fields x JOIN app.profile_fields y ON y.profile_id = x.profile_id AND y.field > x.field
         GROUP BY x.field, y.field`)).rows;
      return { fields, people, recent, counts, links };
    });
    const index = new Map(graph.fields.map((f, i) => [f.slug, i]));
    const at = (slug: string) => index.get(slug) ?? -1;
    return {
      // Everyone with a profile (each person once, however many fields they know).
      members: graph.counts?.members ?? 0,
      fields: graph.fields.map(f => ({ slug: f.slug, name: f.name, members: f.members })),
      // Each person as the positions (in `fields`) of the fields they know.
      people: graph.people.map(p => p.fields.map(at)),
      // Pairs of fields people know together, as positions with a < b; shared is null under 5.
      links: graph.links.map(l => {
        const [a, b] = [at(l.a), at(l.b)].sort((x, y) => x - y);
        return { a, b, shared: l.shared };
      }),
      activity: {
        lastDay: { questions: graph.counts?.questions ?? 0, answers: graph.counts?.answers ?? 0 },
        recent: graph.recent.map(e => ({ field: at(e.field), kind: e.kind })),
      },
    };
  }
}
