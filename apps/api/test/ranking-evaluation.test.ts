import { describe, expect, it } from 'vitest';
import { evaluateCounterfactual, evaluateRanking } from '../src/ranking-evaluation.ts';

describe('offline ranking evaluation', () => {
  it('computes graded NDCG, reciprocal rank, precision, and recall at k', () => {
    const metrics = evaluateRanking(
      [
        {
          candidates: [
            { id: 'a', relevance: 3, score: 0.9 },
            { id: 'b', relevance: 0, score: 0.8 },
            { id: 'c', relevance: 1, score: 0.7 },
          ],
        },
      ],
      2,
    );
    expect(metrics.queryCount).toBe(1);
    expect(metrics.meanReciprocalRank).toBe(1);
    expect(metrics.precisionAtK).toBe(0.5);
    expect(metrics.recallAtK).toBe(0.5);
    expect(metrics.ndcgAtK).toBeCloseTo((7 + 0) / (7 + 1 / Math.log2(3)));
  });

  it('uses stable id tie-breaking and reports no-label datasets explicitly', () => {
    expect(
      evaluateRanking(
        [
          {
            candidates: [
              { id: 'b', relevance: 1, score: 0.5 },
              { id: 'a', relevance: 0, score: 0.5 },
            ],
          },
          { candidates: [{ id: 'c', relevance: 0, score: 1 }] },
        ],
        1,
      ),
    ).toEqual({ queryCount: 2, ndcgAtK: 0, meanReciprocalRank: 0, precisionAtK: 0, recallAtK: 0 });
    expect(evaluateRanking([{ candidates: [{ id: 'a', relevance: 0, score: 0 }] }], 1).ndcgAtK).toBeNull();
  });

  it('rejects invalid cutoffs, duplicate ids, and unbounded relevance labels', () => {
    expect(() => evaluateRanking([], 0)).toThrow(RangeError);
    expect(() =>
      evaluateRanking(
        [
          {
            candidates: [
              { id: 'a', relevance: 0, score: 0 },
              { id: 'a', relevance: 1, score: 1 },
            ],
          },
        ],
        1,
      ),
    ).toThrow(TypeError);
    expect(() => evaluateRanking([{ candidates: [{ id: 'a', relevance: 5, score: 1 }] }], 1)).toThrow(RangeError);
  });
});

describe('counterfactual policy evaluation', () => {
  it('calculates IPS, SNIPS, effective sample size, and largest importance weight', () => {
    expect(
      evaluateCounterfactual([
        { loggingProbability: 0.5, targetProbability: 1, reward: 1 },
        { loggingProbability: 0.5, targetProbability: 0.5, reward: 0 },
      ]),
    ).toEqual({
      actionCount: 2,
      inversePropensityEstimate: 1,
      selfNormalizedEstimate: 2 / 3,
      effectiveSampleSize: 1.8,
      maximumImportanceWeight: 2,
    });
  });

  it('rejects zero support and invalid probabilities or rewards instead of biasing the result', () => {
    expect(() => evaluateCounterfactual([{ loggingProbability: 0, targetProbability: 1, reward: 1 }])).toThrow(
      RangeError,
    );
    expect(() => evaluateCounterfactual([{ loggingProbability: 0.5, targetProbability: 1.1, reward: 1 }])).toThrow(
      RangeError,
    );
    expect(() => evaluateCounterfactual([{ loggingProbability: 0.5, targetProbability: 1, reward: -1 }])).toThrow(
      RangeError,
    );
    expect(evaluateCounterfactual([])).toEqual({
      actionCount: 0,
      inversePropensityEstimate: null,
      selfNormalizedEstimate: null,
      effectiveSampleSize: 0,
      maximumImportanceWeight: 0,
    });
  });
});
