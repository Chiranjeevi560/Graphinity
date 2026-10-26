#!/usr/bin/env node
// Benchmarks learning a search ranking from clicks (ADR 0015 part 6) in a
// simulated search world with known true relevance, so methods can be judged
// by the truth rather than by more clicks. Each query has 50 candidates with
// the engine's features (word and meaning ranks, similarity, every-word,
// answers and their age); true relevance depends on interactions between
// them. Searchers see the top 20 of today's ranking (equal-weight reciprocal
// rank fusion) and click by a position-based model (Craswell et al. 2008):
// P(click) = P(examined at position k) x P(click | relevance), with
// P(examined) = 1 / k^eta. A long read marks the stronger clicks.
//
// Compared on held-out queries, by NDCG@10 against the true relevance:
// today's fusion; a linear pairwise ranker (RankNet with a linear score) on
// clicks with inverse-propensity weights; LambdaMART on raw clicks; LambdaMART
// with inverse-propensity weights, both the true ones and those estimated from
// production's swaps (interventions.ts), as the training job does; and
// LambdaMART on the true labels, the ceiling.
//
//   node scripts/benchmark-ltr.mjs [searches...]   (default 2000 10000)
//
// Synthetic: it says whether the methods recover a ranking from biased clicks
// and how they compare; it does not predict the gain on real searches.
import { fitLogistic, predict } from '../apps/api/src/ml/logistic.ts';
import { rank, scoreOne, serializeLambdaMart, trainLambdaMart } from '../apps/api/src/ml/lambdamart.ts';
import { seededRandom } from '../apps/api/src/ml/linalg.ts';
import { rankingFeatures } from '../apps/api/src/search/features.ts';
import { ndcgAt, pairedDifference } from '../apps/api/src/search/metrics.ts';
import { applySwap, chooseSwap, clickWeight, estimatePropensities } from '../apps/api/src/search/interventions.ts';

const CANDIDATES = 50;
const SHOWN = 20;
const ETA = 1;
const CLICK = [0.05, 0.4, 0.85];
const LONG_READ = [0, 0.5, 0.8];
const CLIP = 10;

function world(seed) {
  const r = seededRandom(seed);
  const normal = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  return function query() {
    const docs = Array.from({ length: CANDIDATES }, () => {
      const t = r() < 0.06 ? 2 : r() < 0.25 ? 1 : 0;
      const byWords = r() < [0.2, 0.5, 0.8][t];
      const byMeaning = r() < [0.4, 0.7, 0.9][t];
      const similarity = byMeaning ? Math.min(0.99, [0.5, 0.7, 0.85][t] + 0.08 * normal()) : null;
      const everyWord = byWords && r() < [0.05, 0.2, 0.6][t];
      const answers = Math.floor(-Math.log(r() + 1e-12) * 2 * (r() < 0.7 ? 1 : 0));
      const age = answers > 0 ? -Math.log(r() + 1e-12) * 60 : null;
      const rel = t === 2 ? (answers > 0 ? 2 : 1) : t === 1 && age !== null && age < 90 ? 1 : 0;
      return { t, byWords, byMeaning, similarity, everyWord, answers, age, rel, wordScore: t + normal() };
    });
    const wordOrder = docs
      .map((d, i) => ({ d, i }))
      .filter(x => x.d.byWords)
      .sort((a, b) => b.d.wordScore - a.d.wordScore);
    const meaningOrder = docs
      .map((d, i) => ({ d, i }))
      .filter(x => x.d.byMeaning)
      .sort((a, b) => b.d.similarity - a.d.similarity);
    const wordRank = new Map(wordOrder.map((x, k) => [x.i, k + 1]));
    const meaningRank = new Map(meaningOrder.map((x, k) => [x.i, k + 1]));
    const features = docs.map((d, i) =>
      rankingFeatures({
        wordRank: wordRank.get(i) ?? null,
        meaningRank: meaningRank.get(i) ?? null,
        similarity: d.similarity,
        everyWord: d.everyWord,
        answerCount: d.answers,
        answerAgeDays: d.age,
      }),
    );
    const rrf = docs.map((_, i) => {
      const w = wordRank.get(i);
      const m = meaningRank.get(i);
      return (w ? 0.5 / (60 + w) : 0) + (m ? 0.5 / (60 + m) : 0);
    });
    return { features, labels: docs.map(d => d.rel), rrf };
  };
}

function simulateClicks(q, r) {
  const order = q.rrf
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map(x => x.i);
  // As production does: a small share of searches swap one neighbouring pair among the top five.
  const swap = chooseSwap(r, SHOWN);
  const shown = applySwap(
    order.slice(0, SHOWN).map((i, k) => ({ i, ranked: k + 1 })),
    swap,
  );
  const labels = shown.map(({ i }, k) => {
    const examined = r() < 1 / (k + 1) ** ETA;
    if (!examined || r() >= CLICK[q.labels[i]]) return 0;
    return r() < LONG_READ[q.labels[i]] ? 2 : 1;
  });
  return {
    features: shown.map(({ i }) => q.features[i]),
    labels,
    // The true propensity of the position each result was shown at, clipped.
    weights: shown.map((_, k) => Math.min(CLIP, (k + 1) ** ETA)),
    logged: { swap, results: shown.map(({ ranked }, k) => ({ ranked, shown: k + 1, clicked: labels[k] > 0 })) },
  };
}

function linearRanker(queries) {
  const x = [];
  const y = [];
  for (const q of queries)
    for (let i = 0; i < q.labels.length; i++)
      for (let j = 0; j < q.labels.length; j++) {
        if (q.labels[i] <= q.labels[j]) continue;
        const w = q.weights?.[i] ?? 1;
        // Weighted by repeating the pair: logistic regression on feature differences.
        for (let c = 0; c < Math.round(w); c++) {
          x.push(q.features[i].map((v, k) => v - q.features[j][k]));
          y.push(1);
          x.push(q.features[j].map((v, k) => v - q.features[i][k]));
          y.push(0);
        }
      }
  const model = fitLogistic(x, y, 1, { maxIterations: 50 });
  return row => predict(model, row);
}

const ndcgOf = (q, scores) => {
  const order = scores
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map(x => x.i);
  return ndcgAt(
    order.map(i => q.labels[i]),
    10,
    q.labels,
  );
};
const judged = (q, scores, id) => {
  const order = scores
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map(x => x.i);
  return {
    user: String(id),
    relevance: order.map(i => q.labels[i]),
    totalRelevant: q.labels.filter(l => l > 0).length,
  };
};
const round = x => +x.toFixed(4);

const sizes = process.argv.slice(2).map(Number).filter(Boolean);
for (const searches of sizes.length ? sizes : [2000, 10_000]) {
  const make = world(1);
  const r = seededRandom(2);
  const train = Array.from({ length: searches }, () => make());
  const test = Array.from({ length: 1000 }, () => make());
  const clicked = train.map(q => simulateClicks(q, r));
  const naive = clicked.map(({ features, labels }) => ({ features, labels }));
  // Propensities estimated from the swaps, as the training job does, when there are enough clicks.
  const estimated = estimatePropensities(clicked.map(c => c.logged));
  const withEstimated = estimated
    ? clicked.map(c => ({
        features: c.features,
        labels: c.labels,
        weights: c.labels.map((l, k) => (l > 0 ? clickWeight(estimated, k + 1) : 1)),
      }))
    : null;

  let t = performance.now();
  const ips = trainLambdaMart(clicked);
  const trainMs = Math.round(performance.now() - t);
  const raw = trainLambdaMart(naive);
  const estimatedModel = withEstimated ? trainLambdaMart(withEstimated) : null;
  const oracle = trainLambdaMart(train.map(q => ({ features: q.features, labels: q.labels })));
  t = performance.now();
  const linear = linearRanker(clicked.slice(0, Math.min(clicked.length, 3000)));
  const linearMs = Math.round(performance.now() - t);

  const methods = {
    rrf: q => q.rrf,
    linearIps: q => q.features.map(linear),
    lambdaMartRaw: q => q.features.map(row => scoreOne(raw, row)),
    lambdaMartIps: q => q.features.map(row => scoreOne(ips, row)),
    ...(estimatedModel ? { lambdaMartEstimated: q => q.features.map(row => scoreOne(estimatedModel, row)) } : {}),
    lambdaMartOracle: q => q.features.map(row => scoreOne(oracle, row)),
  };
  const runs = Object.fromEntries(Object.entries(methods).map(([k, f]) => [k, test.map((q, i) => judged(q, f(q), i))]));
  const ndcg = Object.fromEntries(
    Object.entries(methods).map(([k, f]) => [k, round(test.reduce((s, q) => s + ndcgOf(q, f(q)), 0) / test.length)]),
  );
  const diff = (a, b) => {
    const d = pairedDifference(runs[a], runs[b], q =>
      ndcgAt(
        q.relevance,
        10,
        [...q.relevance].sort((x, y) => y - x),
      ),
    );
    return { mean: round(d.mean), low: round(d.low), high: round(d.high) };
  };
  // Serving cost: rerank 50 candidates.
  const times = [];
  for (const q of test.slice(0, 500)) {
    const s = performance.now();
    rank(ips, q.features);
    times.push(performance.now() - s);
  }
  times.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      searches,
      clicks: clicked.reduce((s, q) => s + q.labels.filter(l => l > 0).length, 0),
      ndcg10: ndcg,
      lambdaMartIpsMinusRrf: diff('lambdaMartIps', 'rrf'),
      lambdaMartIpsMinusLinear: diff('lambdaMartIps', 'linearIps'),
      lambdaMartIpsMinusRaw: diff('lambdaMartIps', 'lambdaMartRaw'),
      estimatedPropensity: estimated
        ? { eta: round(estimated.eta), trueEta: ETA, theta5: estimated.theta.slice(0, 5).map(round) }
        : 'not enough clicks to estimate',
      ...(estimatedModel ? { estimatedMinusRrf: diff('lambdaMartEstimated', 'rrf') } : {}),
      trainMs,
      linearTrainMs: linearMs,
      modelKB: +(serializeLambdaMart(ips).length / 1024).toFixed(1),
      rerank50Ms: {
        p50: +times[Math.floor(times.length / 2)].toFixed(3),
        p95: +times[Math.floor(times.length * 0.95)].toFixed(3),
      },
    }),
  );
}
