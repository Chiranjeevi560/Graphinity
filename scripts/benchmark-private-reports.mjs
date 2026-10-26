#!/usr/bin/env node
// What do private reports cost in accuracy, and what do they protect
// (docs/adr/0022-advertising-platform.md part 8)?
// 1. Accuracy: for campaign-days of different sizes, the median relative
//    error of the noisy impression, click and conversion counts, and how
//    often the cell is suppressed.
// 2. Protection: a business that knows everything except whether one
//    particular person tapped (the strongest attacker differential privacy
//    considers) sees the noisy click count and guesses. Its best accuracy is
//    bounded by e^ε / (1 + e^ε) for that metric's ε; measured over many
//    independently seeded cells, against the bound, and against what it
//    would get from exact counts (always right).
//
//   node scripts/benchmark-private-reports.mjs
import { CLIP, EPSILON_PER_METRIC, noisyCount, privateCells } from '../apps/api/src/ads/privacy.ts';

const secret = Buffer.from('benchmark-secret-benchmark-secret');
const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const accuracy = {};
for (const people of [25, 100, 1_000, 10_000, 100_000]) {
  const impressions = people * 4;
  const clicks = Math.round(impressions * 0.03);
  const conversions = Math.round(clicks * 0.1);
  const rel = { impressions: [], clicks: [], conversions: [] };
  let suppressed = 0;
  const trials = 2000;
  for (let t = 0; t < trials; t++) {
    const { cells } = privateCells(
      `c${String(t)}`,
      'day',
      [{ value: 'd', day: 'd', people, impressions, clicks, conversions }],
      secret,
    );
    const [c] = cells;
    if (!c) {
      suppressed++;
      continue;
    }
    rel.impressions.push(Math.abs(c.impressions - impressions) / impressions);
    if (clicks) rel.clicks.push(Math.abs(c.clicks - clicks) / clicks);
    if (conversions) rel.conversions.push(Math.abs(c.conversions - conversions) / conversions);
  }
  accuracy[people] = {
    trueImpressions: impressions,
    trueClicks: clicks,
    trueConversions: conversions,
    suppressedShare: +(suppressed / trials).toFixed(3),
    medianRelativeError: Object.fromEntries(
      Object.entries(rel).map(([k, v]) => [k, v.length ? +median(v).toFixed(3) : null]),
    ),
  };
}

// The attacker: 40 clicks from everyone else, plus 0 or 3 (CLIP.clicks) from the target.
const base = 40;
let right = 0;
const n = 50_000;
for (let t = 0; t < n; t++) {
  const inIt = t % 2 === 0;
  const shown = noisyCount(base + (inIt ? CLIP.clicks : 0), 'clicks', secret, `attack${String(t)}`);
  // The best test for Laplace noise: is it nearer base + Δ than base?
  const guess = shown >= base + CLIP.clicks / 2;
  if (guess === inIt) right++;
}
const bound = Math.exp(EPSILON_PER_METRIC) / (1 + Math.exp(EPSILON_PER_METRIC));
console.log(
  JSON.stringify(
    {
      epsilonPerMetric: EPSILON_PER_METRIC,
      clipping: CLIP,
      accuracy,
      attack: {
        trials: n,
        attackerAccuracy: +(right / n).toFixed(4),
        theoreticalBound: +bound.toFixed(4),
        withExactCounts: 1,
      },
    },
    null,
    1,
  ),
);
