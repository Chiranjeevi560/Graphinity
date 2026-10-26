import { describe, expect, it } from 'vitest';
import {
  columnsOf,
  DRIFT_RULE,
  featureDrift,
  ksTest,
  PROFILE_POINTS,
  profileOf,
  profilesOf,
  psi,
} from '../src/ml/drift.ts';
import { gaussian, seededRandom } from '../src/ml/linalg.ts';
import { must } from './helpers/must.ts';

const normal = (n: number, seed: number, shift = 0, scale = 1) => {
  const g = gaussian(seededRandom(seed));
  return Array.from({ length: n }, () => g() * scale + shift);
};
const flags = (n: number, seed: number, rate: number) => {
  const r = seededRandom(seed);
  return Array.from({ length: n }, () => (r() < rate ? 1 : 0));
};

describe('profiles', () => {
  it('summarize values by quantiles, count, mean and spread', () => {
    const p = must(profileOf([4, 1, 3, 2, 5]));
    expect(p.quantiles).toHaveLength(PROFILE_POINTS);
    expect(p.quantiles[0]).toBe(1);
    expect(p.quantiles[PROFILE_POINTS - 1]).toBe(5);
    expect(p.quantiles[(PROFILE_POINTS - 1) / 2]).toBe(3);
    expect(p).toMatchObject({ n: 5, mean: 3 });
    expect(p.sd).toBeCloseTo(Math.sqrt(2), 12);
    expect(profileOf([])).toBeNull();
  });

  it('are the same whatever order the values come in', () => {
    const v = normal(500, 1);
    expect(profileOf([...v].reverse())).toEqual(profileOf(v));
  });

  it('split rows into named columns, and back', () => {
    const rows = [
      [1, 10],
      [2, 20],
      [3, 30],
    ];
    expect(columnsOf(rows, ['a', 'b'])).toEqual({ a: [1, 2, 3], b: [10, 20, 30] });
    expect(must(profilesOf(rows, ['a', 'b']).b).mean).toBe(20);
  });
});

describe('PSI', () => {
  it('is near zero for the same distribution and grows with the move', () => {
    const ref = must(profileOf(normal(10_000, 1)));
    const same = psi(ref, normal(10_000, 2));
    const moved = psi(ref, normal(10_000, 3, 0.5));
    const far = psi(ref, normal(10_000, 4, 1));
    expect(same).toBeLessThan(0.01);
    expect(moved).toBeGreaterThan(0.2);
    expect(far).toBeGreaterThan(moved);
    expect(psi(ref, [])).toBe(0);
  });

  it('matches the formula for a flag exactly (bins merge on a discrete feature)', () => {
    const ref = must(profileOf(flags(10_000, 1, 0.3)));
    const share0 = ref.quantiles.filter(q => q === 0).length;
    // The reference's share of zeros is read off its quantiles: about 0.7.
    const e0 = (share0 - 1) / (PROFILE_POINTS - 1);
    const current = [...new Array<number>(550).fill(0), ...new Array<number>(450).fill(1)];
    const expected = (0.55 - e0) * Math.log(0.55 / e0) + (0.45 - (1 - e0)) * Math.log(0.45 / (1 - e0));
    expect(psi(ref, current)).toBeCloseTo(expected, 10);
  });

  it('sees values below a constant reference (every word known in training, some unknown now)', () => {
    const ref = must(profileOf(new Array<number>(1000).fill(1)));
    const half = [...new Array<number>(500).fill(1), ...new Array<number>(500).fill(0.4)];
    expect(psi(ref, half)).toBeGreaterThan(1);
    expect(psi(ref, new Array<number>(1000).fill(1))).toBeCloseTo(0, 12);
    // And above one.
    expect(psi(must(profileOf(new Array<number>(1000).fill(0))), half)).toBeGreaterThan(1);
  });

  it('stays finite when a bin is empty', () => {
    const ref = must(profileOf(normal(1000, 1)));
    expect(Number.isFinite(psi(ref, new Array<number>(500).fill(100)))).toBe(true);
  });

  it('is never negative (property, 200 random cases)', () => {
    const r = seededRandom(9);
    for (let t = 0; t < 200; t++) {
      const ref = must(profileOf(normal(50 + Math.floor(r() * 500), t, r(), 0.1 + r())));
      expect(psi(ref, normal(1 + Math.floor(r() * 300), t + 1000, r() * 2, 0.1 + r()))).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('KS', () => {
  it('finds no difference for the same distribution and a clear one for a move', () => {
    const ref = must(profileOf(normal(10_000, 1)));
    expect(ksTest(ref, normal(5000, 2)).p).toBeGreaterThan(0.01);
    const moved = ksTest(ref, normal(5000, 3, 0.2));
    expect(moved.p).toBeLessThan(1e-6);
    expect(moved.d).toBeGreaterThan(0.05);
    expect(ksTest(ref, [])).toEqual({ d: 0, p: 1 });
  });

  it('measures the largest gap between the CDFs', () => {
    // Everything current is above the reference's maximum: the gap is the whole CDF.
    const ref = must(profileOf(normal(1000, 1)));
    expect(ksTest(ref, new Array<number>(100).fill(1e9)).d).toBeCloseTo(1 - 1 / (PROFILE_POINTS - 1), 10);
  });

  it('keeps the point masses of a flag: same rate, no gap; new rate, the exact gap', () => {
    const ref = must(profileOf(flags(10_000, 1, 0.3)));
    const k = PROFILE_POINTS - 1;
    const zeros = ref.quantiles.filter(q => q === 0).length;
    // The share of zeros lies between these, as the quantiles can tell it.
    const [low, high] = [(zeros - 1) / k, zeros / k];
    const at = (rate: number) => [
      ...new Array<number>(Math.round(1000 * (1 - rate))).fill(0),
      ...new Array<number>(Math.round(1000 * rate)).fill(1),
    ];
    const gap = (rate: number) => Math.max(0, Math.max(Math.abs(1 - rate - low), Math.abs(1 - rate - high)) - 1 / k);
    expect(ksTest(ref, at(0.45)).d).toBeCloseTo(gap(0.45), 10);
    expect(ksTest(ref, at(1 - low)).d).toBeCloseTo(0, 12);
  });

  it('gives p-values that are rarely small when nothing moved (calibration, 300 trials)', () => {
    const ref = must(profileOf(normal(10_000, 1)));
    let small = 0;
    for (let t = 0; t < 300; t++) if (ksTest(ref, normal(500, 100 + t)).p < 0.05) small++;
    // At most about 5% by chance; the summary's half-step allowance makes it conservative.
    expect(small / 300).toBeLessThan(0.08);
  });
});

describe('feature drift', () => {
  const ref = profilesOf(
    normal(10_000, 1).map((x, i) => [x, i % 10 < 3 ? 1 : 0]),
    ['score', 'flag'],
  );

  it('flags only the feature that moved materially', () => {
    const current = {
      score: normal(2000, 2, 0.5),
      flag: flags(2000, 3, 0.3),
    };
    const out = featureDrift(ref, current);
    expect(out.map(f => [f.feature, f.drifted])).toEqual([
      ['flag', false],
      ['score', true],
    ]);
    expect(out.find(f => f.feature === 'score')?.n).toBe(2000);
  });

  it('catches a flag moving from 30% to 45%, which PSI alone at 0.1 would miss', () => {
    const exactly45 = Array.from({ length: 2000 }, (_, i) => (i % 20 < 9 ? 1 : 0));
    const out = featureDrift(ref, { score: normal(2000, 4), flag: exactly45 });
    const flag = must(out.find(f => f.feature === 'flag'));
    expect(flag.psi).toBeLessThan(0.1);
    expect(flag.drifted).toBe(true);
  });

  it('ignores a negligible move however large the sample', () => {
    const out = featureDrift(ref, { score: normal(100_000, 6, 0.08), flag: flags(100_000, 7, 0.31) });
    expect(out.every(f => !f.drifted)).toBe(true);
    // KS alone would flag it, even after dividing alpha by the two features: only PSI keeps it quiet.
    const score = must(out.find(f => f.feature === 'score'));
    expect(score.p).toBeLessThan(DRIFT_RULE.alpha / 2);
    expect(score.psi).toBeLessThan(DRIFT_RULE.psi);
  });

  it('gives no verdict on too few values, and skips features with no current data', () => {
    const few = featureDrift(ref, { score: normal(DRIFT_RULE.minCurrent - 1, 8, 5) });
    expect(few).toEqual([{ feature: 'score', psi: 0, ks: 0, p: 1, n: DRIFT_RULE.minCurrent - 1, drifted: false }]);
  });

  it('divides alpha by the features tested', () => {
    // A move whose p sits between alpha/2 and alpha: drifted with one feature tested, not with two.
    const r = seededRandom(11);
    let found: number[] | null = null;
    for (let t = 0; t < 400 && !found; t++) {
      const v = normal(400, 500 + t, 0.17 + r() * 0.04);
      const k = ksTest(must(ref.score), v);
      if (k.p < DRIFT_RULE.alpha && k.p > DRIFT_RULE.alpha / 2) found = v;
    }
    const v = must(found);
    const one = featureDrift({ score: must(ref.score) }, { score: v }, { ...DRIFT_RULE, psi: 0 });
    const two = featureDrift(ref, { score: v, flag: flags(400, 12, 0.3) }, { ...DRIFT_RULE, psi: 0 });
    expect(one[0]?.drifted).toBe(true);
    expect(two.find(f => f.feature === 'score')?.drifted).toBe(false);
  });
});
