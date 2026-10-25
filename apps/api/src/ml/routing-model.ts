// The learned routing model (ADR 0013): from the factors each routing
// decision saw (app.route_factors) and what came of it, the chance that the
// person asked gives an answer that helps,
//
//   P(helps) = P(answers) × P(helps | answers)
//
// "availability" and "quality", two logistic regressions with a Gaussian
// prior (ml/logistic.ts) on standardized factors.
//   - The wave a route came in is a training-only term: waves 2 and 3 run
//     only when wave 1 went quiet, so their people are less likely to help
//     whoever they are. Scoring leaves it out (as wave 1).
//   - Trust, reputation, proximity and country can't get a negative weight.
//     They are what keeps accounts that only vouch for each other (TrustRank,
//     routing-score.ts) from being favoured; a learned weight that went
//     negative, or chased a ring's labels, would undo that.
//   - A factor that never varied in training gets weight 0: nothing was learned.
//   - The quality model learns only from questions whose asker judged
//     something (picked an answer or marked one helpful): elsewhere "didn't
//     help" means "nobody looked".
import { createHash } from 'node:crypto';
import { valueAt } from './linalg.ts';
import { fitLogistic, logLoss, predict, type LogisticModel } from './logistic.ts';
import { FACTOR_ORDER, FACTORS_VERSION } from '../routing-score.ts';

export const ROUTING_ALGORITHM = 'two-stage-bayesian-logistic';
/** Factors whose learned weight may not fall below zero. */
export const NON_NEGATIVE = ['trust', 'reputation', 'proximity', 'country'] as const;
/** Prior strengths tried, chosen by question-grouped cross-validated log-loss. */
export const LAMBDAS = [0.1, 1, 10] as const;
const FOLDS = 5;
/** Below this a factor counts as constant. */
const MIN_SD = 1e-9;

export interface RoutingExample {
  questionId: string;
  askerId: string;
  wave: number;
  factors: number[];
  responded: boolean;
  helped: boolean;
  /** The asker picked an answer or marked one helpful on this question. */
  judged: boolean;
}

export interface Stage {
  weights: number[];
  lambda: number;
  converged: boolean;
}

export interface RoutingModel {
  v: 1;
  factorsVersion: number;
  mean: number[];
  sd: number[];
  /** Factors that were constant in training (weight 0). */
  constant: string[];
  /** Distinct trust values seen in training: the gate wants several before trusting the trust weight. */
  trustLevels: number;
  availability: Stage;
  quality: Stage;
}

const factorCount = FACTOR_ORDER.length;

/** Standardized factors, then wave 2 and wave 3 indicators. */
function row(model: Pick<RoutingModel, 'mean' | 'sd'>, factors: readonly number[], wave: number): number[] {
  const out = FACTOR_ORDER.map((_, k) => {
    const sd = valueAt(model.sd, k);
    return sd > MIN_SD ? (valueAt(factors, k) - valueAt(model.mean, k)) / sd : 0;
  });
  out.push(wave === 2 ? 1 : 0, wave === 3 ? 1 : 0);
  return out;
}

/** P(helps), as served: wave terms left out. */
export function scoreRouting(model: RoutingModel, factors: readonly number[]): number {
  const x = row(model, factors, 1);
  return predict(model.availability, x) * predict(model.quality, x);
}

/**
 * Logistic fit where the listed columns must end with weight ≥ 0, and the
 * fixed columns with weight 0. Active set: pin the most negative constrained
 * weight at 0 and refit; once none is negative, release a pinned one whose
 * gradient says it wants to grow (the optimum's condition), and refit. With
 * at most 4 constrained columns there are at most 16 states to visit.
 */
export function fitConstrained(
  x: ReadonlyArray<readonly number[]>,
  y: readonly number[],
  lambda: number,
  nonNegative: readonly number[],
  fixedZero: readonly number[] = [],
): LogisticModel {
  const d = x[0]?.length ?? 0;
  const always = new Set(fixedZero);
  const pinned = new Set<number>();
  const seen = new Set<string>();
  let previous: number[] | null = null;
  for (let round = 0; ; round++) {
    const free = Array.from({ length: d }, (_, k) => k).filter(k => !always.has(k) && !pinned.has(k));
    // Start each refit from the last solution's free weights: same optimum, fewer steps.
    const last = previous;
    const fit = fitLogistic(
      x.map(r => free.map(k => valueAt(r, k))),
      y,
      lambda,
      last ? { start: [valueAt(last, 0), ...free.map(k => valueAt(last, k + 1))] } : {},
    );
    const weights = new Array<number>(d + 1).fill(0);
    weights[0] = valueAt(fit.weights, 0);
    free.forEach((k, i) => (weights[k + 1] = valueAt(fit.weights, i + 1)));
    previous = weights;
    seen.add([...pinned].sort().join(','));
    let worst = -1;
    for (const k of nonNegative)
      if (pinned.has(k) || always.has(k)) continue;
      else if (valueAt(weights, k + 1) < 0 && (worst < 0 || valueAt(weights, k + 1) < valueAt(weights, worst + 1)))
        worst = k;
    if (worst >= 0) {
      pinned.add(worst);
      continue;
    }
    // ∂/∂w_k of the log-posterior at w_k = 0 is Σ (y − p)·x_k (the prior's term is 0 there).
    let release = -1;
    let steepest = 0;
    for (const k of pinned) {
      let g = 0;
      x.forEach((r, i) => (g += (valueAt(y, i) - predict({ weights }, r)) * valueAt(r, k)));
      if (g > steepest + 1e-9) {
        steepest = g;
        release = k;
      }
    }
    const next = new Set(pinned);
    next.delete(release);
    if (release < 0 || seen.has([...next].sort().join(',')) || round > 32)
      return { weights, lambda, iterations: fit.iterations, converged: fit.converged };
    pinned.delete(release);
  }
}

const foldOf = (questionId: string) =>
  valueAt(createHash('sha256').update(`routing-fold\u0000${questionId}`).digest(), 0) % FOLDS;

/** The λ with the lowest log-loss when each fold of questions is predicted by a model fit on the others. */
function chooseLambda(
  rows: ReadonlyArray<{ x: number[]; y: number; fold: number }>,
  nonNegative: readonly number[],
  fixedZero: readonly number[],
): number {
  let best: { lambda: number; loss: number } | null = null;
  for (const lambda of LAMBDAS) {
    const p: number[] = [];
    const y: number[] = [];
    for (let f = 0; f < FOLDS; f++) {
      const train = rows.filter(r => r.fold !== f);
      const test = rows.filter(r => r.fold === f);
      if (!train.length || !test.length) continue;
      const m = fitConstrained(
        train.map(r => r.x),
        train.map(r => r.y),
        lambda,
        nonNegative,
        fixedZero,
      );
      for (const r of test) {
        p.push(predict(m, r.x));
        y.push(r.y);
      }
    }
    const loss = p.length ? logLoss(p, y) : Number.POSITIVE_INFINITY;
    if (!best || loss < best.loss) best = { lambda, loss };
  }
  return best?.lambda ?? 1;
}

/** Trains both stages on exploit routes. Deterministic for the same examples. */
export function trainRoutingModel(examples: readonly RoutingExample[]): RoutingModel {
  const n = examples.length;
  const mean = FACTOR_ORDER.map((_, k) => examples.reduce((s, e) => s + valueAt(e.factors, k), 0) / Math.max(1, n));
  const sd = FACTOR_ORDER.map((_, k) =>
    Math.sqrt(examples.reduce((s, e) => s + (valueAt(e.factors, k) - valueAt(mean, k)) ** 2, 0) / Math.max(1, n)),
  );
  const constantIdx = FACTOR_ORDER.map((_, k) => k).filter(k => valueAt(sd, k) <= MIN_SD);
  const base = { mean, sd };
  const nonNegative = NON_NEGATIVE.map(name => FACTOR_ORDER.indexOf(name));
  const stage = (subset: readonly RoutingExample[], label: (e: RoutingExample) => boolean): Stage => {
    // Each question's fold, hashed once (not once per row per λ per fold).
    const folds = new Map<string, number>();
    const rows = subset.map(e => {
      let fold = folds.get(e.questionId);
      if (fold === undefined) {
        fold = foldOf(e.questionId);
        folds.set(e.questionId, fold);
      }
      return { x: row(base, e.factors, e.wave), y: label(e) ? 1 : 0, fold };
    });
    const lambda = chooseLambda(rows, nonNegative, constantIdx);
    const fit = fitConstrained(
      rows.map(r => r.x),
      rows.map(r => r.y),
      lambda,
      nonNegative,
      constantIdx,
    );
    return { weights: fit.weights, lambda, converged: fit.converged };
  };
  return {
    v: 1,
    factorsVersion: FACTORS_VERSION,
    mean,
    sd,
    constant: constantIdx.map(k => FACTOR_ORDER[k] ?? ''),
    trustLevels: new Set(examples.map(e => valueAt(e.factors, FACTOR_ORDER.indexOf('trust')))).size,
    availability: stage(examples, e => e.responded),
    quality: stage(
      examples.filter(e => e.responded && e.judged),
      e => e.helped,
    ),
  };
}

export function serializeRoutingModel(model: RoutingModel): Buffer {
  return Buffer.from(JSON.stringify(model), 'utf8');
}

export function deserializeRoutingModel(buffer: Buffer): RoutingModel {
  // Untrusted until checked: a stored artifact from another version must not serve.
  const m = JSON.parse(buffer.toString('utf8')) as Omit<RoutingModel, 'v'> & { v: unknown };
  const width = factorCount + 3;
  const finite = (xs: unknown) => Array.isArray(xs) && xs.every(x => typeof x === 'number' && Number.isFinite(x));
  if (
    m.v !== 1 ||
    m.factorsVersion !== FACTORS_VERSION ||
    typeof m.trustLevels !== 'number' ||
    !finite(m.mean) ||
    !finite(m.sd) ||
    m.mean.length !== factorCount ||
    m.sd.length !== factorCount ||
    !finite(m.availability.weights) ||
    !finite(m.quality.weights) ||
    m.availability.weights.length !== width ||
    m.quality.weights.length !== width
  )
    throw new Error('not a Graphinity routing model for these factors');
  return { ...m, v: 1 };
}
