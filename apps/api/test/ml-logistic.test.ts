import { describe, expect, it } from 'vitest';
import { gaussian, seededRandom } from '../src/ml/linalg.ts';
import { auc, fitLogistic, logLoss, predict, sigmoid } from '../src/ml/logistic.ts';

describe('logistic regression', () => {
  it('fits the intercept alone to the log-odds of the base rate, exactly (the intercept has no prior)', () => {
    const y = [1, 0, 0, 0, 1, 0, 0, 0];
    const model = fitLogistic(
      y.map(() => []),
      y,
      10,
    );
    expect(model.weights[0]).toBeCloseTo(Math.log(2 / 6), 10);
  });

  it('recovers the weights that generated the data', () => {
    const random = seededRandom(1);
    const normal = gaussian(random);
    const truth = [-1, 2, -1.5, 0.5];
    const x = Array.from({ length: 20_000 }, () => [normal(), normal(), normal()]);
    const y = x.map(row => (random() < predict({ weights: truth }, row) ? 1 : 0));
    const model = fitLogistic(x, y, 0.01);
    // Within 0.1: about three standard errors at 20,000 rows.
    model.weights.forEach((w, k) => {
      expect(Math.abs(w - (truth[k] ?? 0))).toBeLessThan(0.1);
    });
    expect(model.iterations).toBeLessThan(15);
    expect(fitLogistic(x, y, 0.01)).toEqual(model);
  });

  it('stays finite on perfectly separated data, and the prior pulls thin evidence towards 0', () => {
    const x = [[-2], [-1], [1], [2]];
    const y = [0, 0, 1, 1];
    const weak = fitLogistic(x, y, 1);
    const strong = fitLogistic(x, y, 100);
    expect(Number.isFinite(weak.weights[1])).toBe(true);
    expect(weak.weights[1]).toBeGreaterThan(0);
    expect(Math.abs(strong.weights[1] ?? 0)).toBeLessThan(Math.abs(weak.weights[1] ?? 0));
    expect(() => fitLogistic(x, y, 0)).toThrow(/positive/);
    expect(() => fitLogistic(x, [1], 1)).toThrow(/length/);
    expect(() => fitLogistic([[1], [1, 2]], [0, 1], 1)).toThrow(/same features/);
  });

  it('finds the exact MAP weight, prior included', () => {
    // x = ±1, y = 1 / 0: by symmetry no intercept, and 2·(1 − σ(w)) = λ·w at the optimum.
    const lambda = 1;
    let lo = 0;
    let hi = 10;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (2 * (1 - sigmoid(mid)) - lambda * mid > 0) lo = mid;
      else hi = mid;
    }
    const model = fitLogistic([[1], [-1]], [1, 0], lambda);
    expect(model.weights[0]).toBeCloseTo(0, 9);
    expect(model.weights[1]).toBeCloseTo(lo, 9);
    expect(model.converged).toBe(true);
  });

  it('converges where a full Newton step overshoots: one far-out point, a weak prior', () => {
    // Found by search: without step-halving this doesn't converge in 50 steps.
    const x = [[-12.584], [95.881], [0.713], [-1.303], [-1.355]];
    const y = [1, 0, 1, 1, 1];
    const model = fitLogistic(x, y, 1e-6, { maxIterations: 50 });
    expect(model.converged).toBe(true);
    expect(model.weights.every(Number.isFinite)).toBe(true);
  });

  it('copes with no rows at all', () => {
    expect(fitLogistic([], [], 1).weights).toEqual([0]);
  });

  it('computes a stable sigmoid at the extremes', () => {
    expect(sigmoid(1000)).toBe(1);
    expect(sigmoid(-1000)).toBe(0);
    expect(sigmoid(0)).toBe(0.5);
  });
});

describe('scores', () => {
  it('gives AUC 1 for a perfect ranking, 0.5 for ties, and null without both classes', () => {
    expect(auc([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0])).toBe(1);
    expect(auc([0.1, 0.2, 0.8, 0.9], [1, 1, 0, 0])).toBe(0);
    expect(auc([0.5, 0.5, 0.5], [1, 0, 0])).toBe(0.5);
    expect(auc([0.9, 0.1, 0.5], [1, 0, 1])).toBe(1);
    expect(auc([0.3, 0.4], [1, 1])).toBeNull();
  });

  it('computes log-loss, clipping certainty', () => {
    expect(logLoss([0.5, 0.5], [1, 0])).toBeCloseTo(Math.log(2), 12);
    expect(Number.isFinite(logLoss([0, 1], [1, 0]))).toBe(true);
    expect(logLoss([], [])).toBe(0);
  });
});
