#!/usr/bin/env node
// Benchmarks Graphinity's own spelling correction (ADR 0011) on synthetic
// corpora: a 20,000-word lexicon of made-up words used at Zipf frequencies,
// so many words sit one or two edits from another (as real words do), plus a
// name written once per question (the "leave it alone" words). Runs the same
// training run the server does and reports this machine's real numbers:
// tuning and training time, peak memory, artifact size, index build time,
// per-word latency, and held-out precision and recall.
//
//   node scripts/benchmark-spelling.mjs [questions...]   (default 2000 10000)
//
// Synthetic data says how the method scales; it does not predict how well it
// corrects real people's typos, which the gate measures nightly on real posts.
import { seededRandom } from '../apps/api/src/ml/linalg.ts';
import { buildIndex, speller, trainSpelling } from '../apps/api/src/ml/spelling.ts';
import { splitDocuments } from '../apps/api/src/ml/spelling-gate.ts';
import { trainSpellingAndEvaluate } from '../apps/api/src/ml/train-spelling.ts';

const SYLLABLES = ['ka', 'ro', 'mi', 'sun', 'tel', 'dar', 'vo', 'pen', 'lis', 'gor', 'ane', 'qui', 'bra', 'tos'];
const SYLLABLES_2 = ['le', 'ni', 'mar', 'po', 'chi', 'den', 'ru', 'sa', 'tin', 'ho', 'bel', 'cu', 'fa', 'zo'];

function corpus(size, seed = 1) {
  const r = seededRandom(seed);
  const lexicon = new Set();
  while (lexicon.size < 20_000) {
    let w = '';
    for (let i = 0, k = 2 + Math.floor(r() * 3); i < k; i++)
      w += (i % 2 ? SYLLABLES_2 : SYLLABLES)[Math.floor(r() * 14)];
    lexicon.add(w);
  }
  const words = [...lexicon];
  // Inverse-CDF sampling of Zipf(1) over the lexicon.
  const cdf = [];
  words.reduce((sum, _, i) => (cdf[i] = sum + 1 / (i + 1)), 0);
  const total = cdf[cdf.length - 1];
  const word = () => {
    const u = r() * total;
    let lo = 0;
    let hi = words.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < u) lo = mid + 1;
      else hi = mid;
    }
    return words[lo];
  };
  const text = n => Array.from({ length: n }, word).join(' ');
  const name = i => `zeph${i.toString(26).replace(/[0-9]/g, d => 'qrstuvwxyz'[Number(d)])}`;
  return Array.from({ length: size }, (_, i) => ({
    id: String(i + 1),
    title: `${text(8)} ${name(i)}`,
    body: text(22),
  }));
}

const percentile = (xs, q) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))];
const sizes = process.argv.slice(2).map(Number).filter(Boolean);
for (const size of sizes.length ? sizes : [2000, 10_000]) {
  const questions = corpus(size);
  const rssBefore = process.resourceUsage().maxRSS;
  const t0 = performance.now();
  const result = trainSpellingAndEvaluate({ questions, answers: [], serving: null });
  const runMs = performance.now() - t0;
  const rssAfter = process.resourceUsage().maxRSS;

  // What the server pays once per promoted version, and per word after that.
  // The tuned model, promoted or not, so its speed is measured either way.
  const { lambda, mu, minCount, keep } = result.params;
  const model = trainSpelling(splitDocuments(questions, []).training, { lambda, mu, minCount, keep });
  const t1 = performance.now();
  const built = buildIndex(model.words);
  const indexMs = performance.now() - t1;
  const s = speller(model, built);
  const r = seededRandom(9);
  const times = [];
  for (let i = 0; i < 2000; i++) {
    const w = model.words[Math.floor(r() * Math.min(model.words.length, 5000))];
    const typo = w.slice(0, 2) + w.slice(3);
    const t = performance.now();
    s.correct(typo, null);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const m = result.metrics;
  console.log(
    JSON.stringify({
      questions: size,
      trainingDocuments: result.dataset.trainingDocuments,
      vocabulary: result.dataset.vocabulary,
      tuned: { lambda: result.params.lambda, mu: result.params.mu, keep: +result.params.keep.toFixed(2) },
      runMs: Math.round(runMs),
      peakRssGrowthMB: Math.round((rssAfter - rssBefore) / 1024),
      artifactMB: result.artifact ? +(result.artifact.length / 1e6).toFixed(2) : null,
      indexMs: Math.round(indexMs),
      correctMs: {
        p50: +percentile(times, 0.5).toFixed(3),
        p95: +percentile(times, 0.95).toFixed(3),
        p99: +percentile(times, 0.99).toFixed(3),
      },
      test: {
        typos: m.typos,
        newWords: m.newWords,
        changed: m.changed,
        precision: +m.precision.toFixed(4),
        precisionLower: +m.precisionLower.toFixed(4),
        recall: +m.recall.toFixed(4),
        tuneRecall: +m.tuneRecall.toFixed(4),
      },
      gate: result.decision,
    }),
  );
}
