// Delayed conversions (Chapelle, KDD 2014). A recent click with no sale yet isn't
// a "no": the sale may still come. Treating it as one underestimates conversion
// rates, worst for products people think over. The model learns jointly
// p(convert | x) = σ(wc·x) and an exponential delay with rate λ(x) = exp(wd·x):
//   converted after d:      log p + log λ − λd
//   not yet, t since click: log(1 − p + p e^(−λt))
// by stochastic gradient on the likelihood. O(features) per event, no 30-day wait.
import { at } from './num.ts';

export interface DelayedExample {
  x: Float64Array;
  /** Days from click to the sale, when there has been one. */
  delay: number | null;
  /** Days since the click, for one with no sale yet. */
  elapsed: number;
}

export interface DelayedModel {
  wc: Float64Array;
  wd: Float64Array;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const dot = (w: Float64Array, x: Float64Array) => {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += at(w, i) * at(x, i);
  return s;
};

export function fitDelayedFeedback(
  data: readonly DelayedExample[],
  dims: number,
  { epochs = 30, rate = 0.1, l2 = 1e-4 }: { epochs?: number; rate?: number; l2?: number } = {},
): DelayedModel {
  const wc = new Float64Array(dims);
  const wd = new Float64Array(dims);
  for (let e = 0; e < epochs; e++) {
    const step = rate / (1 + e * 0.1);
    for (const ex of data) {
      const zc = dot(wc, ex.x);
      const p = sigmoid(zc);
      const lambda = Math.exp(Math.max(-10, Math.min(10, dot(wd, ex.x))));
      let gc: number;
      let gd: number;
      if (ex.delay !== null) {
        gc = 1 - p;
        gd = 1 - lambda * ex.delay;
      } else {
        const survive = Math.exp(-lambda * ex.elapsed);
        const denominator = Math.max(1e-12, 1 - p + p * survive);
        gc = (p * (1 - p) * (survive - 1)) / denominator;
        gd = (-p * survive * lambda * ex.elapsed) / denominator;
      }
      for (let i = 0; i < dims; i++) {
        const xi = at(ex.x, i);
        wc[i] = at(wc, i) + step * (gc * xi - l2 * at(wc, i));
        wd[i] = at(wd, i) + step * (gd * xi - l2 * at(wd, i));
      }
    }
  }
  return { wc, wd };
}

export const predictConversion = (m: DelayedModel, x: Float64Array) => sigmoid(dot(m.wc, x));
