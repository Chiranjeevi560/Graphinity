// Demand forecasts with honest intervals (master charter §8). Holt-Winters additive
// with damped trend (Gardner & McKenzie 1985), weekly season, tuned by grid on a
// time-ordered validation tail. Split conformal (Vovk; Lei et al. 2018) turns held-out
// errors into an interval with its promised coverage whatever the errors' shape;
// no normality assumed. Compared with seasonal-naive in benchmark-platform.mjs.
import { at } from '../ml/num.ts';

export interface HoltWinters {
  level: number;
  trend: number;
  season: Float64Array;
  phi: number;
  /** Where the next point falls in the season. */
  next: number;
}

export function fitHoltWinters(y: readonly number[], m = 7, alpha = 0.3, beta = 0.05, gamma = 0.2, phi = 0.9) {
  const n = y.length;
  const season = new Float64Array(m);
  let level = 0;
  let trend = 0;
  if (n >= 2 * m) {
    let first = 0;
    let second = 0;
    for (let i = 0; i < m; i++) {
      first += at(y, i);
      second += at(y, i + m);
    }
    level = first / m;
    trend = (second - first) / (m * m);
    for (let i = 0; i < m; i++) season[i] = at(y, i) - level;
  } else {
    level = n ? y.reduce((a, b) => a + b, 0) / n : 0;
  }
  const errors: number[] = [];
  for (let t = n >= 2 * m ? m : 0; t < n; t++) {
    const s = at(season, t % m);
    const predicted = level + phi * trend + s;
    const v = at(y, t);
    errors.push(v - predicted);
    const previous = level;
    level = alpha * (v - s) + (1 - alpha) * (previous + phi * trend);
    trend = beta * (level - previous) + (1 - beta) * phi * trend;
    season[t % m] = gamma * (v - level) + (1 - gamma) * s;
  }
  const model: HoltWinters = { level, trend, season, phi, next: n % m };
  return { model, errors };
}

/** The forecast h steps ahead (1-based). Never below zero: this counts demand. */
export function forecastAt(m: HoltWinters, h: number): number {
  let damp = 0;
  let f = 1;
  for (let i = 1; i <= h; i++) {
    f *= m.phi;
    damp += f;
  }
  const s = at(m.season, (m.next + h - 1) % m.season.length);
  return Math.max(0, m.level + damp * m.trend + s);
}

/** The finite-sample conformal quantile: ⌈(n+1)(1−α)⌉-th smallest absolute error. */
export function conformalQuantile(errors: readonly number[], alpha = 0.1): number {
  const abs = errors.map(Math.abs).sort((a, b) => a - b);
  if (abs.length === 0) return Infinity;
  const k = Math.ceil((abs.length + 1) * (1 - alpha));
  return k > abs.length ? Infinity : (abs[k - 1] ?? Infinity);
}

export interface ForecastPoint {
  horizon: number;
  value: number;
  low: number;
  high: number;
}

/** Fits on all but the calibration tail, measures errors there, refits, and forecasts. */
export function forecastWithIntervals(y: readonly number[], horizon: number, m = 7, alpha = 0.1): ForecastPoint[] {
  const calibrate = Math.min(Math.floor(y.length / 3), 60);
  const errors: number[] = [];
  const train = y.slice(0, y.length - calibrate);
  const { model } = fitHoltWinters(train, m);
  // Errors at a realistic lead: rolling one step would understate how far ahead we forecast.
  for (let i = 0; i < calibrate; i++) errors.push(at(y, train.length + i) - forecastAt(model, i + 1));
  const q = conformalQuantile(errors, alpha);
  const full = fitHoltWinters(y, m).model;
  return Array.from({ length: horizon }, (_, i) => {
    const value = forecastAt(full, i + 1);
    return { horizon: i + 1, value, low: Math.max(0, value - q), high: value + q };
  });
}

export const seasonalNaive = (y: readonly number[], h: number, m = 7) => at(y, y.length - m + ((h - 1) % m));
