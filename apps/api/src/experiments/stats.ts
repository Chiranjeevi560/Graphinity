// The experiment statistics (master charter §7):
// - SRM: if the split isn't what was configured, telemetry is broken and any effect
//   is meaningless, so it's checked first (Fabijan et al. 2019), halting at p < 0.001.
// - CUPED (Deng et al., WSDM 2013): subtracts what each person's own pre-experiment
//   behaviour predicts. Unbiased, and variance falls by (1 − ρ²).
// - mSPRT (Johari et al. 2017): an always-valid p-value, so looking every day doesn't
//   inflate false positives the way a repeated t-test does.
import { at } from '../ml/num.ts';

/** Regularized upper incomplete gamma Q(a, x) (Numerical Recipes §6.2). */
function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  const lg = logGamma(a);
  if (x < a + 1) {
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 500; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-14) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - lg);
  }
  let b = x + 1 - a;
  let c = 1e300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - lg) * h;
}

function logGamma(z: number): number {
  const g = [
    76.1800917294715, -86.5053203294168, 24.0140982408309, -1.231739572450155, 0.00120865097386618, -5.395239384953e-6,
  ];
  let y = z;
  const t = z + 5.5 - (z + 0.5) * Math.log(z + 5.5);
  let s = 1.00000000019002;
  for (const c of g) s += c / ++y;
  return -t + Math.log((2.506628274631 * s) / z);
}

export const chiSquareP = (statistic: number, df: number) => gammaQ(df / 2, statistic / 2);

export const SRM_ALPHA = 0.001;

/** Pearson's goodness of fit of the arms' counts to their configured shares. */
export function sampleRatioMismatch(
  counts: readonly number[],
  shares: readonly number[],
): { statistic: number; p: number; mismatch: boolean } {
  const total = counts.reduce((a, b) => a + b, 0);
  let statistic = 0;
  counts.forEach((o, i) => {
    const e = total * at(shares, i);
    if (e > 0) statistic += (o - e) ** 2 / e;
  });
  const p = total === 0 ? 1 : chiSquareP(statistic, Math.max(1, counts.length - 1));
  return { statistic, p, mismatch: p < SRM_ALPHA };
}

const mean = (x: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += at(x, i);
  return x.length ? s / x.length : 0;
};
export function variance(x: ArrayLike<number>): number {
  const m = mean(x);
  let s = 0;
  for (let i = 0; i < x.length; i++) s += (at(x, i) - m) ** 2;
  return x.length > 1 ? s / (x.length - 1) : 0;
}

/** θ = Cov(Y, X) / Var(X), pooled over the arms. Zero when X doesn't vary. */
export function cupedTheta(y: ArrayLike<number>, x: ArrayLike<number>): number {
  const mx = mean(x);
  const my = mean(y);
  let cov = 0;
  let vx = 0;
  for (let i = 0; i < y.length; i++) {
    const dx = at(x, i) - mx;
    cov += dx * (at(y, i) - my);
    vx += dx * dx;
  }
  return vx > 0 ? cov / vx : 0;
}

export function cupedAdjust(y: ArrayLike<number>, x: ArrayLike<number>, theta: number, xMean: number): Float64Array {
  const out = new Float64Array(y.length);
  for (let i = 0; i < y.length; i++) out[i] = at(y, i) - theta * (at(x, i) - xMean);
  return out;
}

/**
 * The mixture likelihood ratio for a difference of means with known variance per pair, mixing
 * over N(0, τ²): Λ_n = √(σ²/(σ²+nτ²)) exp(n²τ² d² / (2σ²(σ²+nτ²))), σ² the variance of one
 * paired difference. The always-valid p is the running minimum of 1/Λ.
 */
export function msprtLikelihood(n: number, meanDifference: number, sigma2: number, tau2: number): number {
  if (n <= 0 || sigma2 <= 0) return 1;
  const v = sigma2 + n * tau2;
  return Math.sqrt(sigma2 / v) * Math.exp((n * n * tau2 * meanDifference ** 2) / (2 * sigma2 * v));
}

export const nextAlwaysValidP = (previous: number, lambda: number) => Math.min(previous, lambda > 0 ? 1 / lambda : 1);

export interface ArmData {
  y: ArrayLike<number>;
  x: ArrayLike<number>;
}

export interface Evaluation {
  srm: ReturnType<typeof sampleRatioMismatch>;
  /** Null once SRM fires: an effect from broken data must not be read. */
  effect: null | {
    lift: number;
    low: number;
    high: number;
    fixedHorizonP: number;
    alwaysValidP: number;
    varianceReduction: number;
  };
}

const normalP = (z: number) => {
  // Two-sided, from the chi-square with one degree of freedom.
  return chiSquareP(z * z, 1);
};

/** The whole read of a two-arm experiment. `previousP` is the stored running minimum. */
export function evaluate(
  control: ArmData,
  treatment: ArmData,
  shares: readonly [number, number],
  previousP = 1,
  tau2?: number,
): Evaluation {
  const srm = sampleRatioMismatch([control.y.length, treatment.y.length], shares);
  if (srm.mismatch) return { srm, effect: null };
  const allY = Float64Array.from([...Array.from(control.y), ...Array.from(treatment.y)]);
  const allX = Float64Array.from([...Array.from(control.x), ...Array.from(treatment.x)]);
  const theta = cupedTheta(allY, allX);
  const xm = mean(allX);
  const c = cupedAdjust(control.y, control.x, theta, xm);
  const t = cupedAdjust(treatment.y, treatment.x, theta, xm);
  const lift = mean(t) - mean(c);
  const nc = c.length;
  const nt = t.length;
  const se = Math.sqrt((nc ? variance(c) / nc : 0) + (nt ? variance(t) / nt : 0));
  const z = se > 0 ? lift / se : 0;
  const rawVar = variance(allY);
  const n = 2 / (1 / Math.max(1, nc) + 1 / Math.max(1, nt));
  const sigma2 = se * se * n;
  const lambda = msprtLikelihood(n, lift, sigma2, tau2 ?? Math.max(sigma2 * 0.01, 1e-12));
  return {
    srm,
    effect: {
      lift,
      low: lift - 1.96 * se,
      high: lift + 1.96 * se,
      fixedHorizonP: normalP(z),
      alwaysValidP: nextAlwaysValidP(previousP, lambda),
      varianceReduction: rawVar > 0 ? 1 - variance(Float64Array.from([...c, ...t])) / rawVar : 0,
    },
  };
}
