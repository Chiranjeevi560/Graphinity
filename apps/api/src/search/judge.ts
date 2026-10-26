// Online comparison of search rankings (ADR 0015 part 6): from interleaved
// searches (rankers.ts), which ranker's results people opened. Each search
// is a win for the side with more opens, or a tie (left out). Outcomes are
// averaged per person, so one heavy searcher can't decide, and the mean is
// resampled over people (99%). The verdicts:
// - a waiting candidate that clearly wins serves; one that clearly loses is
//   rejected; one undecided after MAX_DAYS is rejected too;
// - after a promotion, the version it replaced stays the challenger for
//   ROLLBACK_DAYS: if it clearly wins, it is restored (an automatic rollback).
// Logs and the registry keep counts and the interval only, nothing about anyone.
import type { Database } from '../db.ts';
import { loadComparable, settleComparison } from '../ml/registry.ts';
import { pairedDifference, type Judged } from './metrics.ts';
import { SEARCH_RANKER } from './rankers.ts';

export const MIN_DECIDED = 200;
export const MIN_PEOPLE = 30;
export const MAX_DAYS = 28;
export const ROLLBACK_DAYS = 14;
export const LEVEL = 0.99;

export interface Interleaved {
  user: string;
  /** Opens of results the control (a) and the challenger (b) contributed. */
  a: number;
  b: number;
}

export interface Verdict {
  decided: number;
  people: number;
  /** Mean per-person outcome: +1 every search won by the challenger, -1 every one by the control. */
  mean: number;
  low: number;
  high: number;
  winner: 'challenger' | 'control' | null;
}

export function judgeInterleaving(searches: readonly Interleaved[]): Verdict {
  const decided = searches.filter(s => s.a !== s.b);
  const people = new Set(decided.map(s => s.user)).size;
  if (decided.length < MIN_DECIDED || people < MIN_PEOPLE)
    return { decided: decided.length, people, mean: 0, low: 0, high: 0, winner: null };
  const outcome: Judged[] = decided.map(s => ({ user: s.user, relevance: [s.b > s.a ? 1 : -1], totalRelevant: 1 }));
  const zero: Judged[] = decided.map(s => ({ user: s.user, relevance: [0], totalRelevant: 1 }));
  const d = pairedDifference(outcome, zero, q => q.relevance[0] ?? 0, { level: LEVEL });
  const winner = d.low > 0 ? 'challenger' : d.high < 0 ? 'control' : null;
  return { decided: decided.length, people, mean: d.mean, low: d.low, high: d.high, winner };
}

export async function loadInterleaved(db: Pick<Database, 'asSystem'>, experiment: string): Promise<Interleaved[]> {
  return db.asSystem(async q => {
    const { rows } = await q.query<{ user: string; a: number; b: number }>(
      `SELECT s.user_id::text AS user,
              count(o.search_id) FILTER (WHERE r.team = 'a')::int AS a,
              count(o.search_id) FILTER (WHERE r.team = 'b')::int AS b
       FROM app.searches s
       JOIN app.search_results r ON r.search_id = s.id
       LEFT JOIN app.search_opens o ON o.search_id = r.search_id AND o.position = r.position
       WHERE s.experiment = $1
       GROUP BY s.id, s.user_id`,
      [experiment],
    );
    return rows;
  });
}

export type JudgeOutcome =
  | { action: 'none'; reason: string; verdict?: Verdict }
  | { action: 'promote' | 'reject' | 'restore'; version: number; verdict: Verdict | null; reason: string };

/** One pass of the judge. `now` in ms. */
export async function runSearchJudge(db: Pick<Database, 'asSystem'>, now = Date.now()): Promise<JudgeOutcome> {
  const v = await loadComparable(db, SEARCH_RANKER, ROLLBACK_DAYS);
  const control = v.production ? `lambdamart:v${String(v.production.version)}` : 'rrf-equal-v1';
  const challenger = v.candidate ?? v.retired;
  if (!challenger) return { action: 'none', reason: 'nothing to compare' };
  const experiment = `${control}/lambdamart:v${String(challenger.version)}`;
  const verdict = judgeInterleaving(await loadInterleaved(db, experiment));
  const evidence = {
    experiment,
    decided: verdict.decided,
    people: verdict.people,
    mean: verdict.mean,
    low: verdict.low,
    high: verdict.high,
  };
  if (challenger.status === 'candidate') {
    if (verdict.winner === 'challenger') {
      await settleComparison(db, SEARCH_RANKER, { kind: 'promote', version: challenger.version, evidence });
      return { action: 'promote', version: challenger.version, verdict, reason: 'the candidate won online' };
    }
    const tooLong = now - challenger.createdAt.getTime() > MAX_DAYS * 86_400_000;
    if (verdict.winner === 'control' || tooLong) {
      await settleComparison(db, SEARCH_RANKER, {
        kind: 'reject',
        version: challenger.version,
        evidence: { ...evidence, timedOut: verdict.winner !== 'control' },
      });
      return {
        action: 'reject',
        version: challenger.version,
        verdict,
        reason:
          verdict.winner === 'control' ? 'the candidate lost online' : `no clear winner in ${String(MAX_DAYS)} days`,
      };
    }
    return { action: 'none', reason: 'comparison continues', verdict };
  }
  // The version a promotion replaced, kept honest for ROLLBACK_DAYS.
  if (verdict.winner === 'challenger') {
    await settleComparison(db, SEARCH_RANKER, { kind: 'restore', version: challenger.version, evidence });
    return {
      action: 'restore',
      version: challenger.version,
      verdict,
      reason: 'the replaced version won online: rolled back',
    };
  }
  return { action: 'none', reason: 'the serving version holds', verdict };
}
