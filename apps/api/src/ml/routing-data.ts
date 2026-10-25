// What learned routing learns from (ADR 0013): every settled exploit route
// with the factors it was chosen on, and what came of it. Read in a system
// transaction: app.route_factors is system-only (migration 0016).
//
//   responded: they answered that question within 7 days of being asked,
//              and the answer isn't hidden by moderation.
//   helped:    the asker picked that answer or marked it helpful.
//   judged:    the asker picked (even an answer since deleted) or marked anything.
//
// Labels are frozen at a horizon: picks and marks count only if made within
// 14 days of the question, and a route is read only once that has passed, so
// a later run sees the same labels. A pick changed after the horizon takes
// its question out of learning (what was picked first is gone). Only one
// factor version is read, so changed definitions never mix. Under the cap the
// newest routes are kept.
import { createHash } from 'node:crypto';
import type { Database } from '../db.ts';
import { FACTORS_VERSION } from '../routing-score.ts';
import type { GateExample } from './routing-gate.ts';

/** Most settled routes read per run: bounds memory and training time (9.5 s at 48,000 on an M2). */
/** Picks and marks after this many days from asking don't count; routes are read only after it. */
export const LABEL_HORIZON_DAYS = 14;
export const MAX_ROUTES = 50_000;

export async function loadRoutingExamples(
  db: Pick<Database, 'asSystem'>,
  limit = MAX_ROUTES,
): Promise<{ examples: GateExample[]; fingerprint: string; modelRanked: number }> {
  const rows = await db.asSystem(
    async q =>
      (
        await q.query<{
          question_id: string;
          profile_id: string;
          asker_id: string;
          wave: number;
          factors: number[];
          asker_age_days: number;
          asked_at: number;
          responded: boolean;
          helped: boolean;
          judged: boolean;
          model_ranked: boolean;
        }>(
          `SELECT f.question_id::text AS question_id, f.profile_id::text AS profile_id, q.asker_id::text AS asker_id,
                  f.wave, f.factors,
                  (extract(epoch FROM q.created_at - p.created_at) / 86400)::float8 AS asker_age_days,
                  (extract(epoch FROM q.created_at) * 1000)::float8 AS asked_at,
                  ans.id IS NOT NULL AS responded,
                  coalesce(ans.id IS NOT NULL AND (
                    EXISTS (SELECT 1 FROM app.selections s WHERE s.answer_id = ans.id AND s.selected_at <= horizon.at)
                    OR EXISTS (SELECT 1 FROM app.helpful_marks h WHERE h.answer_id = ans.id AND h.marked_at <= horizon.at)),
                    false) AS helped,
                  (EXISTS (SELECT 1 FROM app.selections s WHERE s.question_id = q.id AND s.selected_at <= horizon.at)
                   OR EXISTS (SELECT 1 FROM app.helpful_marks h JOIN app.answers a2 ON a2.id = h.answer_id
                              WHERE a2.question_id = q.id AND h.marked_at <= horizon.at)) AS judged,
                  f.model_version IS NOT NULL AS model_ranked
           FROM app.route_factors f
           JOIN app.routes r ON r.question_id = f.question_id AND r.profile_id = f.profile_id
           JOIN app.questions q ON q.id = f.question_id
           JOIN app.profiles p ON p.id = q.asker_id
           CROSS JOIN LATERAL (SELECT q.created_at + make_interval(days => $2) AS at) horizon
           LEFT JOIN LATERAL (
             SELECT a.id FROM app.answers a
             WHERE a.question_id = f.question_id AND a.answerer_id = f.profile_id
               AND a.created_at <= r.routed_at + interval '7 days'
               AND NOT app.is_answer_hidden(a.id)
             ORDER BY a.created_at LIMIT 1
           ) ans ON true
           WHERE f.factors_version = $1 AND NOT f.explore AND horizon.at < now()
             AND NOT app.is_question_hidden(q.id)
             AND NOT EXISTS (SELECT 1 FROM app.selections s WHERE s.question_id = q.id AND s.selected_at > horizon.at)
           ORDER BY f.question_id DESC, f.profile_id
           LIMIT $3`,
          [FACTORS_VERSION, LABEL_HORIZON_DAYS, limit],
        )
      ).rows,
  );
  const hash = createHash('sha256');
  for (const r of rows)
    hash.update(
      `${r.question_id}\u0000${r.profile_id}\u0000${String(r.responded)}${String(r.helped)}${String(r.judged)}\n`,
    );
  return {
    examples: rows.map(r => ({
      questionId: r.question_id,
      askerId: r.asker_id,
      wave: r.wave,
      factors: r.factors,
      responded: r.responded,
      helped: r.helped,
      judged: r.judged,
      askerAgeDays: r.asker_age_days,
      askedAt: r.asked_at,
    })),
    fingerprint: hash.digest('hex'),
    // Routes a learned model ranked: once one serves, it learns partly from its own choices.
    modelRanked: rows.filter(r => r.model_ranked).length,
  };
}

/** How long a decision's factors are kept: long enough for every daily run to learn from them. */
export const FACTOR_RETENTION_DAYS = 180;

/** Deletes factors past their retention (hourly, with the other expiry jobs). */
export async function purgeOldRouteFactors(db: Pick<Database, 'asSystem'>): Promise<number> {
  return db.asSystem(
    async q =>
      (
        await q.query(`DELETE FROM app.route_factors WHERE recorded_at < now() - make_interval(days => $1)`, [
          FACTOR_RETENTION_DAYS,
        ])
      ).rowCount ?? 0,
  );
}
