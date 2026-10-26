import { describe, expect, it } from 'vitest';
import {
  deserializeLambdaMart,
  lambdaGradients,
  rank,
  scoreOne,
  serializeLambdaMart,
  trainLambdaMart,
  type RankingQuery,
} from '../src/ml/lambdamart.ts';
import { seededRandom } from '../src/ml/linalg.ts';
import { ndcgAt } from '../src/search/metrics.ts';

/**
 * Relevance a straight line can't express: a result is relevant when exactly
 * one of two signals is high (an interaction), and very relevant when a third
 * is high as well.
 */
function interactions(queries: number, seed: number): RankingQuery[] {
  const r = seededRandom(seed);
  return Array.from({ length: queries }, () => {
    const features = Array.from({ length: 12 }, () => [r(), r(), r(), r()]);
    const labels = features.map(([a = 0, b = 0, c = 0]) => (a > 0.5 !== b > 0.5 ? (c > 0.5 ? 2 : 1) : 0));
    return { features, labels };
  });
}

const meanNdcg = (model: ReturnType<typeof trainLambdaMart>, qs: RankingQuery[]) =>
  qs.reduce((s, q) => {
    const order = rank(model, q.features);
    return (
      s +
      ndcgAt(
        order.map(i => q.labels[i] ?? 0),
        10,
        q.labels,
      )
    );
  }, 0) / qs.length;

describe('LambdaMART', () => {
  it('learns an interaction no linear score can, and ranks unseen queries by it', () => {
    const model = trainLambdaMart(interactions(300, 1), { trees: 120 });
    const test = interactions(200, 2);
    expect(meanNdcg(model, test)).toBeGreaterThan(0.9);
    // Far above ranking at random.
    const shuffled = test.reduce((s, q) => s + ndcgAt(q.labels, 10, q.labels), 0) / test.length;
    expect(meanNdcg(model, test)).toBeGreaterThan(shuffled + 0.2);
  });

  it('improves with more trees, and is deterministic', () => {
    const train = interactions(200, 3);
    const test = interactions(100, 4);
    const few = trainLambdaMart(train, { trees: 3 });
    const many = trainLambdaMart(train, { trees: 80 });
    expect(meanNdcg(many, test)).toBeGreaterThan(meanNdcg(few, test));
    expect(serializeLambdaMart(trainLambdaMart(train, { trees: 10 }))).toEqual(
      serializeLambdaMart(trainLambdaMart(train, { trees: 10 })),
    );
  });

  it('weights pairs by their relevant result’s weight (inverse propensity)', () => {
    // Two signals, each marking a different relevant result; only one is to be believed.
    const r = seededRandom(5);
    const queries: RankingQuery[] = Array.from({ length: 200 }, () => {
      const features = Array.from({ length: 6 }, (_, i) => [i === 0 ? 1 : r() * 0.5, i === 1 ? 1 : r() * 0.5]);
      return { features, labels: [1, 1, 0, 0, 0, 0], weights: [1, 0, 1, 1, 1, 1] };
    });
    const model = trainLambdaMart(queries, { trees: 30 });
    // Result 1's evidence carried no weight: feature 0 is what the model learned to trust.
    expect(scoreOne(model, [1, 0])).toBeGreaterThan(scoreOne(model, [0, 1]));
    const unweighted = trainLambdaMart(
      queries.map(q => ({ features: q.features, labels: q.labels })),
      { trees: 30 },
    );
    expect(scoreOne(unweighted, [0, 1])).toBeGreaterThan(scoreOne(model, [0, 1]));
  });

  it('ignores queries with nothing relevant or a single result, and scores zero untrained', () => {
    const empty = trainLambdaMart([
      { features: [[1], [2]], labels: [0, 0] },
      { features: [[1]], labels: [1] },
    ]);
    expect(scoreOne(empty, [1])).toBe(0);
    expect(rank(empty, [[3], [1], [2]])).toEqual([0, 1, 2]);
  });

  it('round-trips through its artifact, and refuses one it can’t read', () => {
    const model = trainLambdaMart(interactions(50, 6), { trees: 5 });
    const back = deserializeLambdaMart(serializeLambdaMart(model));
    const row = [0.7, 0.2, 0.9, 0.1];
    expect(scoreOne(back, row)).toBe(scoreOne(model, row));
    expect(() => deserializeLambdaMart(Buffer.from('{"v":2}'))).toThrow();
  });

  it('pushes pairs apart by their change in NDCG@k, and not at all below the cutoff', () => {
    const labels = [0, 1, 2];
    const idcg = 3 / Math.log2(2) + 1 / Math.log2(3);
    const k1 = lambdaGradients([0, 0, 0], labels, [1, 1, 1], idcg, 1, 1);
    const k10 = lambdaGradients([0, 0, 0], labels, [1, 1, 1], idcg, 10, 1);
    // At k = 1 the middle result is only ever pushed up past the first: the pair it forms
    // with the best one sits below the cutoff and moves nothing.
    expect(k1.grad[1] ?? 0).toBeGreaterThan(0);
    expect(k10.grad[1] ?? 0).toBeLessThan(k1.grad[1] ?? 0);
    // What goes up comes down: gradients sum to zero within a query.
    expect((k10.grad[0] ?? 0) + (k10.grad[1] ?? 0) + (k10.grad[2] ?? 0)).toBeCloseTo(0, 12);
    // The exact LambdaRank value for the (2, 0) pair at k = 1: sigma * rho * |dNDCG|, rho = 0.5 at equal scores.
    const swap = (3 * (1 - 1 / Math.log2(4)) - 0) / idcg;
    expect(k1.grad[2] ?? 0).toBeCloseTo((0.5 * Math.abs((3 - 0) * (0 - 1))) / idcg, 12);
    expect(swap).toBeGreaterThan(0);
    // A weight scales its pairs.
    const heavy = lambdaGradients([0, 0, 0], labels, [1, 1, 3], idcg, 10, 1);
    expect(heavy.grad[2] ?? 0).toBeCloseTo(3 * (k10.grad[2] ?? 0), 12);
  });
});
