import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { murmur3 } from '../src/experiments/murmur.ts';
import { assign, bucketOf, BUCKETS, overlaps, type Experiment } from '../src/experiments/assign.ts';
import {
  chiSquareP,
  cupedAdjust,
  cupedTheta,
  evaluate,
  msprtLikelihood,
  nextAlwaysValidP,
  sampleRatioMismatch,
  variance,
} from '../src/experiments/stats.ts';

describe('MurmurHash3 x86 32', () => {
  it('matches the reference vectors', () => {
    expect(murmur3('', 0)).toBe(0);
    expect(murmur3('', 1)).toBe(0x514e28b7);
    expect(murmur3('', 0xffffffff)).toBe(0x81f16f39);
    expect(murmur3('test', 0)).toBe(0xba6bd213);
    expect(murmur3('test', 0x9747b28c)).toBe(0x704b81dc);
    expect(murmur3('Hello, world!', 0)).toBe(0xc0363e43);
    expect(murmur3('The quick brown fox jumps over the lazy dog', 0x9747b28c)).toBe(0x2fa826cd);
    expect(murmur3('aaa', 0x9747b28c)).toBe(0x283e0130);
    expect(murmur3('aa', 0x9747b28c)).toBe(0x5d211726);
    expect(murmur3('a', 0x9747b28c)).toBe(0x7fa09ea6);
  });
});

describe('assignment', () => {
  const e: Experiment = {
    id: 'e1',
    bucketStart: 0,
    bucketEnd: 5000,
    arms: [
      { name: 'control', weight: 0.5 },
      { name: 'treatment', weight: 0.5 },
    ],
  };
  it('is stable, and splits evenly', () => {
    const counts = { control: 0, treatment: 0, none: 0 };
    for (let i = 0; i < 20_000; i++) {
      const u = `u${String(i)}`;
      const a = assign(u, 'salt', [e]);
      expect(assign(u, 'salt', [e])).toEqual(a);
      counts[(a?.arm ?? 'none') as keyof typeof counts] += 1;
    }
    expect(Math.abs(counts.none - 10_000)).toBeLessThan(400);
    expect(Math.abs(counts.control - counts.treatment)).toBeLessThan(400);
  });
  it('layers are independent: being in one says nothing about the other', () => {
    let both = 0;
    let first = 0;
    for (let i = 0; i < 40_000; i++) {
      const u = `u${String(i)}`;
      const a = bucketOf(u, 'layer-a') < BUCKETS / 2;
      const b = bucketOf(u, 'layer-b') < BUCKETS / 2;
      if (a) first += 1;
      if (a && b) both += 1;
    }
    expect(Math.abs(both / first - 0.5)).toBeLessThan(0.02);
  });
  it('finds overlap in bucket ranges', () => {
    expect(overlaps({ bucketStart: 4999, bucketEnd: 6000 }, [e])).toBe(true);
    expect(overlaps({ bucketStart: 5000, bucketEnd: 6000 }, [e])).toBe(false);
    expect(assign('u', 's', [])).toBeNull();
  });
});

describe('statistics', () => {
  it('computes chi-square p-values', () => {
    expect(chiSquareP(3.841, 1)).toBeCloseTo(0.05, 3);
    expect(chiSquareP(10.828, 1)).toBeCloseTo(0.001, 4);
    expect(chiSquareP(0, 1)).toBe(1);
    expect(chiSquareP(5.991, 2)).toBeCloseTo(0.05, 3);
    expect(chiSquareP(200, 3)).toBeLessThan(1e-20);
  });
  it('SRM fires on a broken split and not on a fair one', () => {
    expect(sampleRatioMismatch([5000, 5050], [0.5, 0.5]).mismatch).toBe(false);
    expect(sampleRatioMismatch([5000, 5500], [0.5, 0.5]).mismatch).toBe(true);
    expect(sampleRatioMismatch([0, 0], [0.5, 0.5]).p).toBe(1);
  });
  function gaussian(seed: number) {
    let s = seed;
    const u = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return (s + 0.5) / 2 ** 32;
    };
    return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
  }
  it('CUPED removes ρ² of the variance and leaves the effect alone', () => {
    const g = gaussian(11);
    const n = 20_000;
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = g();
      y[i] = 0.8 * (x[i] ?? 0) + 0.6 * g();
    }
    const theta = cupedTheta(y, x);
    expect(theta).toBeCloseTo(0.8, 1);
    const adjusted = cupedAdjust(y, x, theta, 0);
    expect(variance(adjusted) / variance(y)).toBeCloseTo(1 - 0.64, 1);
    expect(cupedTheta([1, 2], [3, 3])).toBe(0);
  });
  it('evaluate finds a real effect, and blanks the read once SRM fires', () => {
    const g = gaussian(12);
    const arm = (n: number, shift: number) => {
      const x = Float64Array.from({ length: n }, () => g());
      const y = Float64Array.from(x, v => v + shift + 0.5 * g());
      return { x, y };
    };
    const res = evaluate(arm(5000, 0), arm(5000, 0.1), [0.5, 0.5]);
    expect(res.effect?.lift).toBeGreaterThan(0.05);
    expect(res.effect?.low).toBeGreaterThan(0);
    expect(res.effect?.alwaysValidP).toBeLessThan(0.05);
    expect(res.effect?.varianceReduction).toBeGreaterThan(0.5);
    expect(evaluate(arm(5000, 0), arm(6000, 0), [0.5, 0.5]).effect).toBeNull();
  });
  it('INVARIANT 5: peeking every day keeps A/A false positives at or below 5% with mSPRT; a t-test does not', () => {
    const g = gaussian(13);
    const simulations = 400;
    let msprt = 0;
    let peekedT = 0;
    for (let s = 0; s < simulations; s++) {
      let sum = 0;
      let p = 1;
      let tFired = false;
      for (let n = 1; n <= 500; n++) {
        sum += g() * Math.SQRT2;
        if (n % 10 !== 0) continue;
        p = nextAlwaysValidP(p, msprtLikelihood(n, sum / n, 2, 0.1));
        if (Math.abs(sum / n) / Math.sqrt(2 / n) > 1.96) tFired = true;
      }
      if (p < 0.05) msprt += 1;
      if (tFired) peekedT += 1;
    }
    expect(msprt / simulations).toBeLessThanOrEqual(0.05);
    expect(peekedT / simulations).toBeGreaterThan(0.15);
    expect(msprtLikelihood(0, 1, 1, 1)).toBe(1);
    expect(nextAlwaysValidP(0.5, 0)).toBe(0.5);
  });
  it('the always-valid p never rises', () => {
    fc.assert(
      fc.property(fc.array(fc.double({ min: 0, max: 1e6, noNaN: true })), ls => {
        let p = 1;
        for (const l of ls) {
          const next = nextAlwaysValidP(p, l);
          expect(next).toBeLessThanOrEqual(p);
          p = next;
        }
      }),
    );
  });
});
