// Watching learned routing once it serves (ADR 0014): automatic demotion when
// its predictions stop matching what happens, and the daily numbers on what
// exploration costs and finds.
//
// Demotion: on settled routes the serving model ranked (where the asker
// judged anything), compare helpful answers observed (O) with the sum of its
// predictions (E). With variance V = Σ p(1 − p), z = (O − E)/√V. If O falls
// short beyond chance (z < −2.58, 99%) and by a margin that matters
// (O < 0.8 E), the model is retired and routing returns to Ψ at once.
//
// Exploration's cost, without bias: each decided last place logged its
// propensity. The value of never exploring, estimated on those places by
// self-normalized inverse propensity weighting (SNIPS; Swaminathan &
// Joachims 2015), compared with what exploring actually got.
import type { Database } from '../db.ts';
import { LABEL_HORIZON_DAYS } from './routing-data.ts';
import { retireServing } from './registry.ts';

export { calibrationVerdict, MIN_CALIBRATION_ROUTES, type Calibration } from './routing-gate.ts';
import { calibrationVerdict, type Calibration } from './routing-gate.ts';

export interface ExplorationReport {
  decided: number;
  explored: number;
  /** Helpful rate on explored places and on places left to exploitation (settled, judged questions). */
  exploredHelped: number | null;
  keptHelped: number | null;
  /** SNIPS estimate of never exploring, against what was actually got: positive means exploration cost that much per place. */
  neverExploreValue: number | null;
  actualValue: number | null;
  reasons: Record<string, number>;
}

export function explorationReport(
  rows: ReadonlyArray<{ reason: string; propensity: number; helped: boolean }>,
): ExplorationReport {
  const reasons: Record<string, number> = {};
  for (const r of rows) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  const explored = rows.filter(r => r.reason === 'explored');
  const kept = rows.filter(r => r.reason !== 'explored');
  const rate = (xs: typeof rows) => (xs.length ? xs.filter(r => r.helped).length / xs.length : null);
  // Never exploring always takes exploitation's choice: the kept places, each weighted by 1/propensity.
  const weight = kept.reduce((s, r) => s + 1 / r.propensity, 0);
  const neverExploreValue =
    weight > 0 ? kept.reduce((s, r) => s + (r.helped ? 1 / r.propensity : 0), 0) / weight : null;
  return {
    decided: rows.length,
    explored: explored.length,
    exploredHelped: rate(explored),
    keptHelped: rate(kept),
    neverExploreValue,
    actualValue: rate(rows),
    reasons,
  };
}

/** Labels of settled, judged routes, as training reads them (the same horizon). */
const SETTLED = `
  JOIN app.routes r ON r.question_id = f.question_id AND r.profile_id = f.profile_id
  JOIN app.questions q ON q.id = f.question_id
  CROSS JOIN LATERAL (SELECT q.created_at + make_interval(days => $1) AS at) horizon
  CROSS JOIN LATERAL (
    SELECT EXISTS (
      SELECT 1 FROM app.answers a
      WHERE a.question_id = f.question_id AND a.answerer_id = f.profile_id
        AND a.created_at <= r.routed_at + interval '7 days' AND NOT app.is_answer_hidden(a.id)
        AND (EXISTS (SELECT 1 FROM app.selections s WHERE s.answer_id = a.id AND s.selected_at <= horizon.at)
             OR EXISTS (SELECT 1 FROM app.helpful_marks h WHERE h.answer_id = a.id AND h.marked_at <= horizon.at))
    ) AS helped,
    (EXISTS (SELECT 1 FROM app.selections s WHERE s.question_id = q.id AND s.selected_at <= horizon.at)
     OR EXISTS (SELECT 1 FROM app.helpful_marks h JOIN app.answers a2 ON a2.id = h.answer_id
                WHERE a2.question_id = q.id AND h.marked_at <= horizon.at)) AS judged
  ) o
  WHERE horizon.at < now() AND o.judged AND NOT app.is_question_hidden(q.id)`;

/** Checks the serving routing model, retires it if it fails, and reports on exploration. */
export async function monitorRouting(
  db: Pick<Database, 'asSystem'>,
): Promise<{ version: number | null; calibration: Calibration | null; exploration: ExplorationReport }> {
  return db.asSystem(async q => {
    const serving = (
      await q.query<{ version: number }>(
        `SELECT version FROM app.ml_models WHERE name = 'routing' AND status = 'production'`,
      )
    ).rows[0];
    let calibration: Calibration | null = null;
    if (serving) {
      const rows = (
        await q.query<{ predicted: number; helped: boolean }>(
          `SELECT f.predicted, o.helped FROM app.route_factors f ${SETTLED}
             AND f.model_version = $2 AND f.predicted IS NOT NULL`,
          [LABEL_HORIZON_DAYS, serving.version],
        )
      ).rows;
      calibration = calibrationVerdict(rows);
      if (calibration.demote) await retireServing(q, 'routing', serving.version, calibration.reason);
    }
    const decided = (
      await q.query<{ reason: string; propensity: number; helped: boolean }>(
        `SELECT f.explore_reason AS reason, f.propensity, o.helped FROM app.route_factors f ${SETTLED}
           AND f.explore_reason IS NOT NULL`,
        [LABEL_HORIZON_DAYS],
      )
    ).rows;
    return { version: serving?.version ?? null, calibration, exploration: explorationReport(decided) };
  });
}
