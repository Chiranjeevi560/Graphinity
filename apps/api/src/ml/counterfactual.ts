// Judging a ranking from logs of another (master charter §5.2). Slot one gets
// clicked whatever it holds, so raw click-through confounds position with quality.
// Position-based model: click = examined(rank) × relevant(item), fitted by EM
// (Chuklin et al. 2015). Clipped Doubly Robust (Dudík et al. 2011): a model's guess,
// corrected by importance-weighted residuals; unbiased if either the propensities or
// the model is right, with far less variance than plain IPS.
import { at } from './num.ts';

export interface ClickLog {
  item: string;
  /** 1-based. */
  rank: number;
  clicked: boolean;
}

export interface PositionBias {
  /** γ[k]: chance of examining rank k+1, normalized so γ[0] = 1. */
  examination: Float64Array;
  relevance: Map<string, number>;
}

export function fitPositionBias(logs: readonly ClickLog[], ranks: number, iterations = 30): PositionBias {
  const gamma = new Float64Array(ranks).fill(0.5);
  const rel = new Map<string, number>();
  for (const l of logs) rel.set(l.item, 0.5);
  for (let it = 0; it < iterations; it++) {
    const gs = new Float64Array(ranks);
    const gn = new Float64Array(ranks);
    const rs = new Map<string, number>();
    const rn = new Map<string, number>();
    for (const l of logs) {
      const k = l.rank - 1;
      if (k < 0 || k >= ranks) continue;
      const g = gamma[k] ?? 0.5;
      const r = rel.get(l.item) ?? 0.5;
      // With a click both happened; without one, posteriors from the model.
      const pe = l.clicked ? 1 : (g * (1 - r)) / Math.max(1e-12, 1 - g * r);
      const pr = l.clicked ? 1 : (r * (1 - g)) / Math.max(1e-12, 1 - g * r);
      gs[k] = at(gs, k) + pe;
      gn[k] = at(gn, k) + 1;
      rs.set(l.item, (rs.get(l.item) ?? 0) + pr);
      rn.set(l.item, (rn.get(l.item) ?? 0) + 1);
    }
    for (let k = 0; k < ranks; k++) if (at(gn, k) > 0) gamma[k] = at(gs, k) / (gn[k] ?? 1);
    for (const [item, s] of rs) rel.set(item, s / (rn.get(item) ?? 1));
  }
  // Only the product is identified: fix the top rank at 1 and scale relevance to match.
  const top = gamma[0] ?? 1;
  if (top > 0) {
    for (let k = 0; k < ranks; k++) gamma[k] = at(gamma, k) / top;
    for (const [item, r] of rel) rel.set(item, Math.min(1, r * top));
  }
  return { examination: gamma, relevance: rel };
}

export interface LoggedDecision {
  reward: number;
  /** Chance the logging policy showed this action here. */
  propensity: number;
  /** Examination chance of the rank shown at; 1 outside rankings. */
  examination: number;
  /** Chance the evaluated policy shows the logged action. */
  target: number;
  /** The reward model's guess for the logged action. */
  predicted: number;
  /** The reward model's expected value under the evaluated policy. */
  targetValue: number;
}

export function ipsValue(log: readonly LoggedDecision[], clip = Infinity): number {
  if (log.length === 0) return 0;
  let s = 0;
  for (const d of log) s += Math.min(clip, d.target / Math.max(1e-9, d.propensity * d.examination)) * d.reward;
  return s / log.length;
}

export function doublyRobustValue(log: readonly LoggedDecision[], clip = 10): number {
  if (log.length === 0) return 0;
  let s = 0;
  for (const d of log) {
    const w = Math.min(clip, d.target / Math.max(1e-9, d.propensity * d.examination));
    s += d.targetValue + w * (d.reward - d.predicted);
  }
  return s / log.length;
}
