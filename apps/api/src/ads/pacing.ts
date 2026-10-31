// Budget pacing (master charter §3.5). The on/off rule in auction.ts sits a
// campaign out once it runs ahead, which spends in bursts. A primal-dual PID
// controller instead lowers the bid smoothly, b̃ = b / (1 + λ), where λ follows
// the error between the share of budget spent and the share of the day's traffic
// gone (Agarwal et al. 2014; Balseiro & Gur 2019). O(1) per auction; λ updates
// every 5 minutes. Compared with on/off and no pacing in benchmark-platform.mjs.
import { at } from '../ml/num.ts';

export interface PacerState {
  lambda: number;
  integral: number;
  lastError: number;
}

export interface PacerGains {
  kp: number;
  ki: number;
  kd: number;
}

export const DEFAULT_GAINS: PacerGains = { kp: 2, ki: 0.5, kd: 0.2 };
export const INITIAL_PACER: PacerState = { lambda: 0, integral: 0, lastError: 0 };
const INTEGRAL_LIMIT = 4;
const LAMBDA_LIMIT = 50;

/** The share of a day's traffic before each UTC hour's end; 24 weights in, cumulative out. */
export function trafficCurve(hourly: readonly number[]): Float64Array {
  const total = hourly.reduce((a, b) => a + b, 0);
  const out = new Float64Array(24);
  let sum = 0;
  for (let h = 0; h < 24; h++) {
    sum += total > 0 ? at(hourly, h) / total : 1 / 24;
    out[h] = sum;
  }
  return out;
}

/** Φ(t): the share of the day's traffic gone at this fraction of the day, interpolated. */
export function targetShare(curve: Float64Array, dayFraction: number): number {
  const position = Math.min(0.999999, Math.max(0, dayFraction)) * 24;
  const h = Math.floor(position);
  const before = h === 0 ? 0 : at(curve, h - 1);
  return before + (at(curve, h) - before) * (position - h);
}

/** One 5-minute step. Anti-windup holds the integral, so a stalled campaign recovers quickly. */
export function stepPacer(s: PacerState, spentShare: number, target: number, g = DEFAULT_GAINS): PacerState {
  const error = spentShare - target;
  const integral = Math.max(-INTEGRAL_LIMIT, Math.min(INTEGRAL_LIMIT, s.integral + error));
  const lambda = Math.min(
    LAMBDA_LIMIT,
    Math.max(0, s.lambda + g.kp * error + g.ki * integral + g.kd * (error - s.lastError)),
  );
  return { lambda, integral, lastError: error };
}

export const pacedBid = (bidMicros: number, lambda: number) => Math.floor(bidMicros / (1 + lambda));
