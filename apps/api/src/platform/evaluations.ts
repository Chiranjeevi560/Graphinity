// The daily measuring job: engines that report on what the product does, and change nothing anyone sees. Each needs
// a floor of real data; below it, it reports nothing rather than a number that means nothing. The heavy work runs
// outside the database transaction, so a slow fit never holds a connection.
import { estimateElasticity } from '../commerce/elasticity.ts';
import { classifyCommercialIntent, INTENT_DIMENSIONS } from '../commercial-intent.ts';
import type { Database, Queryable } from '../db.ts';
import {
  doublyRobustValue,
  fitPositionBias,
  ipsValue,
  type ClickLog,
  type LoggedDecision,
} from '../ml/counterfactual.ts';
import { fitDelayedFeedback, predictConversion, type DelayedExample } from '../ml/delayed-feedback.ts';
import { searchTpe, walkForwardFolds } from '../ml/tuning.ts';
import { effect, fitXLearner, qini, type UpliftRow } from '../ml/uplift.ts';

export const MIN_CLICKS = 200;
export const MIN_SEARCH_ROWS = 500;
export const MIN_DECISIONS = 200;
export const MIN_PER_ARM = 100;
export const MIN_QUESTIONS = 50;
const MAX_ROWS = 5_000;
const DAY_MS = 86_400_000;
/** A sale later than this after its click isn't credited, so an older click's outcome is final. */
const SETTLED_DAYS = 30;

const clamp = (p: number) => Math.min(1 - 1e-6, Math.max(1e-6, p));
const logLoss = (p: number, y: boolean) => (y ? -Math.log(clamp(p)) : -Math.log(1 - clamp(p)));

/** A fixed seed: the same data gets the same answer, so a change in the numbers means the data changed. */
function seeded(): () => number {
  let s = 42;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

/**
 * Conversion rate with recent clicks' missing sales treated as "not yet", not "no". The penalty is chosen by
 * walk-forward search: fit on older clicks, score on newer settled ones, never the reverse.
 */
export function evaluateDelayedCvr(examples: readonly DelayedExample[]): Record<string, number> | null {
  if (examples.length < MIN_CLICKS) return null;
  const folds = walkForwardFolds(examples.length, 3);
  const trials = searchTpe(
    { l2: { min: 1e-6, max: 1e-1, log: true } },
    10,
    ({ l2 }) => {
      let total = 0;
      let n = 0;
      for (const { train, test } of folds) {
        const model = fitDelayedFeedback(examples.slice(...train), 2, {
          epochs: 8,
          ...(l2 === undefined ? {} : { l2 }),
        });
        for (const e of examples.slice(...test))
          if (e.delay !== null || e.elapsed >= SETTLED_DAYS) {
            total += logLoss(predictConversion(model, e.x), e.delay !== null);
            n += 1;
          }
      }
      return n ? total / n : Number.POSITIVE_INFINITY;
    },
    seeded(),
  );
  const best = trials.reduce((a, b) => (b.loss < a.loss ? b : a));
  const l2 = best.config.l2 ?? 1e-4;
  const model = fitDelayedFeedback(examples, 2, { l2 });
  const mean = examples.reduce((a, e) => a + predictConversion(model, e.x), 0) / examples.length;
  return {
    clicks: examples.length,
    naiveRate: examples.filter(e => e.delay !== null).length / examples.length,
    correctedRate: mean,
    l2,
    heldOutLogLoss: best.loss,
  };
}

/** What rank alone does to opening a result: a known click model, no hidden person. */
export function evaluatePositionBias(logs: readonly ClickLog[]): { rows: number; examination: number[] } | null {
  if (logs.length < MIN_SEARCH_ROWS) return null;
  const { examination } = fitPositionBias(logs, 10);
  return { rows: logs.length, examination: [...examination] };
}

/** What routing would have earned without exploring, from the choices it logged. */
export function evaluateRoutingPolicy(log: readonly LoggedDecision[]): Record<string, number> | null {
  if (log.length < MIN_DECISIONS) return null;
  return {
    decisions: log.length,
    logged: log.reduce((a, d) => a + d.reward, 0) / log.length,
    noExplorationIps: ipsValue(log, 10),
    noExplorationDoublyRobust: doublyRobustValue(log, 10),
  };
}

/** Whether an experiment helps some people more than others: Qini above 0 says the model can tell who. */
export function evaluateUplift(rows: readonly UpliftRow[]): Record<string, number> | null {
  const treated = rows.filter(r => r.treated).length;
  if (treated < MIN_PER_ARM || rows.length - treated < MIN_PER_ARM) return null;
  // Every other unit scores what the rest fit, so the Qini isn't measured on the training data.
  const fit = rows.filter((_, i) => i % 2 === 0);
  const held = rows.filter((_, i) => i % 2 === 1);
  const model = fitXLearner(fit);
  return {
    units: rows.length,
    ...qini(held.map(r => ({ score: effect(model, r.x), treated: r.treated, y: r.y }))),
  };
}

/**
 * What share of recent questions shows each kind of commercial intent, read from their public words only
 * (commercial-intent.ts). Two matched signals count: one can be a passing word ("I had to buy a ticket").
 */
export function evaluateCommercialIntent(
  questions: ReadonlyArray<{ title: string; body: string; field: string }>,
): Record<string, number> | null {
  if (questions.length < MIN_QUESTIONS) return null;
  const counts = new Map<string, number>();
  for (const q of questions) {
    const { dimensions } = classifyCommercialIntent({ title: q.title, supportingEvidence: [q.body], field: q.field });
    for (const d of INTENT_DIMENSIONS)
      if (dimensions[d].matchedSignals.length >= 2) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  const share = (d: string) => Math.round(((counts.get(d) ?? 0) / questions.length) * 1000) / 1000;
  return { questions: questions.length, ...Object.fromEntries(INTENT_DIMENSIONS.map(d => [d, share(d)])) };
}

/**
 * How the number of ads sold in a field each day moves with that day's clearing price, as support for setting reserve
 * prices. Observational: prices rise with demand, so it's labelled a slope, not a cause, and fields without enough
 * days or price spread are left out (estimateElasticity).
 */
export function evaluatePriceElasticity(
  days: ReadonlyArray<{ field: string; price: number; quantity: number }>,
): Record<string, number> | null {
  const byField = new Map<string, Array<{ price: number; quantity: number }>>();
  for (const d of days) byField.set(d.field, [...(byField.get(d.field) ?? []), d]);
  const out: Record<string, number> = {};
  for (const [field, points] of byField) {
    const e = estimateElasticity(points);
    if (!e) continue;
    out[`${field}.slope`] = e.elasticity;
    out[`${field}.low`] = e.low;
    out[`${field}.high`] = e.high;
    out[`${field}.days`] = e.observations;
  }
  return Object.keys(out).length ? out : null;
}

async function load(q: Queryable, now: number) {
  const clicks = (
    await q.query<{ search: boolean; clicked_at: Date; converted_at: Date | null }>(
      `SELECT i.placement = 'search' AS search, i.clicked_at, min(c.converted_at) AS converted_at
       FROM app.ad_impressions i LEFT JOIN app.ad_conversions c ON c.impression_id = i.id
       WHERE i.clicked_at > now() - interval '90 days'
       GROUP BY i.id ORDER BY i.clicked_at DESC LIMIT $1`,
      [MAX_ROWS],
    )
  ).rows.reverse();
  const opens = (
    await q.query<{ item: string; rank: number; clicked: boolean }>(
      `SELECT r.question_id::text AS item, r.position::int AS rank, o.opened_at IS NOT NULL AS clicked
       FROM app.search_results r JOIN app.searches s ON s.id = r.search_id
       LEFT JOIN app.search_opens o ON o.search_id = r.search_id AND o.position = r.position
       WHERE r.position <= 10 ORDER BY r.search_id DESC, r.position LIMIT $1`,
      [MAX_ROWS * 4],
    )
  ).rows;
  const decisions = (
    await q.query<{ reason: string; propensity: number; predicted: number; answered: boolean }>(
      `SELECT f.explore_reason AS reason, f.propensity, f.predicted,
              EXISTS (SELECT 1 FROM app.answers a WHERE a.question_id = f.question_id AND a.answerer_id = f.profile_id
                        AND a.created_at <= r.routed_at + interval '7 days') AS answered
       FROM app.route_factors f JOIN app.routes r ON r.question_id = f.question_id AND r.profile_id = f.profile_id
       WHERE f.propensity IS NOT NULL AND r.routed_at < now() - interval '7 days'
       ORDER BY r.routed_at DESC LIMIT $1`,
      [MAX_ROWS],
    )
  ).rows;
  const units = (
    await q.query<{ exp: string; arm: string; x: number; y: number }>(
      // Per experiment, or the oldest would use up the whole allowance.
      `SELECT exp, arm, x, y FROM (
         SELECT m.exp_id::text AS exp, m.arm, m.pre_experiment_covariate_x AS x, m.post_metric_y AS y,
                row_number() OVER (PARTITION BY m.exp_id ORDER BY m.unit_id) AS nth
         FROM app.exp_unit_metrics m JOIN app.exp_definitions d ON d.exp_id = m.exp_id
         WHERE d.status = 'running'
       ) u WHERE nth <= $1`,
      [MAX_ROWS],
    )
  ).rows;
  const questions = (
    await q.query<{ title: string; body: string; field: string }>(
      // Public words only, and only what anyone can see.
      `SELECT title, body, field FROM app.questions
       WHERE created_at > now() - interval '90 days' AND NOT app.is_question_hidden(id)
       ORDER BY created_at DESC LIMIT $1`,
      [MAX_ROWS],
    )
  ).rows;
  const prices = (
    await q.query<{ field: string; price: number; quantity: number }>(
      `SELECT field, avg(price_micros)::float8 / 1e6 AS price, count(*)::int AS quantity
       FROM app.ad_impressions WHERE field IS NOT NULL AND shown_at > now() - interval '90 days'
       GROUP BY field, date_trunc('day', shown_at)`,
    )
  ).rows;
  return {
    questions,
    prices,
    delayed: clicks.map((c): DelayedExample => ({
      x: Float64Array.of(1, c.search ? 1 : 0),
      delay: c.converted_at ? Math.max(0, (c.converted_at.getTime() - c.clicked_at.getTime()) / DAY_MS) : null,
      elapsed: (now - c.clicked_at.getTime()) / DAY_MS,
    })),
    opens,
    decisions: decisions.map((d): LoggedDecision => ({
      reward: d.answered ? 1 : 0,
      propensity: d.propensity,
      examination: 1,
      target: d.reason === 'explored' ? 0 : 1,
      predicted: d.predicted,
      targetValue: d.predicted,
    })),
    units,
  };
}

/** Runs at most once a day however often it's called. Returns how many evaluations it recorded. */
export async function runModelEvaluations(db: Pick<Database, 'asSystem'>, now: number): Promise<number> {
  const data = await db.asSystem(async q => {
    const { rows } = await q.query<{ fresh: boolean }>(
      `SELECT max(evaluated_at) > now() - interval '20 hours' AS fresh FROM app.model_evaluations`,
    );
    return rows[0]?.fresh ? null : load(q, now);
  });
  if (!data) return 0;
  const byExperiment = new Map<string, UpliftRow[]>();
  for (const u of data.units) {
    const list = byExperiment.get(u.exp) ?? [];
    list.push({ x: [u.x], treated: u.arm === 'treatment', y: u.y });
    byExperiment.set(u.exp, list);
  }
  const results: Array<[string, object | null]> = [
    ['ad-cvr-delayed', evaluateDelayedCvr(data.delayed)],
    ['search-position-bias', evaluatePositionBias(data.opens)],
    ['routing-policy-value', evaluateRoutingPolicy(data.decisions)],
    ['commercial-intent', evaluateCommercialIntent(data.questions)],
    ['ad-price-elasticity', evaluatePriceElasticity(data.prices)],
    ...[...byExperiment].map(([id, rows]): [string, object | null] => [`uplift:${id}`, evaluateUplift(rows)]),
  ];
  const ready = results.filter((r): r is [string, object] => r[1] !== null);
  if (!ready.length) return 0;
  await db.asSystem(async q => {
    for (const [name, metrics] of ready)
      await q.query(
        `INSERT INTO app.model_evaluations (name, metrics) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET metrics = excluded.metrics, evaluated_at = now()`,
        [name, metrics],
      );
  });
  return ready.length;
}
