// The quality gate for learned routing (ADR 0013). A learned model replaces Ψ
// only if, on questions it never trained on, it ranks the people who gave a
// helpful answer above those who didn't better than Ψ does, beyond noise and
// beyond a minimum gain.
//
// Judged fairly:
//   - Both sides score the same stored factors: Ψ is recomputed from them
//     (no newcomer bonus, no load), not read from what was served, which mixed
//     in the bonus and the pick order.
//   - Exploit places only, compared within one wave of one question: people
//     in different waves were chosen at different times, from what was left.
//   - Each asker counts once (their strata averaged), the bootstrap resamples
//     askers, at least 30 different askers are needed, and askers' accounts
//     must be 14 days old: a handful of accounts asking and picking for each
//     other can't add up to evidence.
//   - After a rejection, only questions asked since are judged, so testing
//     every day on the same questions can't pass by chance in the end.
import { createHash } from 'node:crypto';
import { seededRandom, valueAt } from './linalg.ts';
import { auc } from './logistic.ts';
import { psiOfVector } from '../routing-score.ts';
import type { RoutingExample } from './routing-model.ts';

export const MIN_ASKERS = 30;
/** Mean AUC gain over Ψ required, on top of a 99% interval above zero. */
export const MIN_GAIN = 0.02;
export const MIN_ASKER_AGE_DAYS = 14;
/**
 * Distinct trust values needed in training. One moderator pick makes trust
 * "vary" for a few people; a weight learned from that says little.
 */
export const MIN_TRUST_LEVELS = 5;
const BOOTSTRAP_SAMPLES = 2000;
/**
 * 99%, not 95%: in simulated histories where Ψ is the truth, a 95% interval
 * still promoted 1 run in 40 (routing is who gets notified; a wrong switch is
 * costly, a late one is not). Measured trade-off in ADR 0013.
 */
const INTERVAL = 0.99;

/** One question in five, by a hash salted for routing: a different fifth from the text model's. */
export const isRoutingHeldOut = (questionId: string): boolean =>
  valueAt(createHash('sha256').update(`routing\u0000${questionId}`).digest(), 0) % 5 === 0;

export interface GateExample extends RoutingExample {
  /** The asker's account age when they asked, in days. */
  askerAgeDays: number;
  /** When the question was asked (ms since the epoch). */
  askedAt: number;
}

export interface Stratum {
  askerId: string;
  factors: number[][];
  helped: number[];
}

/** Held-out exploit routes grouped by (question, wave), keeping those with both a helpful and an unhelpful one. */
export function strata(examples: readonly GateExample[], since: number | null): Stratum[] {
  const groups = new Map<string, { askerId: string; rows: GateExample[] }>();
  for (const e of examples) {
    if (e.askerAgeDays < MIN_ASKER_AGE_DAYS || (since !== null && e.askedAt <= since)) continue;
    const key = `${e.questionId}\u0000${String(e.wave)}`;
    const g = groups.get(key) ?? { askerId: e.askerId, rows: [] };
    g.rows.push(e);
    groups.set(key, g);
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([, g]) => ({
      askerId: g.askerId,
      factors: g.rows.map(r => r.factors),
      helped: g.rows.map(r => (r.helped ? 1 : 0)),
    }))
    .filter(s => s.helped.some(Boolean) && !s.helped.every(Boolean));
}

/** Per-stratum AUC of a scorer. */
export function stratumAucs(all: readonly Stratum[], score: (factors: readonly number[]) => number): number[] {
  return all.map(s => auc(s.factors.map(score), s.helped) ?? 0.5);
}

export const psiScore = (factors: readonly number[]): number => psiOfVector(factors);

export interface RoutingDecision {
  promote: boolean;
  reason: string;
  askers: number;
  strata: number;
  /** Mean per-asker AUC, candidate − Ψ, and its 99% interval (askers resampled). */
  difference: { mean: number; low: number; high: number } | null;
  candidateAuc: number;
  psiAuc: number;
  servingAuc: number | null;
}

/** Each asker's mean of a per-stratum value. */
function perAsker(all: readonly Stratum[], values: readonly number[]): number[] {
  const sums = new Map<string, { s: number; n: number }>();
  all.forEach((st, i) => {
    const a = sums.get(st.askerId) ?? { s: 0, n: 0 };
    a.s += valueAt(values, i);
    a.n += 1;
    sums.set(st.askerId, a);
  });
  return [...sums.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, a]) => a.s / a.n);
}

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

export function decideRouting(
  all: readonly Stratum[],
  candidate: readonly number[],
  psi: readonly number[],
  serving: readonly number[] | null,
  trained: { constant: readonly string[]; trustLevels: number },
  seed = 1,
): RoutingDecision {
  const askers = new Set(all.map(s => s.askerId)).size;
  const candidateByAsker = perAsker(all, candidate);
  const psiByAsker = perAsker(all, psi);
  const base = {
    askers,
    strata: all.length,
    candidateAuc: mean(candidateByAsker),
    psiAuc: mean(psiByAsker),
    servingAuc: serving ? mean(perAsker(all, serving)) : null,
  };
  // Trust never varied (no moderator has picked anyone yet): its weight is 0 by default, and
  // a model that ignores the defence against rings mustn't become the routing.
  if (trained.constant.includes('trust') || trained.trustLevels < MIN_TRUST_LEVELS)
    return {
      ...base,
      promote: false,
      reason: `trust took ${String(trained.trustLevels)} values in training (${String(MIN_TRUST_LEVELS)} needed), so its weight is unknown`,
      difference: null,
    };
  if (askers < MIN_ASKERS)
    return {
      ...base,
      promote: false,
      reason: `only ${String(askers)} different askers in judgeable held-out questions; ${String(MIN_ASKERS)} needed`,
      difference: null,
    };
  const diffs = candidateByAsker.map((c, i) => c - valueAt(psiByAsker, i));
  const random = seededRandom(seed);
  const means: number[] = [];
  for (let b = 0; b < BOOTSTRAP_SAMPLES; b++) {
    let s = 0;
    for (let i = 0; i < diffs.length; i++) s += valueAt(diffs, Math.floor(random() * diffs.length));
    means.push(s / diffs.length);
  }
  means.sort((x, y) => x - y);
  const difference = {
    mean: mean(diffs),
    low: valueAt(means, Math.floor(((1 - INTERVAL) / 2) * BOOTSTRAP_SAMPLES)),
    high: valueAt(means, Math.floor(((1 + INTERVAL) / 2) * BOOTSTRAP_SAMPLES) - 1),
  };
  const interval = `(99% interval ${difference.low.toFixed(3)} to ${difference.high.toFixed(3)})`;
  if (!(difference.low > 0) || difference.mean < MIN_GAIN)
    return {
      ...base,
      promote: false,
      reason: `not better than Ψ by enough: AUC gain ${difference.mean.toFixed(3)} ${interval}; ${String(MIN_GAIN)} and an interval above 0 needed`,
      difference,
    };
  if (base.servingAuc !== null && base.candidateAuc < base.servingAuc)
    return {
      ...base,
      promote: false,
      reason: `worse than the serving model (AUC ${base.candidateAuc.toFixed(3)} vs ${base.servingAuc.toFixed(3)})`,
      difference,
    };
  return {
    ...base,
    promote: true,
    reason: `ranks helpful people better than Ψ: AUC ${base.candidateAuc.toFixed(3)} vs ${base.psiAuc.toFixed(3)} ${interval}, ${String(askers)} askers`,
    difference,
  };
}
