import { describe, expect, it } from 'vitest';
import {
  coordinates,
  createFtrl,
  deserializeServing,
  hashFeature,
  learn,
  logLoss,
  predict,
  predictServing,
  serializeServing,
  servingOf,
  sparseWeights,
} from '../src/ml/ftrl.ts';
import { seededRandom } from '../src/ml/linalg.ts';
import { must } from './helpers/must.ts';

/** Clicks 20% of the time with feature "good", 1% without; plus noise features. */
function stream(n: number, seed: number) {
  const r = seededRandom(seed);
  return Array.from({ length: n }, () => {
    const good = r() < 0.5;
    return {
      features: [good ? 'good' : 'plain', `noise:${String(Math.floor(r() * 500))}`],
      clicked: r() < (good ? 0.2 : 0.01),
    };
  });
}

describe('FTRL-Proximal', () => {
  it('learns which features lead to clicks, calibrated', () => {
    const m = createFtrl();
    for (const e of stream(40_000, 1)) learn(m, e.features, e.clicked);
    expect(predict(m, ['good'])).toBeGreaterThan(0.15);
    expect(predict(m, ['good'])).toBeLessThan(0.25);
    expect(predict(m, ['plain'])).toBeLessThan(0.03);
  });

  it('beats a constant on held-out data', () => {
    const m = createFtrl();
    for (const e of stream(30_000, 2)) learn(m, e.features, e.clicked);
    const test = stream(10_000, 3);
    const rate = test.filter(e => e.clicked).length / test.length;
    expect(
      logLoss(
        test.map(e => predict(m, e.features)),
        test.map(e => e.clicked),
      ),
    ).toBeLessThan(
      logLoss(
        test.map(() => rate),
        test.map(e => e.clicked),
      ),
    );
  });

  it('keeps noise out with L1: most weights are exactly zero', () => {
    const strict = createFtrl({ l1: 5 });
    const loose = createFtrl({ l1: 0 });
    for (const e of stream(20_000, 4)) {
      learn(strict, e.features, e.clicked);
      learn(loose, e.features, e.clicked);
    }
    expect(sparseWeights(strict).length).toBeLessThan(sparseWeights(loose).length / 5);
    expect(sparseWeights(strict).length).toBeGreaterThan(0);
  });

  it('is deterministic, with stable feature hashes', () => {
    const train = () => {
      const m = createFtrl({ bits: 16 });
      for (const e of stream(5_000, 5)) learn(m, e.features, e.clicked);
      return sparseWeights(m);
    };
    expect(train()).toEqual(train());
    expect(hashFeature('campaign:42', 20)).toBe(hashFeature('campaign:42', 20));
    expect(hashFeature('campaign:42', 20)).toBeLessThan(1 << 20);
    expect(() => createFtrl({ bits: 30 })).toThrow();
  });

  it('serves the same predictions from its stored weights, and refuses damaged ones', () => {
    const m = createFtrl({ bits: 16 });
    for (const e of stream(5_000, 6)) learn(m, e.features, e.clicked);
    const stored = deserializeServing(serializeServing(servingOf(m)));
    for (const f of [['good'], ['plain', 'noise:3'], ['never-seen']])
      expect(predictServing(stored, f)).toBeCloseTo(predict(m, f), 12);
    const bytes = serializeServing(servingOf(m));
    expect(() => deserializeServing(bytes.subarray(0, bytes.length - 3))).toThrow(/damaged/);
    expect(() => deserializeServing(Buffer.from('nope'))).toThrow(/not an FTRL/);
  });

  it('follows the paper’s per-coordinate update exactly (two steps, worked by hand)', () => {
    const m = createFtrl({ alpha: 0.1, beta: 1, l1: 0, l2: 0, bits: 8 });
    const [i] = coordinates(['a'], 8);
    learn(m, ['a'], true);
    // Step 1: p = 0.5, g = -0.5, sigma = (sqrt(0.25) - 0) / 0.1 = 5, w was 0: z = -0.5, n = 0.25.
    expect(m.z[must(i)]).toBeCloseTo(-0.5, 12);
    expect(m.n[must(i)]).toBeCloseTo(0.25, 12);
    // w = -z / ((beta + sqrt(n)) / alpha) = 0.5 / 15 for each of the two coordinates (bias and a).
    const w = 0.5 / 15;
    learn(m, ['a'], true);
    const g2 = 1 / (1 + Math.exp(-2 * w)) - 1;
    const sigma2 = (Math.sqrt(0.25 + g2 * g2) - 0.5) / 0.1;
    expect(m.z[must(i)]).toBeCloseTo(-0.5 + g2 - sigma2 * w, 12);
    expect(m.n[must(i)]).toBeCloseTo(0.25 + g2 * g2, 12);
  });

  it('measures log loss, clipped so a sure wrong guess is large but finite', () => {
    expect(logLoss([0.5, 0.5], [true, false])).toBeCloseTo(Math.log(2), 12);
    expect(Number.isFinite(logLoss([0], [true]))).toBe(true);
    expect(logLoss([], [])).toBe(0);
  });
});
