#!/usr/bin/env node
// Chooses routing's exploration policy by measurement (ADR 0014): an online
// simulation (apps/api/src/ml/routing-online-sim.ts) of 30 days, 30 questions
// a day, people joining daily, nightly retraining (λ fixed at 1 to keep the
// sweep tractable; production cross-validates λ). Every policy fills the same
// four exploit places; only the last place differs, and every policy uses the
// newcomer place until the first model exists.
//
//   node scripts/benchmark-exploration.mjs [seeds]   (default 12)
//
// Two worlds: 'independent' (each person can help) and 'competing' (the
// asker picks one answer; value is the chance anyone helps). For each policy:
// mean regret against an oracle; the paired difference from greedy with its
// standard error (same seeds); the last place's cost per question; how much it
// explores; hidden experts reached and used; time per decision. Rivals are tuned
// over small grids (ε ∈ {0.05, 0.1, 0.2}, α ∈ {0.5, 1, 2}) and reported at their best.
import { simulateOnline } from '../apps/api/src/ml/routing-online-sim.ts';

const seeds = Number(process.argv[2] ?? 12);
const variants = [
  { name: 'greedy', policy: 'greedy' },
  { name: 'newcomer place (today)', policy: 'psi-newcomer' },
  ...[0.05, 0.1, 0.2].map(epsilon => ({ name: `ε-greedy ε=${epsilon}`, policy: 'epsilon', epsilon })),
  ...[0.5, 1, 2].map(alpha => ({ name: `GLM-UCB α=${alpha}`, policy: 'glm-ucb', alpha })),
  { name: 'Thompson, ungated', policy: 'thompson' },
  { name: 'Thompson, gated', policy: 'thompson-gated' },
];
const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length;
const se = xs => Math.sqrt(mean(xs.map(x => (x - mean(xs)) ** 2)) / Math.max(1, xs.length - 1));
for (const world of ['independent', 'competing']) {
  const runs = new Map(variants.map(v => [v.name, []]));
  for (let seed = 1; seed <= seeds; seed++)
    for (const v of variants)
      runs.get(v.name).push(simulateOnline({ ...v, days: 30, questionsPerDay: 30, seed, world }));
  const greedy = runs.get('greedy');
  console.log(`\n${world} (${seeds} seeds)`);
  console.table(
    variants.map(v => {
      const r = runs.get(v.name);
      const diffs = r.map((x, i) => x.regret - greedy[i].regret);
      return {
        policy: v.name,
        regret: +mean(r.map(x => x.regret)).toFixed(1),
        vsGreedy: `${mean(diffs).toFixed(1)} ± ${se(diffs).toFixed(1)}`,
        lastPlaceCost: +mean(r.map(x => (x.greedyLastPlace - x.lastPlace) / x.questions)).toFixed(4),
        explorePct: +mean(r.map(x => (100 * x.explorations) / x.questions)).toFixed(1),
        gemsReached: +mean(r.map(x => x.gemsReached)).toFixed(2),
        gemsUsed: +mean(r.map(x => x.gemsExploited)).toFixed(2),
        decisionMs: +mean(r.map(x => x.decisionMs / x.questions)).toFixed(2),
      };
    }),
  );
}
