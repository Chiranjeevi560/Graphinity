// Putting a question to the people most likely to have done it, in waves:
// 10 people at once, 30 more if nobody has answered after 15 minutes, then
// 100 more after another hour. The database (db/schema.sql, app.routes)
// enforces the daily budget per person and never routes to the asker.
import type { Database, Queryable } from './db.ts';
import type { Events } from './events.ts';
import { errorKind } from './jobs.ts';

export const WAVES = [
  { wave: 1, size: 10, afterMinutes: 0 },
  { wave: 2, size: 30, afterMinutes: 15 },
  { wave: 3, size: 100, afterMinutes: 60 },
] as const;
/** Part of each wave kept for people who joined in the last two weeks. */
export const NEWCOMER_SHARE = 0.2;
/** Questions older than this are no longer routed further. */
const ROUTING_WINDOW = '1 day';

/** How much each part counts in a person's score (docs/GRAPH.md). They add up to 1. */
export const WEIGHTS = { expertise: 0.35, country: 0.2, responsiveness: 0.2, trust: 0.15, chance: 0.1 };
export type Weights = typeof WEIGHTS;

/** Why someone was asked, as it stood then: shown to them alone. */
export interface Reasons {
  sameCountry: boolean;
  fieldPoints: number;
  /** Null with nothing to go on yet. */
  trustPct: number | null;
  answeredPct: number | null;
  newcomer: boolean;
}

/**
 * People for one wave, best first. Only people who list the question's
 * field; never the asker, anyone already asked, anyone who already answered,
 * or anyone at today's limit. Each gets a score that learns from what they
 * did: points in this field (on a log scale against the best candidate),
 * the same country, how often they answered what was put to them in the
 * last 60 days, how often askers said their picked answers in this field
 * turned out right, and a little chance. No data counts as halfway (one
 * success in two tries), so newcomers aren't buried.
 */
async function candidates(q: Queryable, questionId: string, limit: number, newcomersOnly: boolean, weights: Weights): Promise<Array<{ id: string } & Reasons>> {
  if (limit <= 0) return [];
  const { rows } = await q.query<{ id: string; same_country: boolean; field_points: number; newcomer: boolean; asked: number; answered: number; trust_total: number; trust_correct: number }>(
    `WITH target AS (SELECT id, asker_id, field, country FROM app.questions WHERE id = $1),
     pool AS (
       SELECT p.id,
              coalesce(p.country = t.country, false) AS same_country,
              p.created_at > now() - interval '14 days' AS newcomer,
              coalesce((SELECT sum(l.amount) FROM app.points_ledger l WHERE l.recipient_id = p.id AND l.field = t.field), 0)::int AS field_points,
              asked.n AS asked, asked.answered,
              trust.total AS trust_total, trust.correct AS trust_correct
       FROM app.profiles p
       JOIN target t ON true
       JOIN app.profile_fields pf ON pf.profile_id = p.id AND pf.field = t.field
       -- Questions put to them in the last 60 days, and how many they
       -- answered. One sent in the last day counts only once answered: they
       -- still have time. A removed answer doesn't count as answering (row-level
       -- security hides it from this job, as from everyone but its author).
       CROSS JOIN LATERAL (
         SELECT count(*)::int AS n, count(*) FILTER (WHERE did.answered)::int AS answered
         FROM app.routes r
         CROSS JOIN LATERAL (SELECT EXISTS (
           SELECT 1 FROM app.answers a WHERE a.question_id = r.question_id AND a.answerer_id = p.id) AS answered) did
         WHERE r.profile_id = p.id AND r.routed_at > now() - interval '60 days'
           AND (r.routed_at < now() - interval '1 day' OR did.answered)
       ) asked
       -- Each asker counts once, with their latest word: as on profiles, but only this field.
       CROSS JOIN LATERAL (
         SELECT count(*)::int AS total, count(*) FILTER (WHERE latest.correct)::int AS correct
         FROM (SELECT DISTINCT ON (fq.asker_id) v.correct
               FROM app.verdicts v
               JOIN app.answers a ON a.id = v.answer_id
               JOIN app.questions fq ON fq.id = a.question_id
               WHERE a.answerer_id = p.id AND fq.field = t.field
               ORDER BY fq.asker_id, v.at DESC) latest
       ) trust
       WHERE p.id <> t.asker_id
         AND NOT EXISTS (SELECT 1 FROM app.routes r WHERE r.question_id = t.id AND r.profile_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM app.answers a WHERE a.question_id = t.id AND a.answerer_id = p.id)
         AND (NOT $3::boolean OR p.created_at > now() - interval '14 days')
         -- Already at today's limit: the database would skip them, wasting the place.
         AND (SELECT count(*) FROM app.routes r
              WHERE r.profile_id = p.id AND r.routed_at > clock_timestamp() - interval '1 day') < 5
     )
     SELECT id, same_country, field_points, newcomer, asked, answered, trust_total, trust_correct
     FROM pool
     ORDER BY
       $4::float8 * coalesce(ln(1 + field_points) / nullif(ln(1 + max(field_points) OVER ()), 0), 0)
       + $5::float8 * same_country::int
       + $6::float8 * (answered + 1)::float8 / (asked + 2)
       + $7::float8 * (trust_correct + 1)::float8 / (trust_total + 2)
       + $8::float8 * random() DESC
     LIMIT $2`,
    [questionId, limit, newcomersOnly, weights.expertise, weights.country, weights.responsiveness, weights.trust, weights.chance]);
  const pct = (part: number, whole: number) => whole > 0 ? Math.round(100 * part / whole) : null;
  return rows.map(r => ({
    id: r.id,
    sameCountry: r.same_country,
    fieldPoints: r.field_points,
    trustPct: pct(r.trust_correct, r.trust_total),
    answeredPct: pct(r.answered, r.asked),
    newcomer: r.newcomer,
  }));
}

/**
 * Routes one wave of a question. Returns the people actually asked (the
 * daily budget may skip some). Tests pass weights without chance, to check
 * the order the score gives.
 */
export async function routeWave(q: Queryable, questionId: string, wave: number, size: number, weights: Weights = WEIGHTS): Promise<string[]> {
  const newcomers = await candidates(q, questionId, Math.ceil(size * NEWCOMER_SHARE), true, weights);
  const rest = await candidates(q, questionId, size, false, weights);
  const people = [...new Map([...newcomers, ...rest].map(p => [p.id, p])).values()].slice(0, size);
  const asked: string[] = [];
  for (const p of people) {
    const res = await q.query(
      `INSERT INTO app.routes (question_id, profile_id, wave, same_country, field_points, trust_pct, answered_pct, newcomer)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
      [questionId, p.id, wave, p.sameCountry, p.fieldPoints, p.trustPct, p.answeredPct, p.newcomer]);
    if (res.rowCount) asked.push(p.id);
  }
  return asked;
}

/**
 * Sends every question that is due its next wave: no wave yet (a missed
 * first one), or still unanswered long enough after the last wave.
 * Returns what was routed, for the caller to notify.
 */
export async function routeDueQuestions(db: Database, log?: { warn(obj: object, msg: string): void }): Promise<Array<{ questionId: string; askerId: string; asked: string[] }>> {
  const due = await db.asSystem(async q => {
    const { rows } = await q.query<{ id: string; asker_id: string; wave: number | null; minutes_since: number | null; answered: boolean }>(
      `SELECT q.id::text AS id, q.asker_id, max(r.wave) AS wave,
              extract(epoch FROM clock_timestamp() - max(r.routed_at)) / 60 AS minutes_since,
              EXISTS (SELECT 1 FROM app.answers a WHERE a.question_id = q.id) AS answered
       FROM app.questions q LEFT JOIN app.routes r ON r.question_id = q.id
       WHERE q.created_at > now() - interval '${ROUTING_WINDOW}'
       GROUP BY q.id`);
    const waves: Array<{ questionId: string; askerId: string; wave: number; size: number }> = [];
    for (const row of rows) {
      const next = row.wave === null ? WAVES[0] : WAVES.find(w => w.wave === (row.wave ?? 0) + 1);
      if (!next) continue;
      if (row.wave !== null && (row.answered || (row.minutes_since ?? 0) < next.afterMinutes)) continue;
      waves.push({ questionId: row.id, askerId: row.asker_id, wave: next.wave, size: next.size });
    }
    return waves;
  });
  // Each question in its own transaction: one slow or failing question
  // doesn't undo everyone else's routing.
  const routed: Array<{ questionId: string; askerId: string; asked: string[] }> = [];
  for (const w of due) {
    try {
      routed.push({ questionId: w.questionId, askerId: w.askerId, asked: await db.asSystem(q => routeWave(q, w.questionId, w.wave, w.size)) });
    } catch (err) {
      log?.warn({ kind: errorKind(err) }, 'routing a question failed');
    }
  }
  return routed;
}

/**
 * Tells each person asked that a question is waiting for them, and the asker
 * that their question went out (their open page shows it travel).
 */
export function announceRouting(events: Pick<Events, 'publish'>, results: Array<{ questionId: string; askerId: string; asked: string[] }>): void {
  for (const { questionId, askerId, asked } of results) {
    for (const person of asked) events.publish(person, { type: 'routed', questionId });
    if (asked.length) events.publish(askerId, { type: 'sent', questionId });
  }
}
