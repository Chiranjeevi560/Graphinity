#!/usr/bin/env node
// Benchmarks Graphinity's own text embedding (ADR 0010) on synthetic corpora
// shaped like Graphinity's: question details paraphrase their title with
// synonyms ("duty" / "tax" / "levy"), which word matching can't connect.
// Reports real measurements of this machine: training time, peak memory,
// per-text embedding latency, and held-out retrieval quality against BM25.
//
//   node scripts/benchmark-text-embedding.mjs [documents...]   (default 2000 10000)
//
// Synthetic data says how the method scales and whether it can learn
// paraphrase from co-occurrence; it does not predict quality on real posts.
import {
  bm25Scorer,
  decide,
  evaluateRetrieval,
  fusedScorer,
  isHeldOut,
  modelScorer,
} from '../apps/api/src/ml/embedding-gate.ts';
import { embedText, serializeModel, trainTextEmbedding } from '../apps/api/src/ml/text-embedding.ts';
import { corpus } from './lib/synthetic-questions.mjs';

const percentile = (xs, q) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))];
const sizes = process.argv.slice(2).map(Number).filter(Boolean);
for (const size of sizes.length ? sizes : [2000, 10_000]) {
  const questions = corpus(size);
  const heldOut = questions.filter(q => isHeldOut(q.id));
  const docs = questions.filter(q => !isHeldOut(q.id)).map(q => `${q.title}\n${q.body}`);
  const rssBefore = process.resourceUsage().maxRSS;
  const t0 = performance.now();
  const model = trainTextEmbedding(docs);
  const trainMs = performance.now() - t0;
  const rssAfter = process.resourceUsage().maxRSS;

  const times = [];
  for (const q of questions.slice(0, 1000)) {
    const s = performance.now();
    embedText(model, q.body);
    times.push(performance.now() - s);
  }
  times.sort((a, b) => a - b);

  // Evaluate on a fixed sample of held-out questions (the full O(Q·N) ranking is the slow part).
  const sample = heldOut.slice(0, 600);
  const own = evaluateRetrieval(sample, modelScorer(model, sample));
  const fused = evaluateRetrieval(sample, fusedScorer(model, sample));
  const words = evaluateRetrieval(sample, bm25Scorer(sample));
  const gate = decide(fused, words);
  console.log(
    JSON.stringify({
      documents: docs.length,
      vocabulary: model.vocab.length,
      dims: model.dims,
      artifactMB: +(serializeModel(model).length / 1e6).toFixed(2),
      trainMs: Math.round(trainMs),
      peakRssGrowthMB: Math.round((rssAfter - rssBefore) / 1024),
      embedMs: {
        p50: +percentile(times, 0.5).toFixed(3),
        p95: +percentile(times, 0.95).toFixed(3),
        p99: +percentile(times, 0.99).toFixed(3),
      },
      heldOut: {
        queries: own.queries,
        modelAloneMrr: +own.mrr.toFixed(4),
        fusedMrr: +fused.mrr.toFixed(4),
        bm25Mrr: +words.mrr.toFixed(4),
        fusedRecall10: +fused.recallAt10.toFixed(4),
        bm25Recall10: +words.recallAt10.toFixed(4),
      },
      gate: { promote: gate.promote, reason: gate.reason },
    }),
  );
}
