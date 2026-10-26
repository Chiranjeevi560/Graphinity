#!/usr/bin/env node
// Should click rates be learned (docs/adr/0022-advertising-platform.md part 5)?
// Simulated ad logs with known true click probabilities: each impression's
// chance of a click depends on its campaign, where it shows (search or
// question), its topic, the hour, and how well the campaign fits the topic
// (an interaction a per-campaign average can't see). Compared on the last
// 20% of impressions (a time split, as serving would face it):
// - today's estimate: each campaign's clicks shrunk toward a 2% prior;
// - FTRL-Proximal on hashed features, learned online in time order;
// by log loss (lower is better), AUC, calibration (expected calibration error
// over 10 bins), and the 95% paired bootstrap of the log-loss difference.
// Also how much the auction would earn and how well it would choose, given
// each estimate, against the truth.
//
//   node scripts/benchmark-ad-ctr.mjs [impressions]   (default 200000)
import { createFtrl, learn, logLoss, predict } from '../apps/api/src/ml/ftrl.ts';
import { shrunkCtr } from '../apps/api/src/ads/auction.ts';
import { gaussian, seededRandom } from '../apps/api/src/ml/linalg.ts';

const N = Number(process.argv[2] ?? 200_000);
const r = seededRandom(3);
const g = gaussian(r);
const CAMPAIGNS = 300;
const FIELDS = 20;
const campaigns = Array.from({ length: CAMPAIGNS }, () => ({
  base: -4.2 + 0.6 * g(),
  home: Math.floor(r() * FIELDS),
  search: 0.3 * g(),
}));
const sigmoid = x => 1 / (1 + Math.exp(-x));
const events = [];
for (let t = 0; t < N; t++) {
  const c = Math.floor(r() * CAMPAIGNS);
  const k = campaigns[c];
  const field = r() < 0.6 ? k.home : Math.floor(r() * FIELDS);
  const placement = r() < 0.6 ? 'search' : 'question';
  const hour = Math.floor((t / N) * 24 * 14) % 24;
  const truth = sigmoid(
    k.base +
      (placement === 'search' ? 0.4 + k.search : 0) +
      (field === k.home ? 0.9 : -0.3) +
      0.25 * Math.sin((hour / 24) * 2 * Math.PI),
  );
  events.push({ c, field, placement, hour, truth, clicked: r() < truth });
}
const features = e => [
  `c:${e.c}`,
  `p:${e.placement}`,
  `f:${e.field}`,
  `h:${e.hour}`,
  `cf:${e.c}:${e.field}`,
  `cp:${e.c}:${e.placement}`,
];

const split = Math.floor(N * 0.8);
const stats = Array.from({ length: CAMPAIGNS }, () => ({ imp: 0, clk: 0 }));
const model = createFtrl({
  alpha: Number(process.env.ALPHA ?? 0.2),
  beta: 1,
  l1: Number(process.env.L1 ?? 1),
  l2: Number(process.env.L2 ?? 1),
  bits: 20,
});
const started = performance.now();
for (let t = 0; t < split; t++) {
  const e = events[t];
  stats[e.c].imp++;
  if (e.clicked) stats[e.c].clk++;
  learn(model, features(e), e.clicked);
}
const trainMs = performance.now() - started;
const test = events.slice(split);
const baseline = test.map(e => shrunkCtr(stats[e.c].clk, stats[e.c].imp, 0.02, 200));
const learned = test.map(e => predict(model, features(e)));
const clicks = test.map(e => e.clicked);

function auc(p, y) {
  const order = p.map((v, i) => [v, y[i]]).sort((a, b) => a[0] - b[0]);
  let rank = 0,
    pos = 0,
    sum = 0;
  for (const [, yy] of order) {
    rank++;
    if (yy) {
      pos++;
      sum += rank;
    }
  }
  const neg = order.length - pos;
  return pos && neg ? (sum - (pos * (pos + 1)) / 2) / (pos * neg) : 0.5;
}
function ece(p, y) {
  const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
  const max = p.reduce((m, v) => (v > m ? v : m), 0);
  p.forEach((v, i) => {
    const b = bins[Math.min(9, Math.floor((v / max) * 10))];
    b.n++;
    b.p += v;
    b.y += y[i] ? 1 : 0;
  });
  return bins.reduce((s, b) => s + (b.n ? (b.n / p.length) * Math.abs(b.p / b.n - b.y / b.n) : 0), 0);
}
function bootstrap(a, b, y, samples = 1000) {
  const loss = (p, i) => {
    const q = Math.min(1 - 1e-12, Math.max(1e-12, p[i]));
    return y[i] ? -Math.log(q) : -Math.log(1 - q);
  };
  const d = y.map((_, i) => loss(b, i) - loss(a, i));
  const rr = seededRandom(7);
  const means = [];
  for (let s = 0; s < samples; s++) {
    let sum = 0;
    for (let i = 0; i < d.length; i++) sum += d[Math.floor(rr() * d.length)];
    means.push(sum / d.length);
  }
  means.sort((x, z) => x - z);
  return { mean: d.reduce((s, x) => s + x, 0) / d.length, low: means[25], high: means[974] };
}
// The auction's quality: for groups of 4 competing impressions with equal bids, how often the
// estimate picks the ad truly most likely to be clicked.
function choosesBest(p) {
  let right = 0,
    groups = 0;
  for (let i = 0; i + 4 <= test.length; i += 4) {
    groups++;
    const best = [0, 1, 2, 3].reduce((a, b) => (test[i + b].truth > test[i + a].truth ? b : a), 0);
    const pick = [0, 1, 2, 3].reduce((a, b) => (p[i + b] > p[i + a] ? b : a), 0);
    if (best === pick) right++;
  }
  return right / groups;
}
const truth = test.map(e => e.truth);
const report = p => ({
  logLoss: +logLoss(p, clicks).toFixed(5),
  auc: +auc(p, clicks).toFixed(4),
  ece: +ece(p, clicks).toFixed(5),
  choosesBestOf4: +choosesBest(p).toFixed(3),
});
console.log(
  JSON.stringify(
    {
      impressions: N,
      test: test.length,
      clickRate: +(clicks.filter(Boolean).length / test.length).toFixed(4),
      oracle: report(truth),
      shrunkPerCampaign: report(baseline),
      ftrl: { ...report(learned), trainMs: Math.round(trainMs) },
      ftrlMinusShrunkLogLoss95: bootstrap(baseline, learned, clicks),
    },
    null,
    1,
  ),
);
