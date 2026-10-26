#!/usr/bin/env node
// Chooses the drift rule (docs/adr/0018-drift-monitoring.md) by measurement.
// A reference of 10,000 values is profiled; current samples of 200 to
// 100,000 values are drawn either from the same distribution (any flag is a
// false alarm), from a negligibly moved one (flagging it is noise a person
// would learn to ignore) or from a materially moved one (it should be
// flagged). Four feature shapes like Graphinity's: a continuous score, a
// skewed count (log answers), a flag, and a rank feature that is zero 40% of
// the time. Each rule is judged by its worst false-alarm rate, its worst
// negligible-flag rate and its detection rate per sample size.
//
//   node scripts/benchmark-drift.mjs [trials]   (default 200)
import { ksTest, profileOf, psi } from '../apps/api/src/ml/drift.ts';
import { gaussian, seededRandom } from '../apps/api/src/ml/linalg.ts';

const TRIALS = Number(process.argv[2] ?? 200);
const SIZES = [200, 1000, 10_000, 100_000];
const ALPHA = 0.01;

// Each shape: a sampler given an effect: none, small (negligible), medium
// (moderate) or large (material: PSI's own convention calls about 0.25 and
// above significant, which a 0.5 sd move in the mean reaches).
const effect = { none: 0, small: 0.05, medium: 0.25, large: 0.5 };
const shapes = {
  score: (r, g, s) => () => g() + effect[s],
  skewedCount: (r, g, s) => () => Math.log1p(Math.floor(Math.exp(g() * 0.9 + effect[s] * 0.9))),
  flag: (r, g, s) => () => (r() < 0.3 + effect[s] * 0.3 ? 1 : 0),
  zeroInflatedRank: (r, g, s) => () =>
    r() < 0.4 + effect[s] * 0.3 ? 0 : 1 / (60 + 1 + Math.floor(-Math.log(r()) * 20)),
};

const rules = {
  'psi >= 0.25': p => p >= 0.25,
  'psi >= 0.2': p => p >= 0.2,
  'psi >= 0.1': p => p >= 0.1,
  'KS p < 0.01': (_p, k) => k.p < ALPHA,
  'psi >= 0.1 and KS p < 0.01': (p, k) => p >= 0.1 && k.p < ALPHA,
  'psi >= 0.05 and KS p < 0.01 (built)': (p, k) => p >= 0.05 && k.p < ALPHA,
};

const tally = {};
for (const name of Object.keys(rules)) tally[name] = {};
const draw = (sampler, n) => Float64Array.from({ length: n }, sampler);

let seed = 1;
const started = performance.now();
for (const [shape, make] of Object.entries(shapes)) {
  const r0 = seededRandom(seed++);
  const reference = profileOf(draw(make(r0, gaussian(r0), 'none'), 10_000));
  for (const n of SIZES) {
    const trials = n >= 100_000 ? Math.max(20, TRIALS / 5) : TRIALS;
    for (const shift of ['none', 'small', 'medium', 'large']) {
      const r = seededRandom(seed++);
      const sampler = make(r, gaussian(r), shift);
      for (let t = 0; t < trials; t++) {
        const current = draw(sampler, n);
        const p = psi(reference, current);
        const k = ksTest(reference, current);
        for (const [name, rule] of Object.entries(rules)) {
          const key = `${shape}|${String(n)}|${shift}`;
          const cell = (tally[name][key] ??= { flagged: 0, trials: 0 });
          cell.trials++;
          if (rule(p, k)) cell.flagged++;
        }
      }
    }
  }
}

const summary = {};
for (const [name, cells] of Object.entries(tally)) {
  const rate = (shift, n) => {
    const hits = Object.entries(cells).filter(
      ([k]) => k.endsWith(`|${shift}`) && (n === undefined || k.split('|')[1] === String(n)),
    );
    return hits.map(([, c]) => c.flagged / c.trials);
  };
  summary[name] = {
    worstFalseAlarm: +Math.max(...rate('none')).toFixed(3),
    worstNegligibleFlagged: +Math.max(...rate('small')).toFixed(3),
    moderateDetectedBySize: Object.fromEntries(SIZES.map(n => [n, +Math.min(...rate('medium', n)).toFixed(3)])),
    materialDetectedBySize: Object.fromEntries(SIZES.map(n => [n, +Math.min(...rate('large', n)).toFixed(3)])),
  };
}
console.log(
  JSON.stringify(
    {
      trials: TRIALS,
      reference: 10_000,
      shapes: Object.keys(shapes),
      note: 'detected rates are the worst shape at that size',
      seconds: +((performance.now() - started) / 1000).toFixed(1),
      rules: summary,
    },
    null,
    1,
  ),
);
