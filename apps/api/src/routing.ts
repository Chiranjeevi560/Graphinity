// Putting a question to the people most likely to have done it, in waves:
// 10 people at once, 30 more if nobody has answered after 15 minutes, then
// 100 more after another hour. The database (db/schema.sql, app.routes)
// enforces the daily budget per person and never routes to the asker.
import type { Database, Queryable } from './db.ts';

export const WAVES = [
  { wave: 1, size: 10, afterMinutes: 0 },
  { wave: 2, size: 30, afterMinutes: 15 },
  { wave: 3, size: 100, afterMinutes: 60 },
] as const;
/** Part of each wave kept for people who joined in the last two weeks. */
export const NEWCOMER_SHARE = 0.2;
/** Questions older than this are no longer routed further. */
const ROUTING_WINDOW = '1 day';

/**
 * People for one wave, best first: they know the question's field; then
 * those living in its country; then points earned in that field; then how
 * much they answered lately; ties broken at random. Never the asker, nobody
 * already asked or who already answered.
 */
async function candidates(q: Queryable, questionId: string, limit: number, newcomersOnly: boolean): Promise<string[]> {
  if (limit <= 0) return [];
  const { rows } = await q.query<{ id: string }>(
    `WITH target AS (SELECT id, asker_id, field, country FROM app.questions WHERE id = $1)
     SELECT p.id
     FROM app.profiles p
     JOIN target t ON true
     JOIN app.profile_fields pf ON pf.profile_id = p.id AND pf.field = t.field
     WHERE p.id <> t.asker_id
       AND NOT EXISTS (SELECT 1 FROM app.routes r WHERE r.question_id = t.id AND r.profile_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM app.answers a WHERE a.question_id = t.id AND a.answerer_id = p.id)
       AND (NOT $3::boolean OR p.created_at > now() - interval '14 days')
       -- Already at today's limit: the database would skip them, wasting the place.
       AND (SELECT count(*) FROM app.routes r
            WHERE r.profile_id = p.id AND r.routed_at > clock_timestamp() - interval '1 day') < 5
     ORDER BY
       (t.country IS NOT NULL AND p.country = t.country) DESC,
       coalesce((SELECT sum(l.amount) FROM app.points_ledger l WHERE l.recipient_id = p.id AND l.field = t.field), 0) DESC,
       (SELECT count(*) FROM app.answers a WHERE a.answerer_id = p.id AND a.created_at > now() - interval '30 days') DESC,
       random()
     LIMIT $2`, [questionId, limit, newcomersOnly]);
  return rows.map(r => r.id);
}

/** Routes one wave of a question. Returns the people actually asked (the daily budget may skip some). */
export async function routeWave(q: Queryable, questionId: string, wave: number, size: number): Promise<string[]> {
  const newcomers = await candidates(q, questionId, Math.ceil(size * NEWCOMER_SHARE), true);
  const rest = await candidates(q, questionId, size, false);
  const people = [...new Set([...newcomers, ...rest])].slice(0, size);
  const asked: string[] = [];
  for (const id of people) {
    const res = await q.query(
      'INSERT INTO app.routes (question_id, profile_id, wave) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [questionId, id, wave]);
    if (res.rowCount) asked.push(id);
  }
  return asked;
}

/**
 * Sends every question that is due its next wave: no wave yet (a missed
 * first one), or still unanswered long enough after the last wave.
 * Returns what was routed, for the caller to notify.
 */
export async function routeDueQuestions(db: Database, log?: { warn(obj: object, msg: string): void }): Promise<Array<{ questionId: string; asked: string[] }>> {
  const due = await db.asSystem(async q => {
    const { rows } = await q.query<{ id: string; wave: number | null; minutes_since: number | null; answered: boolean }>(
      `SELECT q.id::text AS id, max(r.wave) AS wave,
              extract(epoch FROM clock_timestamp() - max(r.routed_at)) / 60 AS minutes_since,
              EXISTS (SELECT 1 FROM app.answers a WHERE a.question_id = q.id) AS answered
       FROM app.questions q LEFT JOIN app.routes r ON r.question_id = q.id
       WHERE q.created_at > now() - interval '${ROUTING_WINDOW}'
       GROUP BY q.id`);
    const waves: Array<{ questionId: string; wave: number; size: number }> = [];
    for (const row of rows) {
      const next = row.wave === null ? WAVES[0] : WAVES.find(w => w.wave === (row.wave ?? 0) + 1);
      if (!next) continue;
      if (row.wave !== null && (row.answered || (row.minutes_since ?? 0) < next.afterMinutes)) continue;
      waves.push({ questionId: row.id, wave: next.wave, size: next.size });
    }
    return waves;
  });
  // Each question in its own transaction: one slow or failing question
  // doesn't undo everyone else's routing.
  const routed: Array<{ questionId: string; asked: string[] }> = [];
  for (const w of due) {
    try {
      routed.push({ questionId: w.questionId, asked: await db.asSystem(q => routeWave(q, w.questionId, w.wave, w.size)) });
    } catch (err) {
      log?.warn({ kind: err instanceof Error ? err.name : 'unknown' }, 'routing a question failed');
    }
  }
  return routed;
}
