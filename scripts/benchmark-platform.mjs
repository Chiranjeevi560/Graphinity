#!/usr/bin/env node
// The platform's engines against the baselines they replace (docs/adr/0024-platform-engines.md).
// Simulated data with a known truth, fixed seeds. Prints what's quoted in the ADR.
//
//   node scripts/benchmark-platform.mjs
import { calibrate, expectedCalibrationError, fitIsotonic } from '../apps/api/src/ml/isotonic.ts';
import { INITIAL_PACER, pacedBid, stepPacer, targetShare, trafficCurve } from '../apps/api/src/ads/pacing.ts';
import { fitDelayedFeedback, predictConversion } from '../apps/api/src/ml/delayed-feedback.ts';
import { doublyRobustValue, ipsValue } from '../apps/api/src/ml/counterfactual.ts';
import { newArm, normalFrom, thompson, ucb, update } from '../apps/api/src/ml/linucb.ts';
import { effect, fitTwoModel, fitXLearner, qini } from '../apps/api/src/ml/uplift.ts';
import {
  cupedAdjust,
  cupedTheta,
  msprtLikelihood,
  nextAlwaysValidP,
  variance,
} from '../apps/api/src/experiments/stats.ts';
import { fitHoltWinters, forecastAt, forecastWithIntervals, seasonalNaive } from '../apps/api/src/commerce/forecast.ts';
import { CountMinSketch, HyperLogLog, TDigest } from '../apps/api/src/olap/sketches.ts';
import { trustInto, capacityAt } from '../apps/api/src/kg/trust-flow.ts';
import { emptyTransitions, nextItems, observeSession } from '../apps/api/src/kg/session-graph.ts';

const seeded = seed => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const say = (name, value) => console.log(`${name.padEnd(58)} ${value}`);
const f = (x, d = 4) => x.toFixed(d);
const time = run => {
  const t = performance.now();
  const value = run();
  return { value, ms: performance.now() - t };
};

// Calibration: raw vs isotonic vs Platt (a fitted sigmoid on logit).
{
  const r = seeded(1);
  const make = n => {
    const s = new Float64Array(n),
      y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      s[i] = r();
      y[i] = r() < s[i] ** 2 ? 1 : 0;
    }
    return { s, y };
  };
  const tr = make(100_000),
    te = make(100_000);
  const iso = fitIsotonic(tr.s, tr.y);
  let a = 1,
    b = 0;
  const logit = p => Math.log(Math.max(1e-6, p) / Math.max(1e-6, 1 - p));
  for (let e = 0; e < 200; e++) {
    let ga = 0,
      gb = 0;
    for (let i = 0; i < 5000; i++) {
      const z = logit(tr.s[i]);
      const p = 1 / (1 + Math.exp(-(a * z + b)));
      ga += (tr.y[i] - p) * z;
      gb += tr.y[i] - p;
    }
    a += (0.5 * ga) / 5000;
    b += (0.5 * gb) / 5000;
  }
  say('Calibration ECE: raw', f(expectedCalibrationError(te.s, te.y)));
  say(
    'Calibration ECE: Platt',
    f(
      expectedCalibrationError(
        te.s.map(v => 1 / (1 + Math.exp(-(a * logit(v) + b)))),
        te.y,
      ),
    ),
  );
  say(
    'Calibration ECE: isotonic (shipped)',
    f(
      expectedCalibrationError(
        te.s.map(v => calibrate(iso, v)),
        te.y,
      ),
    ),
  );
  const t = time(() => {
    let x = 0;
    for (let i = 0; i < 1_000_000; i++) x += calibrate(iso, te.s[i % te.s.length]);
    return x;
  });
  say('Calibration lookup, ns each', f(t.ms, 0));
}

// Pacing: none, on/off, primal-dual. Spend tracks the traffic curve; lower error is smoother.
{
  const hourly = Array.from({ length: 24 }, (_, h) => 1 + Math.sin(((h - 6) / 24) * 2 * Math.PI) * 0.8);
  const curve = trafficCurve(hourly);
  const total = hourly.reduce((a, b) => a + b, 0);
  const run = mode => {
    let spent = 0,
      s = INITIAL_PACER,
      err = 0;
    for (let step = 0; step < 288; step++) {
      const x = step / 288;
      const target = targetShare(curve, x);
      const k =
        mode === 'pd' ? pacedBid(1000, s.lambda) / 1000 : mode === 'onoff' ? (spent / 1000 <= x + 0.1 ? 1 : 0) : 1;
      spent = Math.min(1000, spent + (hourly[Math.floor(x * 24)] * 3 * 1000 * k * 24) / 288 / total);
      s = stepPacer(s, spent / 1000, target);
      err += Math.abs(spent / 1000 - targetShare(curve, (step + 1) / 288));
    }
    return { spent, err: err / 288 };
  };
  for (const [name, m] of [
    ['no pacing', 'none'],
    ['on/off (what served)', 'onoff'],
    ['primal-dual (shipped)', 'pd'],
  ]) {
    const o = run(m);
    say(`Pacing mean error, ${name}`, `${f(o.err)} (spent ${f(o.spent / 10, 1)}%)`);
  }
}

// Delayed feedback.
{
  const r = seeded(2),
    x = Float64Array.of(1),
    data = [];
  let naive = 0;
  for (let i = 0; i < 20_000; i++) {
    const elapsed = r() * 14,
      delay = -Math.log(1 - r()) * 7;
    if (r() < 0.3 && delay <= elapsed) {
      data.push({ x, delay, elapsed });
      naive += 1;
    } else data.push({ x, delay: null, elapsed });
  }
  const m = time(() => fitDelayedFeedback(data, 1, { epochs: 30, rate: 0.005 }));
  say('CVR, truth 0.300: unsold clicks as "no"', f(naive / 20_000, 3));
  say('CVR, truth 0.300: delayed feedback (shipped)', f(predictConversion(m.value, x), 3));
}

// Doubly robust vs IPS.
{
  const r = seeded(3),
    v = 0.5,
    ips = [],
    dr = [];
  for (let t = 0; t < 400; t++) {
    const log = [];
    for (let i = 0; i < 500; i++) {
      const shown = r() < 0.1,
        rw = shown && r() < v ? 1 : 0;
      log.push({
        reward: rw,
        propensity: shown ? 0.1 : 0.9,
        examination: 1,
        target: shown ? 1 : 0,
        predicted: shown ? 0.45 : 0,
        targetValue: 0.45,
      });
    }
    ips.push(ipsValue(log));
    dr.push(doublyRobustValue(log, 20));
  }
  const rmse = a => Math.sqrt(a.reduce((s, x) => s + (x - v) ** 2, 0) / a.length);
  say('Off-policy RMSE: IPS', f(rmse(ips)));
  say('Off-policy RMSE: doubly robust (shipped)', f(rmse(dr)));
}

// Bandits.
{
  const regret = pick => {
    const r = seeded(4),
      arms = [newArm(4), newArm(4), newArm(4)],
      normal = normalFrom(r);
    let total = 0;
    for (let t = 0; t < 20_000; t++) {
      const x = [1, r(), r(), r()];
      const p = [0.3 + 0.2 * x[1], 0.3 + 0.2 * x[2], 0.2 + 0.4 * x[3]];
      const i = pick(arms, x, r, normal);
      total += Math.max(...p) - p[i];
      update(arms[i], x, r() < p[i] ? 1 : 0);
    }
    return total;
  };
  const best = v => v.indexOf(Math.max(...v));
  say(
    'Bandit regret over 20,000: uniform',
    f(
      regret((_a, _x, r) => Math.floor(r() * 3)),
      0,
    ),
  );
  say(
    'Bandit regret: LinUCB α=0.5',
    f(
      regret((a, x) => best(a.map(m => ucb(m, x, 0.5)))),
      0,
    ),
  );
  say(
    'Bandit regret: Thompson',
    f(
      regret((a, x, _r, n) => best(a.map(m => thompson(m, x, 0.25, n)))),
      0,
    ),
  );
  const arm = newArm(32),
    x = Array.from({ length: 32 }, (_, i) => i / 32);
  const t = time(() => {
    for (let i = 0; i < 10_000; i++) update(arm, x, 1);
  });
  say('LinUCB update, d=32, µs each', f(t.ms / 10, 1));
}

// Uplift.
{
  const r = seeded(5);
  const rows = n =>
    Array.from({ length: n }, () => {
      const a = r(),
        treated = r() < 0.2;
      return {
        x: [a, a > 0.5 ? 1 : 0],
        treated,
        y: 0.2 + 0.1 * a + (treated ? (a > 0.5 ? 0.3 : -0.2) : 0) + (r() - 0.5) * 0.3,
      };
    });
  const tr = rows(4000),
    te = rows(4000);
  const two = fitTwoModel(tr),
    xl = fitXLearner(tr);
  say('Uplift Qini: two-model', f(qini(te.map(t => ({ score: two(t.x), treated: t.treated, y: t.y }))).qini));
  say(
    'Uplift Qini: X-learner (shipped)',
    f(qini(te.map(t => ({ score: effect(xl, t.x), treated: t.treated, y: t.y }))).qini),
  );
}

// Experiments.
{
  const r = seeded(6),
    g = normalFrom(r),
    n = 20_000;
  const x = new Float64Array(n),
    y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = g();
    y[i] = 0.8 * x[i] + 0.6 * g();
  }
  say('CUPED variance left, ρ=0.8 (theory 0.36)', f(variance(cupedAdjust(y, x, cupedTheta(y, x), 0)) / variance(y), 3));
  let m = 0,
    t = 0;
  for (let s = 0; s < 2000; s++) {
    let sum = 0,
      p = 1,
      fired = false;
    for (let k = 1; k <= 1000; k++) {
      sum += g() * Math.SQRT2;
      if (k % 10) continue;
      p = nextAlwaysValidP(p, msprtLikelihood(k, sum / k, 2, 0.1));
      if (Math.abs(sum / k) / Math.sqrt(2 / k) > 1.96) fired = true;
    }
    if (p < 0.05) m += 1;
    if (fired) t += 1;
  }
  say('A/A false positives under peeking: repeated t-test', f(t / 2000, 3));
  say('A/A false positives under peeking: mSPRT (shipped)', f(m / 2000, 3));
}

// Forecast.
{
  let hw = 0,
    naive = 0,
    cover = 0,
    total = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const r = seeded(seed);
    const y = Array.from(
      { length: 180 },
      (_, t) => 100 + 0.2 * t + 20 * Math.sin((2 * Math.PI * t) / 7) + (r() - 0.5) * 16,
    );
    const train = y.slice(0, 150);
    const { model } = fitHoltWinters(train);
    const ints = forecastWithIntervals(train, 30);
    for (let h = 1; h <= 30; h++) {
      hw += Math.abs(y[149 + h] - forecastAt(model, h));
      naive += Math.abs(y[149 + h] - seasonalNaive(train, h));
      total += 1;
      if (y[149 + h] >= ints[h - 1].low && y[149 + h] <= ints[h - 1].high) cover += 1;
    }
  }
  say('Forecast MAE, 30 days: seasonal naive', f(naive / total, 2));
  say('Forecast MAE: Holt-Winters damped (shipped)', f(hw / total, 2));
  say('Conformal 90% interval, measured coverage', f(cover / total, 3));
}

// Sketches, against exact.
{
  const n = 1_000_000;
  const h = new HyperLogLog(),
    c = new CountMinSketch(),
    d = new TDigest(),
    r = seeded(7),
    set = new Set(),
    values = new Float64Array(n);
  const hl = time(() => {
    for (let i = 0; i < n; i++) h.add(`u${String(i)}`);
  });
  const ex = time(() => {
    for (let i = 0; i < n; i++) set.add(`u${String(i)}`);
  });
  say(
    'HLL error at 1,000,000',
    `${f((Math.abs(h.count() - n) / n) * 100, 2)}%, ${String(h.toBytes().length)} bytes, ${f(hl.ms, 0)} ms (exact Set: ${f(ex.ms, 0)} ms, ~${f((set.size * 40) / 1e6, 0)} MB)`,
  );
  for (let i = 0; i < n; i++) {
    values[i] = -Math.log(1 - r()) * 100;
    d.add(values[i]);
    c.add(String(Math.floor(values[i] / 10)));
  }
  const sorted = Float64Array.from(values).sort();
  for (const q of [0.5, 0.99, 0.999])
    say(
      `t-digest relative error at q=${String(q)}`,
      `${f((Math.abs(d.quantile(q) - sorted[Math.floor(q * n)]) / sorted[Math.floor(q * n)]) * 100, 3)}%`,
    );
  say('t-digest bytes, 1,000,000 values', String(d.toBytes().length));
}

// Trust.
{
  for (const sybils of [100, 10_000]) {
    const edges = [
      [0, 1],
      [1, 2],
    ];
    for (let i = 0; i < sybils; i++) {
      edges.push([2, 3 + i]);
      edges.push([3 + i, 3 + ((i + 1) % sybils)]);
    }
    const t = time(() =>
      trustInto(
        3 + sybils,
        edges,
        [0],
        Array.from({ length: sybils }, (_, i) => 3 + i),
      ),
    );
    say(
      `Trust into a clique of ${String(sybils)} (bound ${String(capacityAt(2))})`,
      `${f(t.value, 1)} in ${f(t.ms, 1)} ms`,
    );
  }
}

// Session graph: order 2 with backoff vs order 1, on sessions that depend on the last two steps.
{
  const r = seeded(8),
    sim = () => {
      const a = r() < 0.5 ? 'visa' : 'car';
      return [a, 'flight', a === 'visa' ? (r() < 0.9 ? 'hotel' : 'food') : r() < 0.9 ? 'insurance' : 'food'];
    };
  const t = emptyTransitions();
  for (let i = 0; i < 10_000; i++) observeSession(t, sim());
  let first = 0,
    second = 0;
  for (let i = 0; i < 10_000; i++) {
    const [a, b, c] = sim();
    if (nextItems(t, b, null)[0]?.item === c) first += 1;
    if (nextItems(t, b, a)[0]?.item === c) second += 1;
  }
  say('Next-item accuracy: first order', f(first / 10_000, 3));
  say('Next-item accuracy: second order with backoff (shipped)', f(second / 10_000, 3));
}
