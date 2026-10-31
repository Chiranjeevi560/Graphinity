// Probability calibration (master charter §3.5): a raw model score isn't a
// probability, and the auction multiplies it by money. Pool-Adjacent-Violators
// (Zadrozny & Elkan 2002) gives the best monotone fit in squared error, in
// O(n log n) for the sort and O(n) for the pools. Compared with Platt scaling in
// scripts/benchmark-platform.mjs: Platt assumes a sigmoid shape, isotonic doesn't.
import { at } from './num.ts';

export interface Calibration {
  /** Upper edge of each score bin, ascending. */
  x: Float64Array;
  /** The calibrated probability in each bin, never falling. */
  y: Float64Array;
}

export const MAX_BINS = 64;

/** Undoes negative downsampling: `rate` is the share of negatives kept for training. */
export function correctDownsampling(p: number, rate: number): number {
  return p / (p + (1 - p) / rate);
}

/** Fits on (score, outcome 0..1) pairs, merging to at most `maxBins` by example count. */
export function fitIsotonic(scores: ArrayLike<number>, outcomes: ArrayLike<number>, maxBins = MAX_BINS): Calibration {
  const n = scores.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => at(scores, a) - at(scores, b));
  const sum: number[] = [];
  const weight: number[] = [];
  const edge: number[] = [];
  for (const i of order) {
    let s = at(outcomes, i);
    let w = 1;
    // A later pool with a lower mean breaks monotonicity: merge it backward.
    while (sum.length > 0 && (sum.at(-1) ?? 0) * w >= s * (weight.at(-1) ?? 1)) {
      s += sum.pop() ?? 0;
      w += weight.pop() ?? 0;
      edge.pop();
    }
    sum.push(s);
    weight.push(w);
    edge.push(at(scores, i));
  }
  // Fewer pools than the cache-friendly table allows: merge neighbours, keeping example-weighted means.
  const per = n / maxBins;
  const x: number[] = [];
  const y: number[] = [];
  let s = 0;
  let w = 0;
  sum.forEach((pool, i) => {
    s += pool;
    w += at(weight, i);
    if (w >= per || i === sum.length - 1 || sum.length <= maxBins) {
      x.push(at(edge, i));
      y.push(s / w);
      s = 0;
      w = 0;
    }
  });
  return { x: Float64Array.from(x), y: Float64Array.from(y) };
}

/** The calibrated probability of a score: O(log bins). An empty table returns the score. */
export function calibrate(c: Calibration, score: number): number {
  let lo = 0;
  let hi = c.x.length - 1;
  if (hi < 0) return score;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (at(c.x, mid) < score) lo = mid + 1;
    else hi = mid;
  }
  return c.y[lo] ?? score;
}

/** Expected calibration error over equal-count bins. */
export function expectedCalibrationError(p: ArrayLike<number>, y: ArrayLike<number>, bins = 15): number {
  const n = p.length;
  if (n === 0) return 0;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => at(p, a) - at(p, b));
  let total = 0;
  for (let b = 0; b < bins; b++) {
    const from = Math.floor((b * n) / bins);
    const to = Math.floor(((b + 1) * n) / bins);
    if (to <= from) continue;
    let sp = 0;
    let sy = 0;
    for (let k = from; k < to; k++) {
      const i = at(order, k);
      sp += at(p, i);
      sy += at(y, i);
    }
    total += Math.abs(sp - sy);
  }
  return total / n;
}

export function serializeCalibration(c: Calibration): { x: number[]; y: number[] } {
  return { x: [...c.x], y: [...c.y] };
}

export function deserializeCalibration(v: { x: readonly number[]; y: readonly number[] }): Calibration {
  return { x: Float64Array.from(v.x), y: Float64Array.from(v.y) };
}
