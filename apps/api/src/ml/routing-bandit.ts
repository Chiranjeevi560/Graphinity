// Exploration for routing (ADR 0014): who gets a wave's last place.
//
// Four places go to the best current choices (exploitation). The last one may
// go to someone the model is unsure about, by Thompson sampling (Thompson
// 1933; Chapelle & Li 2011): draw one plausible model from the posterior,
// pick whoever it ranks first. Unsure people win draws often; people known
// to be weak almost never do, so exploration goes where it can still teach
// something. The posterior is the routing model's Laplace approximation
// (Gaussian over its weights) plus, for each person, what the factors don't
// capture: a term with variance τ² / (1 + τ²·I), shrinking as they're asked
// (I is the information their routes carry). That is what finds new experts:
// someone never asked is uncertain whatever their factors say.
//
// Exploration happens only when it is justified and cheap enough:
//   - the drawn winner must have at least a 25% posterior chance of beating
//     the person exploitation would have put there (uncertainty justifies it);
//   - its expected chance of helping must be at least half of theirs (the
//     asker barely notices: four places are untouched, the fifth costs at most
//     half a place's expected value, and only when it might gain more);
//   - the person must be under their exploration cap (3 a week), so no one,
//     and no farm of fresh accounts, collects exploration routes.
// Otherwise the place goes to exploitation's choice, as if there were no
// exploration at all.
//
// Every decision records its propensity, the probability this procedure
// gives the place to that person, estimated by repeating it with fresh draws.
// That makes unbiased off-policy evaluation of any other policy possible.
// Randomness is seeded by the decision, so any decision can be replayed.
import { createHash } from 'node:crypto';
import { gaussian, seededRandom, valueAt } from './linalg.ts';
import { cholesky, sigmoid } from './logistic.ts';
import { routingRow, stagesAt, type RoutingModel, type Stage } from './routing-model.ts';

export const MIN_PROBABILITY_BETTER = 0.25;
export const SAFETY_RATIO = 0.5;
/** Exploration routes a person can receive in 7 days (the database holds the same number). */
export const WEEKLY_EXPLORE_CAP = 3;
const COMPARISON_DRAWS = 64;
const PROPENSITY_DRAWS = 128;

/** What a person's own settled routes say beyond their factors, per stage: Σ(y − p) and Σ p(1 − p). */
export interface PersonHistory {
  availability: { residual: number; information: number };
  quality: { residual: number; information: number };
}

export const NO_HISTORY: PersonHistory = {
  availability: { residual: 0, information: 0 },
  quality: { residual: 0, information: 0 },
};

/** A settled route of theirs, as training reads it. */
export interface PastRoute {
  factors: readonly number[];
  wave: number;
  responded: boolean;
  helped: boolean;
  judged: boolean;
}

/**
 * Their record against what the model expected of them: answered when
 * predicted not to, or helped more than predicted, and how much evidence
 * that is. Quality counts only routes they answered on judged questions,
 * as the quality model is trained.
 */
export function personHistory(model: RoutingModel, routes: readonly PastRoute[]): PersonHistory {
  const h = {
    availability: { residual: 0, information: 0 },
    quality: { residual: 0, information: 0 },
  };
  for (const r of routes) {
    const { a, q } = stagesAt(model, r.factors, r.wave);
    h.availability.residual += (r.responded ? 1 : 0) - a;
    h.availability.information += a * (1 - a);
    if (r.responded && r.judged) {
      h.quality.residual += (r.helped ? 1 : 0) - q;
      h.quality.information += q * (1 - q);
    }
  }
  return h;
}

export interface ExploreCandidate {
  id: string;
  factors: readonly number[];
  /** Their own settled record (NO_HISTORY if never asked). */
  history: PersonHistory;
  /** Exploration routes they had in the last 7 days. */
  exploredThisWeek: number;
}

export type ExploreReason = 'explored' | 'best_already' | 'not_uncertain_enough' | 'too_costly' | 'capped';

export interface ExploreDecision {
  id: string;
  explored: boolean;
  reason: ExploreReason;
  /** P(this procedure gives the place to this person). */
  propensity: number;
  /** Posterior P(the drawn winner beats exploitation's choice), when one was drawn. */
  probabilityBetter: number | null;
  /** Expected chance of helping, chosen person and exploitation's choice. */
  mean: number;
  greedyMean: number;
  /** Everyone this procedure could have given the place to, with how often (sums to 1; not stored). */
  distribution: Map<string, number>;
}

const sampler = new WeakMap<Stage, Float64Array>();
function factor(stage: Stage): Float64Array {
  let l = sampler.get(stage);
  if (!l) {
    l = cholesky(stage.covariance, stage.weights.length);
    sampler.set(stage, l);
  }
  return l;
}

/** One draw of a stage's weights from N(mean, covariance). */
function drawWeights(stage: Stage, normal: () => number): number[] {
  const d = stage.weights.length;
  const l = factor(stage);
  const z = Array.from({ length: d }, normal);
  return stage.weights.map((w, i) => {
    let s = w;
    for (let k = 0; k <= i; k++) s += valueAt(l, i * d + k) * valueAt(z, k);
    return s;
  });
}

const logit = (weights: readonly number[], x: readonly number[]) =>
  x.reduce((s, v, k) => s + valueAt(weights, k + 1) * v, valueAt(weights, 0));

/**
 * A person's own effect on a stage's logit, after their record: prior
 * N(0, τ²), their residual r and information I give (Laplace) mean
 * τ²r / (1 + τ²I) and variance τ² / (1 + τ²I). Never asked: mean 0, variance τ².
 */
export function personPosterior(
  stage: Stage,
  record: { residual: number; information: number },
): { mean: number; variance: number } {
  const tau2 = stage.personSd * stage.personSd;
  if (tau2 === 0) return { mean: 0, variance: 0 };
  const denominator = 1 + tau2 * Math.max(0, record.information);
  return { mean: (tau2 * record.residual) / denominator, variance: tau2 / denominator };
}

interface Prepared {
  x: number[][];
  /** Each person's own effect per stage: mean and standard deviation. */
  meanA: number[];
  sdA: number[];
  meanQ: number[];
  sdQ: number[];
  /** Expected chance of helping, person effects included. */
  mean: number[];
}

/** Rows, person effects and means, worked out once per decision. */
function prepare(model: RoutingModel, candidates: readonly ExploreCandidate[]): Prepared {
  const p: Prepared = { x: [], meanA: [], sdA: [], meanQ: [], sdQ: [], mean: [] };
  for (const c of candidates) {
    const row = routingRow(model, c.factors);
    const a = personPosterior(model.availability, c.history.availability);
    const q = personPosterior(model.quality, c.history.quality);
    p.x.push(row);
    p.meanA.push(a.mean);
    p.sdA.push(Math.sqrt(a.variance));
    p.meanQ.push(q.mean);
    p.sdQ.push(Math.sqrt(q.variance));
    p.mean.push(
      sigmoid(logit(model.availability.weights, row) + a.mean) * sigmoid(logit(model.quality.weights, row) + q.mean),
    );
  }
  return p;
}

/** One joint posterior draw of P(helps) for the candidates at `which` (all by default). */
function drawScores(model: RoutingModel, p: Prepared, normal: () => number, which?: readonly number[]): number[] {
  const wa = drawWeights(model.availability, normal);
  const wq = drawWeights(model.quality, normal);
  return (which ?? p.x.map((_, i) => i)).map(i => {
    const row = p.x[i] ?? [];
    return (
      sigmoid(logit(wa, row) + valueAt(p.meanA, i) + valueAt(p.sdA, i) * normal()) *
      sigmoid(logit(wq, row) + valueAt(p.meanQ, i) + valueAt(p.sdQ, i) * normal())
    );
  });
}

export function seedFor(...parts: readonly (string | number)[]): number {
  return createHash('sha256').update(parts.join('\u0000')).digest().readUInt32LE(0);
}

/**
 * Who gets the last place of a wave, given exploitation's choice for it
 * (`greedy`) and everyone else still eligible. Deterministic for a seed.
 *
 * The procedure: one Thompson draw picks a winner; the winner then passes
 * or fails the gates. The gates depend only on who won (their chance of
 * beating `greedy` is estimated once per winner, from its own seeded
 * stream), so the propensity is found by repeating just the draw.
 */
export function decideLastPlace(
  model: RoutingModel,
  greedy: ExploreCandidate,
  others: readonly ExploreCandidate[],
  seed: number,
  options: { gated?: boolean } = {},
): ExploreDecision {
  const gated = options.gated ?? true;
  const all = [greedy, ...others];
  const prepared = prepare(model, all);
  const verdicts = new Map<number, { reason: ExploreReason; probabilityBetter: number | null }>();
  const verdict = (winner: number) => {
    let v = verdicts.get(winner);
    if (v) return v;
    if (winner === 0) v = { reason: 'best_already', probabilityBetter: null };
    // Plain Thompson sampling (benchmark only): the draw decides, nothing else.
    else if (!gated) v = { reason: 'explored', probabilityBetter: null };
    else {
      const normal = gaussian(seededRandom(seedFor(seed, 'compare', winner)));
      let better = 0;
      for (let k = 0; k < COMPARISON_DRAWS; k++) {
        const pair = drawScores(model, prepared, normal, [0, winner]);
        if (valueAt(pair, 1) > valueAt(pair, 0)) better++;
      }
      const probabilityBetter = better / COMPARISON_DRAWS;
      const reason: ExploreReason =
        probabilityBetter < MIN_PROBABILITY_BETTER
          ? 'not_uncertain_enough'
          : valueAt(prepared.mean, winner) < SAFETY_RATIO * valueAt(prepared.mean, 0)
            ? 'too_costly'
            : (all[winner]?.exploredThisWeek ?? 0) >= WEEKLY_EXPLORE_CAP
              ? 'capped'
              : 'explored';
      v = { reason, probabilityBetter };
    }
    verdicts.set(winner, v);
    return v;
  };
  const outcome = (draw: readonly number[]) => {
    let winner = 0;
    draw.forEach((s, i) => {
      if (s > valueAt(draw, winner)) winner = i;
    });
    const v = verdict(winner);
    return { ...v, place: v.reason === 'explored' ? winner : 0, winner };
  };
  const first = outcome(drawScores(model, prepared, gaussian(seededRandom(seed))));
  // The propensity: how often fresh draws give the place to the same person. Every
  // outcome's frequency is kept, so the whole distribution over people can be checked.
  const counts = new Map<number, number>([[first.place, 1]]);
  for (let k = 1; k < PROPENSITY_DRAWS; k++) {
    const place = outcome(drawScores(model, prepared, gaussian(seededRandom(seedFor(seed, 'propensity', k))))).place;
    counts.set(place, (counts.get(place) ?? 0) + 1);
  }
  const same = counts.get(first.place) ?? 1;
  return {
    id: all[first.place]?.id ?? greedy.id,
    explored: first.reason === 'explored',
    reason: first.reason,
    propensity: same / PROPENSITY_DRAWS,
    probabilityBetter: first.probabilityBetter,
    mean: valueAt(prepared.mean, first.place),
    greedyMean: valueAt(prepared.mean, 0),
    distribution: new Map([...counts].map(([place, n]) => [all[place]?.id ?? greedy.id, n / PROPENSITY_DRAWS])),
  };
}

/** GLM-UCB from the same posterior (Filippi et al. 2010), compared in the benchmark: mean + α·sd per stage. */
export function ucbScore(model: RoutingModel, c: ExploreCandidate, alpha: number): number {
  const x = routingRow(model, c.factors);
  const stageUcb = (stage: Stage, record: { residual: number; information: number }) => {
    const d = stage.weights.length;
    const xt = [1, ...x];
    let v = 0;
    for (let i = 0; i < d; i++)
      for (let j = 0; j < d; j++) v += valueAt(xt, i) * valueAt(stage.covariance, i * d + j) * valueAt(xt, j);
    const person = personPosterior(stage, record);
    return sigmoid(logit(stage.weights, x) + person.mean + alpha * Math.sqrt(Math.max(0, v) + person.variance));
  };
  return stageUcb(model.availability, c.history.availability) * stageUcb(model.quality, c.history.quality);
}
