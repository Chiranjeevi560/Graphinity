import { describe, expect, it } from 'vitest';
import {
  ndcgAt,
  pairedDifference,
  precisionAt,
  recallAt,
  reciprocalRank,
  score,
  type Judged,
} from '../src/search/metrics.ts';

describe('ranking measures', () => {
  it('computes NDCG with graded relevance against the ideal order, by hand', () => {
    // DCG = (2³−1)/log₂2 + 0 + (2¹−1)/log₂4 = 7 + 0.5; ideal [3,1,0] = 7 + 1/log₂3.
    expect(ndcgAt([3, 0, 1], 10)).toBeCloseTo(7.5 / (7 + 1 / Math.log2(3)), 12);
    expect(ndcgAt([0, 0, 0], 10)).toBe(0);
    expect(ndcgAt([1, 2, 3], 1)).toBeCloseTo(1 / 7, 12);
    expect(ndcgAt([3, 2, 1], 10)).toBe(1);
  });

  it('computes MRR, Recall@k and Precision@k', () => {
    expect(reciprocalRank([0, 0, 2, 1])).toBeCloseTo(1 / 3, 12);
    expect(reciprocalRank([0, 0])).toBe(0);
    expect(recallAt([1, 0, 1, 0], 3, 4)).toBe(0.5);
    expect(recallAt([1], 3, 0)).toBe(0);
    expect(precisionAt([1, 0, 1, 0], 4)).toBe(0.5);
    expect(precisionAt([1], 0)).toBe(0);
  });

  it('averages per person first, so one person searching a lot counts once', () => {
    const heavy: Judged[] = Array.from({ length: 9 }, () => ({ user: 'a', relevance: [0, 0, 1], totalRelevant: 1 }));
    const light: Judged = { user: 'b', relevance: [1], totalRelevant: 1 };
    expect(score([...heavy, light])).toMatchObject({ queries: 10, users: 2, mrr: (1 / 3 + 1) / 2 });
  });
});

describe('comparing two rankings', () => {
  const judged = (user: string, relevance: number[]): Judged => ({ user, relevance, totalRelevant: 1 });

  it('finds a real gain, resampling people', () => {
    const users = Array.from({ length: 40 }, (_, i) => `u${String(i)}`);
    const better = users.map(u => judged(u, [1, 0]));
    const worse = users.map(u => judged(u, [0, 1]));
    const d = pairedDifference(better, worse, q => reciprocalRank(q.relevance));
    expect(d).toMatchObject({ users: 40, mean: 0.5 });
    expect(d.low).toBeGreaterThan(0);
  });

  it('finds no gain where the two agree, and refuses mismatched queries', () => {
    const users = Array.from({ length: 30 }, (_, i) => `u${String(i)}`);
    const same = users.map(u => judged(u, [0, 1]));
    expect(pairedDifference(same, same, q => reciprocalRank(q.relevance))).toMatchObject({ mean: 0, low: 0, high: 0 });
    expect(() => pairedDifference(same, same.slice(1), q => q.relevance.length)).toThrow(/different queries/);
    expect(() => pairedDifference([judged('a', [1])], [judged('b', [1])], q => q.relevance.length)).toThrow(
      /different queries/,
    );
  });
});
