#!/usr/bin/env node
// Which attribution model tells advertisers the truth (docs/adr/0022-advertising-platform.md
// part 6b)? Simulated journeys with known causes: people see some of 8
// campaigns over two weeks. Each campaign truly raises the chance of buying
// by its own lift, and some campaigns are shown late, mostly to people
// already likely to buy (as retargeting is), while adding little. The truth
// is each campaign's incremental conversions: how many fewer there would be
// without it (measured by re-running the same people without it). Each model
// is scored by how far its credit share is from the true share (total
// absolute error, 0 is perfect, 2 is as wrong as can be).
//
//   node scripts/benchmark-attribution.mjs [people]   (default 50000)
import { attribute, RULE_MODELS, ruleCredit, shapleyModel } from '../apps/api/src/ads/attribution.ts';
import { seededRandom } from '../apps/api/src/ml/linalg.ts';
import { lift } from '../apps/api/src/ads/lift.ts';

const PEOPLE = Number(process.argv[2] ?? 50_000);
const DAY = 86_400_000;
// Lift on the log-odds of buying; `late` campaigns are shown near the end to people already likely to buy.
const CAMPAIGNS = [
  { id: 'search-brand', lift: 0.9, reach: 0.35, late: false },
  { id: 'question-tips', lift: 0.7, reach: 0.3, late: false },
  { id: 'video-awareness', lift: 0.5, reach: 0.4, late: false },
  { id: 'topic-travel', lift: 0.4, reach: 0.25, late: false },
  { id: 'interest-money', lift: 0.3, reach: 0.25, late: false },
  { id: 'country-in', lift: 0.2, reach: 0.3, late: false },
  { id: 'retarget-a', lift: 0.05, reach: 0.5, late: true },
  { id: 'retarget-b', lift: 0.02, reach: 0.4, late: true },
];
const sigmoid = x => 1 / (1 + Math.exp(-x));

/** `holdout`: per campaign, a random 10% of the people it would reach don't see it, and who they are is recorded. */
function simulate(seed, without = null, holdout = false) {
  const r = seededRandom(seed);
  const paths = [];
  for (let p = 0; p < PEOPLE; p++) {
    const intent = -3 + 1.5 * (r() - 0.5) * 2;
    const touches = [];
    let logit = intent;
    for (const c of CAMPAIGNS) {
      // Every draw happens whether or not the campaign is left out, so the same people get the same luck.
      const reachDraw = r();
      const timeDraw = r();
      const reach = c.late ? c.reach * sigmoid(intent + 2) * 2 : c.reach;
      const held = holdout && seededRandom(p * 131 + CAMPAIGNS.indexOf(c) + 7)() < 0.1;
      const setOf = (m, id) => m.get(id) ?? m.set(id, new Set()).get(id);
      if (reachDraw < reach && held) setOf(heldOutOf, c.id).add(p);
      if (reachDraw < reach && (held || c.id !== without)) setOf(eligible, c.id).add(p);
      if (reachDraw < reach && c.id !== without && !held) {
        touches.push({ campaign: c.id, at: c.late ? (12 + 2 * timeDraw) * DAY : timeDraw * 12 * DAY });
        logit += c.lift;
      }
    }
    const buyDraw = r();
    paths.push({ touches, converted: buyDraw < sigmoid(logit), at: 14 * DAY });
  }
  return paths;
}

const heldOutOf = new Map();
const eligible = new Map();
const world = simulate(1);
const total = world.filter(p => p.converted).length;
const truth = new Map(
  CAMPAIGNS.map(c => [c.id, Math.max(0, total - simulate(1, c.id).filter(p => p.converted).length)]),
);
const share = m => {
  const sum = [...m.values()].reduce((s, x) => s + x, 0);
  return new Map(CAMPAIGNS.map(c => [c.id, sum ? (m.get(c.id) ?? 0) / sum : 0]));
};
const trueShare = share(truth);
const error = m => {
  const s = share(m);
  return +CAMPAIGNS.reduce((e, c) => e + Math.abs((s.get(c.id) ?? 0) - (trueShare.get(c.id) ?? 0)), 0).toFixed(3);
};
const results = {};
for (const model of RULE_MODELS) results[model] = attribute(world, p => ruleCredit(p, model));
const started = performance.now();
results.data_driven = attribute(world, shapleyModel(world));
const shapleyMs = Math.round(performance.now() - started);
// The holdout experiment: the same people, with each campaign held out of a random 10% of its reach.
heldOutOf.clear();
eligible.clear();
const experiment = simulate(1, null, true);
const estimated = new Map();
const lifts = {};
for (const c of CAMPAIGNS) {
  const reached = eligible.get(c.id) ?? new Set();
  const held = heldOutOf.get(c.id) ?? new Set();
  let exposedPeople = 0,
    exposedConversions = 0,
    holdoutPeople = 0,
    holdoutConversions = 0;
  for (const p of reached) {
    const converted = experiment[p].converted;
    if (held.has(p)) {
      holdoutPeople++;
      if (converted) holdoutConversions++;
    } else {
      exposedPeople++;
      if (converted) exposedConversions++;
    }
  }
  const l = lift({ exposedPeople, exposedConversions, holdoutPeople, holdoutConversions });
  lifts[c.id] = l ? { incremental: Math.round(l.incremental), significant: l.significant } : null;
  estimated.set(c.id, Math.max(0, l?.incremental ?? 0));
}
results.holdout_experiment = estimated;
console.log(
  JSON.stringify(
    {
      people: PEOPLE,
      conversions: total,
      trueShare: Object.fromEntries([...trueShare].map(([k, v]) => [k, +v.toFixed(3)])),
      errorByModel: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, error(v)])),
      retargetingShareByModel: Object.fromEntries(
        Object.entries(results).map(([k, v]) => {
          const s = share(v);
          return [k, +((s.get('retarget-a') ?? 0) + (s.get('retarget-b') ?? 0)).toFixed(3)];
        }),
      ),
      trueRetargetingShare: +((trueShare.get('retarget-a') ?? 0) + (trueShare.get('retarget-b') ?? 0)).toFixed(3),
      shapleyMs,
      holdoutLifts: lifts,
    },
    null,
    1,
  ),
);
