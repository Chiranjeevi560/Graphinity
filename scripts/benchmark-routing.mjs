#!/usr/bin/env node
// Benchmarks learned routing (ADR 0013) on simulated histories with known
// truth (apps/api/src/ml/routing-simulator.ts):
//   - 'availability': helping depends on being available, which Ψ under-weighs.
//     How much better than Ψ does the learned model rank the people who help,
//     and from how many questions is it promoted?
//   - 'psi': outcomes come from Ψ itself. How often does the gate wrongly
//     promote? (It should be about never.)
// Also: training time, peak memory, scoring latency, artifact size.
//
//   node --expose-gc scripts/benchmark-routing.mjs
//
// A simulation says whether the learner and the gate behave as designed; it
// can't say how real people respond.
import { simulateRouting } from '../apps/api/src/ml/routing-simulator.ts';
import { scoreRouting, trainRoutingModel } from '../apps/api/src/ml/routing-model.ts';
import { trainRoutingAndEvaluate } from '../apps/api/src/ml/train-routing.ts';

const rows = [];
for (const world of ['availability', 'psi']) {
  for (const questions of [300, 1000, 3000]) {
    let promoted = 0;
    const gains = [];
    const times = [];
    const seeds = world === 'psi' ? 10 : 3;
    for (let seed = 1; seed <= seeds; seed++) {
      const examples = simulateRouting({ questions, world, seed });
      const t = performance.now();
      const r = trainRoutingAndEvaluate({ examples, serving: null, since: null });
      times.push(performance.now() - t);
      if (r.decision.promote) promoted++;
      gains.push(r.decision.candidateAuc - r.decision.psiAuc);
    }
    rows.push({
      world,
      questions,
      runs: seeds,
      promoted,
      meanAucGain: +(gains.reduce((s, x) => s + x, 0) / gains.length).toFixed(3),
      runMs: Math.round(times.reduce((s, x) => s + x, 0) / times.length),
    });
  }
}
console.table(rows);

// Cost at the most a run reads (50,000 routes), and the per-candidate cost of serving.
global.gc?.();
const before = process.memoryUsage().heapUsed;
const big = simulateRouting({ questions: 6500, world: 'availability', seed: 9 }).slice(0, 50_000);
const t0 = performance.now();
const model = trainRoutingModel(big);
const trainMs = performance.now() - t0;
const heapMB = (process.memoryUsage().heapUsed - before) / 1e6;
const times = [];
for (const e of big.slice(0, 20_000)) {
  const t = performance.now();
  scoreRouting(model, e.factors);
  times.push(performance.now() - t);
}
times.sort((a, b) => a - b);
const pct = q => +(times[Math.floor(q * times.length)] * 1000).toFixed(2);
console.log(
  JSON.stringify({
    routes: big.length,
    trainMs: Math.round(trainMs),
    heapGrowthMB: +heapMB.toFixed(1),
    artifactBytes: JSON.stringify(model).length,
    scoreMicroseconds: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) },
  }),
);
