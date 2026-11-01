#!/usr/bin/env node
// The algorithms the charter asked to be evaluated, each against what would otherwise serve (ADR 0032).
//   node scripts/benchmark-ranking-evaluated.mjs
// All on synthetic data with a seed: Graphinity has no real traffic, so these show whether an algorithm works and what
// it costs, never what it would do for real people.
import { dppGreedy, mmr } from '../apps/api/src/ml/diversity.ts';
import { doubleMl } from '../apps/api/src/ml/double-ml.ts';
import { seededRandom } from '../apps/api/src/ml/linalg.ts';
import { predictMmoe, trainMmoe } from '../apps/api/src/ml/mmoe.ts';
import { encodePq, encodeSq8, pqTable, scorePq, scoreSq8, trainPq, trainSq8 } from '../apps/api/src/ml/quantize.ts';
import { topItems, trainTwoTower } from '../apps/api/src/ml/two-tower.ts';
import { fitTwoModel } from '../apps/api/src/ml/uplift.ts';

const time = work => {
  const t = performance.now();
  const value = work();
  return [value, performance.now() - t];
};
const round = (x, d = 3) => Number(x.toFixed(d));
const unit = v => {
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
};

function diversity() {
  // Results fall into topics; each topic is one thing said several ways. A reader gains from the first result of a
  // topic, far less from the next. Gain: sum over topics of relevance of the first, discounted by rank.
  const random = seededRandom(1);
  const trial = pick => {
    let gain = 0;
    let topics = 0;
    let ms = 0;
    for (let t = 0; t < 200; t++) {
      const centres = Array.from({ length: 8 }, () => unit(Array.from({ length: 32 }, () => random() - 0.5)));
      const worth = centres.map((_, i) => 1 / (1 + i * 0.3));
      const items = Array.from({ length: 100 }, () => {
        const topic = Math.floor(random() ** 2 * 8);
        const vector = unit(centres[topic].map(x => x + (random() - 0.5) * 0.1));
        return { topic, relevance: worth[topic] * (0.8 + random() * 0.2), vector };
      });
      const start = performance.now();
      const order = pick(items);
      ms += performance.now() - start;
      const seen = new Set();
      order.forEach((i, rank) => {
        const it = items[i];
        if (!seen.has(it.topic)) {
          seen.add(it.topic);
          gain += it.relevance / Math.log2(rank + 2);
        }
      });
      topics += seen.size;
    }
    return { gain: round(gain / 200), topicsInTen: round(topics / 200, 2), msPerList: round(ms / 200, 3) };
  };
  const byRelevance = items =>
    items
      .map((it, i) => [it.relevance, i])
      .sort((a, b) => b[0] - a[0])
      .slice(0, 10)
      .map(x => x[1]);
  return {
    relevance: trial(byRelevance),
    mmr: Object.fromEntries([0.9, 0.7, 0.5, 0.3].map(l => [`lambda${l}`, trial(items => mmr(items, 10, l))])),
    dpp: Object.fromEntries([0.5, 1, 2, 4].map(th => [`theta${th}`, trial(items => dppGreedy(items, 10, th))])),
  };
}

function quantization() {
  // Clustered unit vectors, 128 dimensions as the meaning index stores.
  const random = seededRandom(2);
  const centres = Array.from({ length: 50 }, () => Array.from({ length: 128 }, () => random() - 0.5));
  const make = () => Float32Array.from(unit(centres[Math.floor(random() * 50)].map(x => x + (random() - 0.5) * 0.6)));
  const base = Array.from({ length: 20000 }, make);
  const queries = Array.from({ length: 100 }, make);
  const exactTop = (q, k) =>
    base
      .map((v, i) => {
        let s = 0;
        for (let d = 0; d < 128; d++) s += q[d] * v[d];
        return [s, i];
      })
      .sort((a, b) => b[0] - a[0])
      .slice(0, k)
      .map(x => x[1]);
  const truth = queries.map(q => new Set(exactTop(q, 10)));
  const recall = scoreAll =>
    queries.reduce((sum, q, n) => {
      const top = scoreAll(q)
        .map((s, i) => [s, i])
        .sort((a, b) => b[0] - a[0])
        .slice(0, 10);
      return sum + top.filter(([, i]) => truth[n].has(i)).length / 10;
    }, 0) / queries.length;
  const sq = trainSq8(base);
  const sqCodes = base.map(v => encodeSq8(sq, v));
  const [sqRecall, sqMs] = time(() => recall(q => sqCodes.map(c => scoreSq8(sq, q, c))));
  const out = {
    halfvecBytes: 128 * 2,
    sq8: { bytes: 128, recallAt10: round(sqRecall), msPerQuery: round(sqMs / 100, 2) },
  };
  for (const parts of [16, 32, 64]) {
    const [pq, trainMs] = time(() => trainPq(base.slice(0, 5000), parts, 8));
    const codes = base.map(v => encodePq(pq, v));
    const [r, ms] = time(() =>
      recall(q => {
        const table = pqTable(pq, q);
        return codes.map(c => scorePq(pq, table, c));
      }),
    );
    out[`pq${parts}`] = {
      bytes: parts,
      recallAt10: round(r),
      msPerQuery: round(ms / 100, 2),
      trainSeconds: round(trainMs / 1000, 1),
    };
  }
  return out;
}

function twoTower() {
  // Zipf-popular items, people with tastes: a held-out next item. Popular items dominate without the correction.
  const random = seededRandom(3);
  const users = 2000;
  const items = 2000;
  const groups = 20;
  const zipf = () => Math.min(99, Math.floor(100 ** random()) - 1);
  const pairs = [];
  const heldOut = [];
  const inGroup = g => g * 100 + zipf();
  for (let u = 0; u < users; u++) {
    const group = u % groups;
    for (let n = 0; n < 30; n++) pairs.push([u, inGroup(group)]);
    heldOut.push(inGroup(group));
  }
  const counts = new Float64Array(items);
  for (const [, i] of pairs) counts[i]++;
  const popular = [...counts.keys()].sort((a, b) => counts[b] - counts[a]);
  const score = model => {
    let hits = 0;
    let rare = 0;
    let rareHits = 0;
    let topsShare = 0;
    const tops = new Set(popular.slice(0, 100));
    for (let u = 0; u < users; u++) {
      const top = model ? topItems(model, u, 10) : popular.slice(0, 10);
      const hit = top.includes(heldOut[u]);
      if (hit) hits++;
      if (!tops.has(heldOut[u])) {
        rare++;
        if (hit) rareHits++;
      }
      topsShare += top.filter(i => tops.has(i)).length / 10;
    }
    return {
      recallAt10: round(hits / users),
      rareRecallAt10: round(rareHits / rare),
      shareOfTop100: round(topsShare / users),
    };
  };
  const options = { users, items, dims: 32, epochs: 5, batch: 256, rate: 0.02 };
  const [plain, plainMs] = time(() => trainTwoTower(pairs, { ...options, logQ: false }));
  const [corrected, correctedMs] = time(() => trainTwoTower(pairs, { ...options, logQ: true }));
  return {
    mostPopular: score(null),
    plain: { ...score(plain), trainSeconds: round(plainMs / 1000, 1) },
    logQ: { ...score(corrected), trainSeconds: round(correctedMs / 1000, 1) },
  };
}

function multitask() {
  // Two tasks sharing part of their signal, a third of labels missing on one (as with dwell or helpfulness).
  const random = seededRandom(4);
  const make = () => {
    const x = Array.from({ length: 10 }, () => random() * 2 - 1);
    const shared = x[0] + x[1] * x[2];
    const p1 = 1 / (1 + Math.exp(-(2 * shared + 2 * x[3])));
    const p2 = 1 / (1 + Math.exp(-(2 * shared - 2 * x[4])));
    return { x, y: [random() < p1 ? 1 : 0, random() < 0.66 ? (random() < p2 ? 1 : 0) : null] };
  };
  const train = Array.from({ length: 6000 }, make);
  const test = Array.from({ length: 4000 }, make);
  const auc = (m, task, head = task) => {
    const rows = test
      .filter(r => r.y[task] !== null)
      .map(r => [predictMmoe(m, r.x, head), r.y[task]])
      .sort((a, b) => a[0] - b[0]);
    let rank = 0;
    let pos = 0;
    rows.forEach(([, y], i) => {
      if (y) {
        rank += i + 1;
        pos++;
      }
    });
    return round((rank - (pos * (pos + 1)) / 2) / (pos * (rows.length - pos)));
  };
  const options = { inputs: 10, tasks: 2, epochs: 12, experts: 4, hidden: 8 };
  const separate = [0, 1].map(t =>
    trainMmoe(
      train.map(r => ({ x: r.x, y: [t === 0 ? r.y[0] : r.y[1]] })),
      { ...options, tasks: 1 },
    ),
  );
  const [shared, sharedMs] = time(() => trainMmoe(train, { ...options, sharedGate: true }));
  const [gated, gatedMs] = time(() => trainMmoe(train, options));
  return {
    separateModels: [auc(separate[0], 0), auc(separate[1], 1, 0)],
    sharedBottom: { auc: [auc(shared, 0), auc(shared, 1)], trainSeconds: round(sharedMs / 1000, 1) },
    mmoe: { auc: [auc(gated, 0), auc(gated, 1)], trainSeconds: round(gatedMs / 1000, 1) },
  };
}

function causal() {
  const random = seededRandom(5);
  const results = { naiveError: 0, twoModelError: 0, doubleMlError: 0, covered: 0 };
  const trials = 40;
  for (let t = 0; t < trials; t++) {
    const rows = Array.from({ length: 2000 }, () => {
      const x = Array.from({ length: 5 }, () => random() * 2 - 1);
      const treatment = random() < 0.5 + 0.35 * x[0] ? 1 : 0;
      return { x, treatment, y: 2 * x[0] + x[1] + 0.5 * treatment + (random() - 0.5) * 2 };
    });
    const mean = list => list.reduce((s, r) => s + r.y, 0) / list.length;
    const naive = mean(rows.filter(r => r.treatment)) - mean(rows.filter(r => !r.treatment));
    const two = fitTwoModel(rows.map(r => ({ x: r.x, y: r.y, treated: r.treatment === 1 })));
    const twoEffect = rows.reduce((s, r) => s + two(r.x), 0) / rows.length;
    const dml = doubleMl(rows);
    results.naiveError += Math.abs(naive - 0.5) / trials;
    results.twoModelError += Math.abs(twoEffect - 0.5) / trials;
    results.doubleMlError += Math.abs(dml.effect - 0.5) / trials;
    if (dml.low <= 0.5 && dml.high >= 0.5) results.covered += 1 / trials;
  }
  return Object.fromEntries(Object.entries(results).map(([k, v]) => [k, round(v)]));
}

const which = process.argv[2];
const all = { diversity, causal, multitask, twoTower, quantization };
for (const [name, run] of Object.entries(all)) {
  if (which && which !== name) continue;
  const [result, ms] = time(run);
  console.log(JSON.stringify({ [name]: result, seconds: round(ms / 1000, 1) }, null, 1));
}
