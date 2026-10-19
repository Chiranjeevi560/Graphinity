// Putting a question to the people most likely to have done it, in staged
// waves (docs/SPEC.md §11.2): 5 people at once; 5 more at 20
// minutes if fewer than 3 of them have opened it or answered; 5 more at 60
// minutes while there's no consensus yet (fewer than 3 answers: consensus
// needs at least 3). Experts' attention is scarce: at most 3 a day each.
// The database (db/schema.sql, app.routes) enforces that limit and never
// routes to the asker.
import type { Database, Queryable } from './db.ts';
import type { Events } from './events.ts';
import { errorKind } from './jobs.ts';
import { replay } from './reputation.ts';
import { judgements } from './routes/points.ts';
import { pageRank, psi } from './routing-score.ts';

/** Minutes after asking. */
export const WAVES = [
  { wave: 1, size: 5, afterMinutes: 0 },
  { wave: 2, size: 5, afterMinutes: 20 },
  { wave: 3, size: 5, afterMinutes: 60 },
] as const;
/** Questions put to one person in any 24 hours (the database holds the same number). */
export const DAILY_LIMIT = 3;
/** Wave 2 waits while this many of those asked have opened it or answered. */
const ENGAGED_ENOUGH = 3;
/** Wave 3 waits once this many answers exist: enough for a consensus. */
const ANSWERS_FOR_CONSENSUS = 3;
/** Part of each wave kept for people who joined in the last two weeks. */
export const NEWCOMER_SHARE = 0.2;
/** Questions older than this are no longer routed further. */
const ROUTING_WINDOW = '1 day';

/** Why someone was asked, as it stood then: shown to them alone. */
export interface Reasons {
  sameCountry: boolean;
  fieldPoints: number;
  /** Null with nothing to go on yet. */
  trustPct: number | null;
  answeredPct: number | null;
  newcomer: boolean;
}

interface PoolRow {
  id: string;
  same_country: boolean;
  picked_in_country: boolean;
  field_points: number;
  newcomer: boolean;
  asked: number;
  answered: number;
  trust_total: number;
  trust_correct: number;
  answers: number;
  picks: number;
  helped: number;
  median_reply: number | null;
  days_since_active: number | null;
  routes_in_field: number;
  used_today: number;
}

/**
 * People for one wave, best first, by the spec's score Ψ (routing-score.ts).
 * Only people who list the question's field; never the asker, anyone
 * already asked, anyone who already answered, or anyone at today's limit.
 * The SQL gathers what each person did in this field; the score is worked
 * out here, where each part is tested on its own.
 */
async function candidates(
  q: Queryable,
  questionId: string,
  limit: number,
  newcomersOnly: boolean,
): Promise<Array<{ id: string } & Reasons>> {
  if (limit <= 0) return [];
  const pool = (
    await q.query<PoolRow>(
      `WITH target AS (SELECT id, asker_id, field, country FROM app.questions WHERE id = $1)
     SELECT p.id,
            coalesce(p.country = t.country, false) AS same_country,
            EXISTS (SELECT 1 FROM app.selections s JOIN app.answers a ON a.id = s.answer_id JOIN app.questions sq ON sq.id = s.question_id
                    WHERE a.answerer_id = p.id AND sq.field = t.field AND sq.country = t.country) AS picked_in_country,
            p.created_at > now() - interval '14 days' AS newcomer,
            coalesce((SELECT sum(l.amount) FROM app.points_ledger l WHERE l.recipient_id = p.id AND l.field = t.field), 0)::int AS field_points,
            asked.n AS asked, asked.answered,
            trust.total AS trust_total, trust.correct AS trust_correct,
            (SELECT count(*) FROM app.answers a JOIN app.questions aq ON aq.id = a.question_id
             WHERE a.answerer_id = p.id AND aq.field = t.field)::int AS answers,
            (SELECT count(*) FROM app.selections s JOIN app.answers a ON a.id = s.answer_id JOIN app.questions sq ON sq.id = s.question_id
             WHERE a.answerer_id = p.id AND sq.field = t.field)::int AS picks,
            (SELECT count(DISTINCT h.answer_id) FROM app.points_ledger h
             WHERE h.recipient_id = p.id AND h.field = t.field AND h.amount > 0 AND h.reason IN ('selected', 'helpful')
               AND NOT EXISTS (SELECT 1 FROM app.points_ledger x WHERE x.reverses = h.id))::int AS helped,
            -- How long they took to answer what was put to them, middle value.
            (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM a.created_at - r.routed_at))
             FROM app.routes r JOIN app.answers a ON a.question_id = r.question_id AND a.answerer_id = r.profile_id
             WHERE r.profile_id = p.id)::float8 AS median_reply,
            (extract(epoch FROM now() - greatest(
              (SELECT max(a.created_at) FROM app.answers a WHERE a.answerer_id = p.id),
              (SELECT max(aq.created_at) FROM app.questions aq WHERE aq.asker_id = p.id),
              (SELECT max(r.seen_at) FROM app.routes r WHERE r.profile_id = p.id))) / 86400)::float8 AS days_since_active,
            (SELECT count(*) FROM app.routes r JOIN app.questions rq ON rq.id = r.question_id
             WHERE r.profile_id = p.id AND rq.field = t.field)::int AS routes_in_field,
            (SELECT count(*) FROM app.routes r
             WHERE r.profile_id = p.id AND r.routed_at > clock_timestamp() - interval '1 day')::int AS used_today
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
       AND (NOT $2::boolean OR p.created_at > now() - interval '14 days')
       -- Already at today's limit: the database would skip them, wasting the place.
       AND (SELECT count(*) FROM app.routes r
            WHERE r.profile_id = p.id AND r.routed_at > clock_timestamp() - interval '1 day') < ${String(DAILY_LIMIT)}`,
      [questionId, newcomersOnly],
    )
  ).rows;
  if (pool.length === 0) return [];
  const people = pool.map(r => r.id);

  const field = (
    await q.query<{ field: string; routes: number }>(
      `SELECT t.field, (SELECT count(*) FROM app.routes r JOIN app.questions rq ON rq.id = r.question_id WHERE rq.field = t.field)::int AS routes
     FROM app.questions t WHERE t.id = $1`,
      [questionId],
    )
  ).rows[0];
  if (!field) return [];
  const proximity = new Map(
    (
      await q.query<{ profile_id: string; proximity: number }>(
        'SELECT profile_id, proximity FROM app.experience_proximity($1, $2::uuid[])',
        [questionId, people],
      )
    ).rows.map(r => [r.profile_id, r.proximity]),
  );
  const games = await judgements(q, people, field.field);
  // Who picked whose answers in this field, and who is trusted to start from.
  const picks = (
    await q.query<{ asker: string; answerer: string }>(
      `SELECT sq.asker_id AS asker, a.answerer_id AS answerer
     FROM app.selections s JOIN app.answers a ON a.id = s.answer_id JOIN app.questions sq ON sq.id = s.question_id
     WHERE sq.field = $1`,
      [field.field],
    )
  ).rows;
  const moderators = (await q.query<{ id: string }>('SELECT profile_id AS id FROM app.moderators')).rows.map(r => r.id);
  const everyone = [...new Set([...people, ...moderators, ...picks.flatMap(p => [p.asker, p.answerer])])];
  const trust = pageRank(
    everyone,
    picks.map(p => [p.asker, p.answerer] as const),
    moderators,
  );

  const scored = pool.map(r => ({
    row: r,
    score: psi(
      {
        proximity: proximity.get(r.id) ?? null,
        skill: replay(games.get(r.id)?.get(field.field) ?? []),
        resident: r.same_country,
        pickedInCountry: r.picked_in_country,
        trust: trust.get(r.id) ?? 0,
        helped: r.helped,
        answers: r.answers,
        picks: r.picks,
        medianReplySeconds: r.median_reply,
        asked: r.asked,
        answered: r.answered,
        daysSinceActive: r.days_since_active,
        routesInField: r.routes_in_field,
        usedToday: r.used_today,
      },
      { routes: field.routes, dailyLimit: DAILY_LIMIT },
      { explore: newcomersOnly },
    ),
  }));
  // Best first; equal scores in a stable order, so the same facts give the same wave.
  scored.sort((a, b) => b.score - a.score || (a.row.id < b.row.id ? -1 : 1));
  const pct = (part: number, whole: number) => (whole > 0 ? Math.round((100 * part) / whole) : null);
  return scored.slice(0, limit).map(({ row: r }) => ({
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
 * daily budget may skip some). One place in five goes to a newcomer, the
 * spec's "4 exploit + 1 explore".
 */
export async function routeWave(q: Queryable, questionId: string, wave: number, size: number): Promise<string[]> {
  const newcomers = await candidates(q, questionId, Math.ceil(size * NEWCOMER_SHARE), true);
  const rest = await candidates(q, questionId, size, false);
  const people = [...new Map([...newcomers, ...rest].map(p => [p.id, p])).values()].slice(0, size);
  const asked: string[] = [];
  for (const p of people) {
    const res = await q.query(
      `INSERT INTO app.routes (question_id, profile_id, wave, same_country, field_points, trust_pct, answered_pct, newcomer)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
      [questionId, p.id, wave, p.sameCountry, p.fieldPoints, p.trustPct, p.answeredPct, p.newcomer],
    );
    if (res.rowCount) asked.push(p.id);
  }
  return asked;
}

/**
 * Sends every question that is due its next wave: no wave yet (a missed
 * first one); wave 2 from 20 minutes after asking, only if fewer than 3 of
 * those asked have opened it or answered; wave 3 from 60 minutes, only
 * while it has fewer than 3 answers. Returns what was routed, for the
 * caller to notify.
 */
export async function routeDueQuestions(
  db: Database,
  log?: { warn(obj: object, msg: string): void },
): Promise<Array<{ questionId: string; askerId: string; asked: string[] }>> {
  const due = await db.asSystem(async q => {
    const { rows } = await q.query<{
      id: string;
      asker_id: string;
      wave: number | null;
      age_minutes: number;
      engaged: number;
      answers: number;
    }>(
      `SELECT q.id::text AS id, q.asker_id, max(r.wave) AS wave,
              extract(epoch FROM clock_timestamp() - q.created_at) / 60 AS age_minutes,
              count(r.profile_id) FILTER (WHERE r.seen_at IS NOT NULL
                OR EXISTS (SELECT 1 FROM app.answers a WHERE a.question_id = q.id AND a.answerer_id = r.profile_id))::int AS engaged,
              (SELECT count(*) FROM app.answers a WHERE a.question_id = q.id)::int AS answers
       FROM app.questions q LEFT JOIN app.routes r ON r.question_id = q.id
       WHERE q.created_at > now() - interval '${ROUTING_WINDOW}'
       GROUP BY q.id`,
    );
    const waves: Array<{ questionId: string; askerId: string; wave: number; size: number }> = [];
    for (const row of rows) {
      const next = row.wave === null ? WAVES[0] : WAVES.find(w => w.wave === (row.wave ?? 0) + 1);
      if (!next || row.age_minutes < next.afterMinutes) continue;
      if (next.wave === 2 && row.engaged >= ENGAGED_ENOUGH) continue;
      if (next.wave === 3 && row.answers >= ANSWERS_FOR_CONSENSUS) continue;
      waves.push({ questionId: row.id, askerId: row.asker_id, wave: next.wave, size: next.size });
    }
    return waves;
  });
  // Each question in its own transaction: one slow or failing question
  // doesn't undo everyone else's routing.
  const routed: Array<{ questionId: string; askerId: string; asked: string[] }> = [];
  for (const w of due) {
    try {
      routed.push({
        questionId: w.questionId,
        askerId: w.askerId,
        asked: await db.asSystem(q => routeWave(q, w.questionId, w.wave, w.size)),
      });
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
export function announceRouting(
  events: Pick<Events, 'publish'>,
  results: Array<{ questionId: string; askerId: string; asked: string[] }>,
): void {
  for (const { questionId, askerId, asked } of results) {
    for (const person of asked) events.publish(person, { type: 'routed', questionId });
    if (asked.length) events.publish(askerId, { type: 'sent', questionId });
  }
}
