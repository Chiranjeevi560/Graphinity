// Ranking quality for search (ADR 0015): the standard measures, per query,
// and a paired bootstrap that resamples people rather than queries, so one
// person searching a lot can't decide a comparison.
//
//   NDCG@k  (Järvelin & Kekäläinen 2002): Σ (2^rel − 1)/log₂(i + 1) over the
//           top k, divided by the same for the ideal order. Graded relevance.
//   MRR     reciprocal rank of the first relevant result (0 if none).
//   Recall@k, Precision@k: relevant results in the top k, over all relevant
//           ones known / over k.
import { seededRandom, valueAt } from '../ml/linalg.ts';

/** One judged query: results in ranked order with graded relevance (0 = not relevant). */
export interface Judged {
  user: string;
  relevance: readonly number[];
  /** All relevant results known for the query (≥ those in `relevance`), for recall. */
  totalRelevant: number;
}

export function ndcgAt(relevance: readonly number[], k: number, ideal: readonly number[] = relevance): number {
  const dcg = (rels: readonly number[]) => rels.slice(0, k).reduce((s, r, i) => s + (2 ** r - 1) / Math.log2(i + 2), 0);
  const best = dcg([...ideal].sort((a, b) => b - a));
  return best > 0 ? dcg(relevance) / best : 0;
}

export function reciprocalRank(relevance: readonly number[]): number {
  const i = relevance.findIndex(r => r > 0);
  return i < 0 ? 0 : 1 / (i + 1);
}

export function recallAt(relevance: readonly number[], k: number, totalRelevant: number): number {
  return totalRelevant > 0 ? relevance.slice(0, k).filter(r => r > 0).length / totalRelevant : 0;
}

export function precisionAt(relevance: readonly number[], k: number): number {
  return k > 0 ? relevance.slice(0, k).filter(r => r > 0).length / k : 0;
}

export interface Scores {
  queries: number;
  users: number;
  ndcg10: number;
  mrr: number;
  recall10: number;
  precision10: number;
}

/** Each user's mean of a per-query value, in a stable order of users. */
function perUser(queries: readonly Judged[], value: (q: Judged) => number): Map<string, number> {
  const sums = new Map<string, { s: number; n: number }>();
  for (const q of queries) {
    const a = sums.get(q.user) ?? { s: 0, n: 0 };
    a.s += value(q);
    a.n++;
    sums.set(q.user, a);
  }
  return new Map([...sums].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([u, a]) => [u, a.s / a.n]));
}

const mean = (xs: Iterable<number>) => {
  let s = 0;
  let n = 0;
  for (const x of xs) {
    s += x;
    n++;
  }
  return n ? s / n : 0;
};

/** Scores averaged per user first, so each person counts once. */
export function score(queries: readonly Judged[]): Scores {
  return {
    queries: queries.length,
    users: new Set(queries.map(q => q.user)).size,
    ndcg10: mean(perUser(queries, q => ndcgAt(q.relevance, 10)).values()),
    mrr: mean(perUser(queries, q => reciprocalRank(q.relevance)).values()),
    recall10: mean(perUser(queries, q => recallAt(q.relevance, 10, q.totalRelevant)).values()),
    precision10: mean(perUser(queries, q => precisionAt(q.relevance, 10)).values()),
  };
}

/**
 * Paired bootstrap of a metric's difference (candidate − baseline) on the
 * same queries, resampling users. `candidate[i]` and `baseline[i]` judge the
 * same query. Returns the mean difference and its `level` interval.
 */
export function pairedDifference(
  candidate: readonly Judged[],
  baseline: readonly Judged[],
  metric: (q: Judged) => number,
  options: { samples?: number; level?: number; seed?: number } = {},
): { mean: number; low: number; high: number; users: number } {
  if (candidate.length !== baseline.length) throw new RangeError('candidate and baseline judge different queries');
  const diffs = new Map<string, { s: number; n: number }>();
  candidate.forEach((c, i) => {
    const b = baseline[i];
    if (!b || b.user !== c.user) throw new RangeError('candidate and baseline judge different queries');
    const a = diffs.get(c.user) ?? { s: 0, n: 0 };
    a.s += metric(c) - metric(b);
    a.n++;
    diffs.set(c.user, a);
  });
  const users = [...diffs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, a]) => a.s / a.n);
  const samples = options.samples ?? 2000;
  const level = options.level ?? 0.99;
  const random = seededRandom(options.seed ?? 1);
  const means: number[] = [];
  for (let b = 0; b < samples; b++) {
    let s = 0;
    for (let i = 0; i < users.length; i++) s += valueAt(users, Math.floor(random() * users.length));
    means.push(users.length ? s / users.length : 0);
  }
  means.sort((x, y) => x - y);
  return {
    mean: mean(users),
    low: valueAt(means, Math.floor(((1 - level) / 2) * samples)),
    high: valueAt(means, Math.floor(((1 + level) / 2) * samples) - 1),
    users: users.length,
  };
}
