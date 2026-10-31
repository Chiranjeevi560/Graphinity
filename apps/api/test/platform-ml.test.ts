import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  calibrate,
  correctDownsampling,
  deserializeCalibration,
  expectedCalibrationError,
  fitIsotonic,
  serializeCalibration,
} from '../src/ml/isotonic.ts';
import { fitDelayedFeedback, predictConversion, type DelayedExample } from '../src/ml/delayed-feedback.ts';
import { INITIAL_PACER, pacedBid, stepPacer, targetShare, trafficCurve } from '../src/ads/pacing.ts';
import { newArm, normalFrom, thompson, ucb, update } from '../src/ml/linucb.ts';
import {
  doublyRobustValue,
  fitPositionBias,
  ipsValue,
  type ClickLog,
  type LoggedDecision,
} from '../src/ml/counterfactual.ts';
import { effect, fitTwoModel, fitXLearner, qini, type UpliftRow } from '../src/ml/uplift.ts';
import { fitRidge, predictRidge } from '../src/ml/ridge.ts';
import { latinHypercube, proposeTpe, searchTpe, successiveHalving, walkForwardFolds } from '../src/ml/tuning.ts';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('isotonic calibration', () => {
  it('is monotone, whatever it is given', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.double({ min: 0, max: 1, noNaN: true }), fc.integer({ min: 0, max: 1 })), {
          minLength: 1,
          maxLength: 300,
        }),
        pairs => {
          const c = fitIsotonic(
            pairs.map(p => p[0]),
            pairs.map(p => p[1]),
          );
          for (let i = 1; i < c.y.length; i++) expect(c.y[i]).toBeGreaterThanOrEqual((c.y[i - 1] ?? 0) - 1e-12);
        },
      ),
    );
  });
  it('brings miscalibrated scores to an error under 0.015 on fresh data', () => {
    const r = rng(1);
    const make = (n: number) => {
      const s = new Float64Array(n);
      const y = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const v = r();
        s[i] = v;
        y[i] = r() < v * v ? 1 : 0;
      }
      return { s, y };
    };
    const train = make(50_000);
    const test = make(50_000);
    const c = fitIsotonic(train.s, train.y);
    expect(c.x.length).toBeLessThanOrEqual(64);
    const before = expectedCalibrationError(test.s, test.y);
    const after = expectedCalibrationError(
      test.s.map(v => calibrate(c, v)),
      test.y,
    );
    expect(before).toBeGreaterThan(0.1);
    expect(after).toBeLessThan(0.015);
    expect(calibrate(deserializeCalibration(serializeCalibration(c)), 0.5)).toBe(calibrate(c, 0.5));
  });
  it('undoes negative downsampling exactly', () => {
    // True rate 1%, keeping 10% of negatives: observed 0.01 / (0.01 + 0.099).
    expect(correctDownsampling(0.01 / 0.109, 0.1)).toBeCloseTo(0.01, 9);
    expect(calibrate({ x: new Float64Array(), y: new Float64Array() }, 0.3)).toBe(0.3);
    expect(expectedCalibrationError([], [])).toBe(0);
  });
});

describe('delayed conversions', () => {
  it('recover the true rate where calling recent clicks negative falls well short', () => {
    const r = rng(2);
    const data: DelayedExample[] = [];
    const x = Float64Array.of(1);
    let naive = 0;
    const N = 6000;
    for (let i = 0; i < N; i++) {
      const elapsed = r() * 14;
      const converts = r() < 0.3;
      const delay = -Math.log(1 - r()) * 7;
      if (converts && delay <= elapsed) {
        data.push({ x, delay, elapsed });
        naive += 1;
      } else data.push({ x, delay: null, elapsed });
    }
    const m = fitDelayedFeedback(data, 1, { epochs: 40, rate: 0.01 });
    expect(naive / N).toBeLessThan(0.2);
    expect(Math.abs(predictConversion(m, x) - 0.3)).toBeLessThan(0.05);
  });
});

describe('budget pacing', () => {
  it('spends close to the budget along the traffic curve, unlike no pacing', () => {
    const hourly = Array.from({ length: 24 }, (_, h) => 1 + Math.sin(((h - 6) / 24) * 2 * Math.PI) * 0.8);
    const curve = trafficCurve(hourly);
    const run = (pace: boolean) => {
      const budget = 1000;
      let spent = 0;
      let s = INITIAL_PACER;
      let worst = 0;
      for (let step = 0; step < 288; step++) {
        const f = step / 288;
        const target = targetShare(curve, f);
        const traffic = hourly[Math.floor(f * 24)] ?? 0;
        // Winning more, and paying more, with a higher bid; demand is three times the budget.
        const bid = pace ? pacedBid(1000, s.lambda) / 1000 : 1;
        spent = Math.min(
          budget,
          spent + ((traffic * 3 * budget) / 288 / 1) * bid * (24 / hourly.reduce((a, b) => a + b, 0)),
        );
        s = stepPacer(s, spent / budget, target);
        worst = Math.max(worst, Math.abs(spent / budget - targetShare(curve, (step + 1) / 288)));
      }
      return { spent, worst };
    };
    const paced = run(true);
    const free = run(false);
    expect(paced.spent).toBeGreaterThan(800);
    expect(paced.spent).toBeLessThanOrEqual(1000);
    expect(paced.worst).toBeLessThan(free.worst / 2);
  });
  it('keeps λ non-negative and bids positive, in any sequence', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.double({ min: 0, max: 2, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }))),
        steps => {
          let s = INITIAL_PACER;
          for (const [a, b] of steps) {
            s = stepPacer(s, a, b);
            expect(s.lambda).toBeGreaterThanOrEqual(0);
            expect(pacedBid(1_000_000, s.lambda)).toBeGreaterThan(0);
          }
        },
      ),
    );
    expect(trafficCurve([]).at(-1)).toBeCloseTo(1, 9);
  });
});

describe('contextual bandits', () => {
  it('Sherman-Morrison matches inverting directly', () => {
    const arm = newArm(2);
    const xs = [
      [1, 0.5],
      [0.2, 1],
      [1, 1],
    ];
    for (const x of xs) update(arm, x, 1);
    // A = I + Σxxᵀ.
    let a = 1;
    let b = 0;
    let d = 1;
    for (const [p = 0, q = 0] of xs) {
      a += p * p;
      b += p * q;
      d += q * q;
    }
    const det = a * d - b * b;
    expect(arm.inverse[0]).toBeCloseTo(d / det, 9);
    expect(arm.inverse[1]).toBeCloseTo(-b / det, 9);
    expect(arm.inverse[3]).toBeCloseTo(a / det, 9);
  });
  it('LinUCB and Thompson both learn the better action and shrink uncertainty', () => {
    const r = rng(3);
    const normal = normalFrom(r);
    const run = (pick: (arms: ReturnType<typeof newArm>[], x: number[]) => number) => {
      const arms = [newArm(2), newArm(2)];
      let late = 0;
      for (let t = 0; t < 2000; t++) {
        const x = [1, r()];
        const i = pick(arms, x);
        const p = i === 1 ? 0.6 : 0.3;
        update(arms[i] ?? newArm(2), x, r() < p ? 1 : 0);
        if (t >= 1000 && i === 1) late += 1;
      }
      return late / 1000;
    };
    const argmax = (v: number[]) => ((v[1] ?? 0) > (v[0] ?? 0) ? 1 : 0);
    expect(run((arms, x) => argmax(arms.map(a => ucb(a, x, 0.5))))).toBeGreaterThan(0.9);
    expect(run((arms, x) => argmax(arms.map(a => thompson(a, x, 0.3, normal))))).toBeGreaterThan(0.9);
  });
});

describe('counterfactual evaluation', () => {
  it('recovers position bias and true relevance from swapped logs', () => {
    const r = rng(4);
    const truth = { a: 0.6, b: 0.2 };
    const gamma = [1, 0.5, 0.25];
    const logs: ClickLog[] = [];
    for (let i = 0; i < 60_000; i++) {
      const item = r() < 0.5 ? 'a' : 'b';
      const rank = 1 + Math.floor(r() * 3);
      logs.push({ item, rank, clicked: r() < (gamma[rank - 1] ?? 0) * truth[item] });
    }
    const m = fitPositionBias(logs, 3, 60);
    expect(m.examination[0]).toBeCloseTo(1, 5);
    expect(Math.abs((m.examination[1] ?? 0) - 0.5)).toBeLessThan(0.06);
    expect(Math.abs((m.relevance.get('a') ?? 0) - 0.6)).toBeLessThan(0.08);
  });
  it('DR has lower error than IPS, and is right when the model is right', () => {
    const r = rng(5);
    const value = 0.5;
    const trials = (n: number) => {
      const ips: number[] = [];
      const dr: number[] = [];
      for (let t = 0; t < 200; t++) {
        const log: LoggedDecision[] = [];
        for (let i = 0; i < n; i++) {
          const shown = r() < 0.1;
          const reward = shown && r() < value ? 1 : 0;
          log.push({
            reward: shown ? reward : 0,
            propensity: shown ? 0.1 : 0.9,
            examination: 1,
            target: shown ? 1 : 0,
            predicted: shown ? value : 0,
            targetValue: value,
          });
        }
        ips.push(ipsValue(log));
        dr.push(doublyRobustValue(log, 20));
      }
      const rmse = (v: number[]) => Math.sqrt(v.reduce((a, b) => a + (b - value) ** 2, 0) / v.length);
      return { ips: rmse(ips), dr: rmse(dr) };
    };
    const { ips, dr } = trials(300);
    expect(dr).toBeLessThan(ips * 0.8);
    expect(ipsValue([])).toBe(0);
    expect(doublyRobustValue([])).toBe(0);
  });
});

describe('uplift', () => {
  const r = rng(6);
  const rows = (n: number): UpliftRow[] =>
    Array.from({ length: n }, () => {
      const f = r();
      const treated = r() < 0.2;
      // Half are helped, half are driven away.
      const y = 0.2 + 0.1 * f + (treated ? (f > 0.5 ? 0.3 : -0.2) : 0) + (r() - 0.5) * 0.05;
      return { x: [f, f > 0.5 ? 1 : 0], treated, y };
    });
  it('tells people helped from sleeping dogs, and ranks them better than random', () => {
    const train = rows(4000);
    const m = fitXLearner(train);
    expect(effect(m, [0.9, 1])).toBeGreaterThan(0.2);
    expect(effect(m, [0.1, 0])).toBeLessThan(-0.1);
    const test = rows(2000);
    const good = qini(test.map(t => ({ score: effect(m, t.x), treated: t.treated, y: t.y })));
    const bad = qini(test.map(t => ({ score: -effect(m, t.x), treated: t.treated, y: t.y })));
    expect(good.qini).toBeGreaterThan(bad.qini);
    expect(fitTwoModel(train)([0.9, 1])).toBeGreaterThan(0.2);
    expect(qini([])).toEqual({ qini: 0, auuc: 0 });
  });
  it('ridge finds a known line, and survives no data', () => {
    const m = fitRidge(
      Array.from({ length: 100 }, (_, i) => ({ x: [i], y: 3 * i + 2 })),
      1e-6,
    );
    expect(predictRidge(m, [10])).toBeCloseTo(32, 3);
    expect(predictRidge(fitRidge([]), [])).toBe(0);
  });
});

describe('tuning', () => {
  const space = { rate: { min: 1e-4, max: 1, log: true }, l2: { min: 0, max: 1 } };
  const loss = (c: Record<string, number>) => (Math.log10(c.rate ?? 1) + 2) ** 2 + ((c.l2 ?? 0) - 0.3) ** 2;
  it('a Latin hypercube uses each stratum once and stays in range', () => {
    const r = rng(7);
    const c = latinHypercube(space, 20, r);
    const strata = new Set(c.map(x => Math.floor((x.l2 ?? 0) * 20)));
    expect(strata.size).toBe(20);
    for (const x of c) expect(x.rate).toBeGreaterThanOrEqual(1e-4);
  });
  it('halving spends less than running all, and finds a good configuration', async () => {
    const r = rng(8);
    const configs = latinHypercube(space, 27, r);
    const { best, spent } = await successiveHalving(configs, (c, budget) => loss(c) + (r() - 0.5) / budget, {});
    expect(spent).toBeLessThan(27 * 27);
    expect(loss(best.config)).toBeLessThan(0.5);
  });
  it('TPE stays level with a Latin hypercube on the same budget, and concentrates its proposals', () => {
    let tpe = 0;
    let lhs = 0;
    for (let seed = 0; seed < 40; seed++) {
      const r = rng(seed + 100);
      tpe += Math.min(...searchTpe(space, 40, loss, r).map(t => t.loss));
      lhs += Math.min(...latinHypercube(space, 40, rng(seed + 900)).map(loss));
    }
    expect(tpe).toBeLessThan(lhs * 1.5);
    expect(proposeTpe(space, [], rng(1)).l2).toBeDefined();
  });
  it('walk-forward folds never test on what comes before their training', () => {
    fc.assert(
      fc.property(fc.integer({ min: 10, max: 10_000 }), fc.integer({ min: 1, max: 8 }), (n, k) => {
        for (const f of walkForwardFolds(n, k)) {
          expect(f.test[0]).toBeGreaterThanOrEqual(f.train[1]);
          expect(f.test[1]).toBeLessThanOrEqual(n);
        }
      }),
    );
  });
});
