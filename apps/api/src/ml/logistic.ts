// Logistic regression with a Gaussian prior on the weights (L2, MAP),
// fitted exactly by Newton's method (iteratively reweighted least squares):
// for a dozen features, each step is one d×d solve, and it converges in a
// handful of steps to the unique optimum. No learning rate, no epochs, the
// same weights every run. The prior keeps weights finite even when the
// data separate perfectly, and pulls them to 0 when evidence is thin. The
// intercept is not penalized.
import { valueAt } from './linalg.ts';

export interface LogisticModel {
  /** weights[0] is the intercept; weights[1 + k] multiplies feature k. */
  weights: number[];
  lambda: number;
  iterations: number;
  /** The last step was below the tolerance (not stopped by the iteration cap). */
  converged: boolean;
}

export const sigmoid = (z: number): number => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

export function predict(model: Pick<LogisticModel, 'weights'>, x: ArrayLike<number>): number {
  let z = valueAt(model.weights, 0);
  for (let k = 0; k < x.length; k++) z += valueAt(model.weights, k + 1) * valueAt(x, k);
  return sigmoid(z);
}

/** Solves A·v = b for symmetric positive definite A (d×d, row-major) by Cholesky. */
function solve(a: Float64Array, b: Float64Array, d: number): Float64Array {
  const l = new Float64Array(d * d);
  for (let i = 0; i < d; i++)
    for (let j = 0; j <= i; j++) {
      let s = valueAt(a, i * d + j);
      for (let k = 0; k < j; k++) s -= valueAt(l, i * d + k) * valueAt(l, j * d + k);
      if (i === j) {
        // The prior makes A positive definite; the floor only absorbs rounding.
        l[i * d + i] = Math.sqrt(Math.max(s, 1e-12));
      } else l[i * d + j] = s / valueAt(l, j * d + j);
    }
  const y = new Float64Array(d);
  for (let i = 0; i < d; i++) {
    let s = valueAt(b, i);
    for (let k = 0; k < i; k++) s -= valueAt(l, i * d + k) * valueAt(y, k);
    y[i] = s / valueAt(l, i * d + i);
  }
  const v = new Float64Array(d);
  for (let i = d - 1; i >= 0; i--) {
    let s = valueAt(y, i);
    for (let k = i + 1; k < d; k++) s -= valueAt(l, k * d + i) * valueAt(v, k);
    v[i] = s / valueAt(l, i * d + i);
  }
  return v;
}

/**
 * Fits P(y = 1 | x) = σ(w₀ + Σ wₖ xₖ), maximizing log-likelihood − λ/2 · Σ_{k≥1} wₖ².
 * Every row of `x` must have the same length. Cost per step O(n·d² + d³).
 */
export function fitLogistic(
  x: ReadonlyArray<ArrayLike<number>>,
  y: ArrayLike<number>,
  lambda: number,
  options: { maxIterations?: number; tolerance?: number; start?: readonly number[] } = {},
): LogisticModel {
  if (!(lambda > 0)) throw new RangeError('lambda must be positive');
  const n = x.length;
  if (y.length !== n) throw new RangeError('x and y differ in length');
  const d = (x[0]?.length ?? 0) + 1;
  // A warm start (a nearby problem's solution) only saves steps: the optimum is unique.
  const w = new Float64Array(d);
  if (options.start?.length === d) for (let k = 0; k < d; k++) w[k] = valueAt(options.start, k);
  const maxIterations = options.maxIterations ?? 50;
  const tolerance = options.tolerance ?? 1e-10;
  let iterations = 0;
  let converged = false;
  for (; iterations < maxIterations; iterations++) {
    // Gradient of the log-posterior and the (negated) Hessian, with the prior's λ on the diagonal.
    const g = new Float64Array(d);
    const h = new Float64Array(d * d);
    for (let k = 1; k < d; k++) {
      g[k] = -lambda * valueAt(w, k);
      h[k * d + k] = lambda;
    }
    for (let i = 0; i < n; i++) {
      const row = x[i] ?? [];
      if (row.length !== d - 1) throw new RangeError('every row needs the same features');
      let z = valueAt(w, 0);
      for (let k = 1; k < d; k++) z += valueAt(w, k) * valueAt(row, k - 1);
      const p = sigmoid(z);
      const r = valueAt(y, i) - p;
      const s = p * (1 - p);
      for (let a = 0; a < d; a++) {
        const xa = a === 0 ? 1 : valueAt(row, a - 1);
        g[a] = valueAt(g, a) + r * xa;
        for (let b = 0; b <= a; b++) {
          const xb = b === 0 ? 1 : valueAt(row, b - 1);
          h[a * d + b] = valueAt(h, a * d + b) + s * xa * xb;
        }
      }
    }
    for (let a = 0; a < d; a++) for (let b = a + 1; b < d; b++) h[a * d + b] = valueAt(h, b * d + a);
    // With no data at all, the intercept has no curvature; give it the prior's too.
    if (valueAt(h, 0) === 0) h[0] = lambda;
    const step = solve(h, g, d);
    // Step-halving: a full Newton step can overshoot when the data nearly separate;
    // take the largest of 1, ½, ¼, … that doesn't lower the log-posterior.
    const before = objective(x, y, w, lambda);
    let scale = 1;
    let trial = w.map((v, k) => v + valueAt(step, k));
    for (let half = 0; half < 30 && objective(x, y, trial, lambda) < before; half++) {
      scale /= 2;
      trial = w.map((v, k) => v + scale * valueAt(step, k));
    }
    let largest = 0;
    for (let k = 0; k < d; k++) {
      largest = Math.max(largest, Math.abs(valueAt(trial, k) - valueAt(w, k)));
      w[k] = valueAt(trial, k);
    }
    if (largest < tolerance) {
      iterations++;
      converged = true;
      break;
    }
  }
  return { weights: [...w], lambda, iterations, converged };
}

/**
 * The Laplace approximation's posterior covariance at a fitted model:
 * the inverse of the log-posterior's negated Hessian, Σ = (Xᵀ W X + λ I')⁻¹
 * (I' leaves the intercept unpenalized; it gets a sliver of curvature so Σ
 * exists without data). d×d row-major, d = features + 1. This is what lets
 * routing say how sure it is about a prediction (ADR 0014).
 */
export function posteriorCovariance(
  x: ReadonlyArray<ArrayLike<number>>,
  model: Pick<LogisticModel, 'weights' | 'lambda'>,
): Float64Array {
  const d = model.weights.length;
  const h = new Float64Array(d * d);
  for (let k = 1; k < d; k++) h[k * d + k] = model.lambda;
  h[0] = 1e-6;
  for (const row of x) {
    const p = predict(model, row);
    const s = p * (1 - p);
    for (let a = 0; a < d; a++) {
      const xa = a === 0 ? 1 : valueAt(row, a - 1);
      for (let b = 0; b <= a; b++) h[a * d + b] = valueAt(h, a * d + b) + s * xa * (b === 0 ? 1 : valueAt(row, b - 1));
    }
  }
  for (let a = 0; a < d; a++) for (let b = a + 1; b < d; b++) h[a * d + b] = valueAt(h, b * d + a);
  const inverse = new Float64Array(d * d);
  for (let c = 0; c < d; c++) {
    const e = new Float64Array(d);
    e[c] = 1;
    const col = solve(h, e, d);
    for (let r = 0; r < d; r++) inverse[r * d + c] = valueAt(col, r);
  }
  return inverse;
}

/** Lower-triangular L with L·Lᵀ = A (A symmetric positive definite), for sampling from N(μ, A). */
export function cholesky(a: ArrayLike<number>, d: number): Float64Array {
  const l = new Float64Array(d * d);
  for (let i = 0; i < d; i++)
    for (let j = 0; j <= i; j++) {
      let s = valueAt(a, i * d + j);
      for (let k = 0; k < j; k++) s -= valueAt(l, i * d + k) * valueAt(l, j * d + k);
      l[i * d + j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / valueAt(l, j * d + j);
    }
  return l;
}

/** The log-posterior being maximized: log-likelihood − λ/2 · Σ_{k≥1} wₖ². */
function objective(x: ReadonlyArray<ArrayLike<number>>, y: ArrayLike<number>, w: Float64Array, lambda: number): number {
  let s = 0;
  const weights = [...w];
  for (let i = 0; i < x.length; i++) {
    const p = Math.min(1 - 1e-15, Math.max(1e-15, predict({ weights }, x[i] ?? [])));
    s += valueAt(y, i) ? Math.log(p) : Math.log(1 - p);
  }
  for (let k = 1; k < w.length; k++) s -= (lambda / 2) * valueAt(w, k) ** 2;
  return s;
}

/** Mean negative log-likelihood, probabilities clipped away from 0 and 1. */
export function logLoss(p: ArrayLike<number>, y: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const q = Math.min(1 - 1e-12, Math.max(1e-12, valueAt(p, i)));
    s -= valueAt(y, i) ? Math.log(q) : Math.log(1 - q);
  }
  return p.length ? s / p.length : 0;
}

/** AUC of scores against 0/1 labels (Mann-Whitney, ties half); null without both classes. */
export function auc(scores: ArrayLike<number>, labels: ArrayLike<number>): number | null {
  const items = Array.from({ length: scores.length }, (_, i) => ({ s: valueAt(scores, i), y: valueAt(labels, i) }));
  const positives = items.filter(i => i.y).length;
  const negatives = items.length - positives;
  if (!positives || !negatives) return null;
  items.sort((a, b) => a.s - b.s);
  let rankSum = 0;
  for (let i = 0; i < items.length;) {
    let j = i;
    while (j < items.length && items[j]?.s === items[i]?.s) j++;
    const rank = (i + 1 + j) / 2;
    for (let t = i; t < j; t++) if (items[t]?.y) rankSum += rank;
    i = j;
  }
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}
