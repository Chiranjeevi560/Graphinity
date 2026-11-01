// Double machine learning (Chernozhukov et al. 2018): the average effect of a treatment when who got it depends on the
// same things as the outcome. Predict outcome and treatment from the covariates on one fold, then regress what's left
// over on the other: what the covariates explain can't be mistaken for the treatment. Complements the X-learner
// (uplift.ts), which estimates per-person effects; this gives one number with a confidence interval.
import { seededRandom } from './linalg.ts';
import { at } from './num.ts';
import { fitRidge, predictRidge } from './ridge.ts';

export interface EffectRow {
  x: readonly number[];
  /** 1 or 0, or a dose. */
  treatment: number;
  y: number;
}

export interface Effect {
  effect: number;
  standardError: number;
  low: number;
  high: number;
  rows: number;
}

/** Cross-fitted partialling-out with ridge nuisances. Null when treatment left nothing to learn from. */
export function doubleMl(
  rows: readonly EffectRow[],
  options: { folds?: number; l2?: number; seed?: number } = {},
): Effect | null {
  const { folds = 5, l2 = 1, seed = 1 } = options;
  if (rows.length < folds * 2) return null;
  const random = seededRandom(seed);
  const fold = rows.map(() => Math.floor(random() * folds));
  const treatmentLeft = new Float64Array(rows.length);
  const outcomeLeft = new Float64Array(rows.length);
  for (let f = 0; f < folds; f++) {
    const train = rows.filter((_, i) => fold[i] !== f);
    const outcome = fitRidge(
      train.map(r => ({ x: r.x, y: r.y })),
      l2,
    );
    const treatment = fitRidge(
      train.map(r => ({ x: r.x, y: r.treatment })),
      l2,
    );
    rows.forEach((r, i) => {
      if (fold[i] !== f) return;
      outcomeLeft[i] = r.y - predictRidge(outcome, r.x);
      treatmentLeft[i] = r.treatment - predictRidge(treatment, r.x);
    });
  }
  let top = 0;
  let bottom = 0;
  for (let i = 0; i < rows.length; i++) {
    top += at(treatmentLeft, i) * at(outcomeLeft, i);
    bottom += at(treatmentLeft, i) ** 2;
  }
  if (bottom < 1e-9) return null;
  const effect = top / bottom;
  let meat = 0;
  for (let i = 0; i < rows.length; i++) {
    const t = at(treatmentLeft, i);
    meat += (t * (at(outcomeLeft, i) - effect * t)) ** 2;
  }
  // Heteroskedasticity-robust: nothing here promises every person's noise is the same.
  const standardError = Math.sqrt(meat) / bottom;
  return {
    effect,
    standardError,
    low: effect - 1.96 * standardError,
    high: effect + 1.96 * standardError,
    rows: rows.length,
  };
}
