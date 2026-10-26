#!/usr/bin/env node
// Does expanding word search with learned synonyms help (ADR 0015 lists
// synonym learning as not built)? Synonyms are each word's nearest words in
// Graphinity's own embedding (ADR 0010), above a similarity bar. Measured on
// the synthetic corpus whose question details paraphrase their titles
// ("tax", "levy" for "duty"), with the embedding gate's own task: from a
// question's details, find its title among every held-out title. Variants:
// words alone and fused with meaning (as search serves), each with and
// without expansion, over neighbours k, bar and the expansion's weight.
// Paired bootstrap (95%) against the same thing without expansion.
// Decision and numbers: docs/adr/0021-no-learned-synonyms-yet.md.
//
//   node scripts/benchmark-synonyms.mjs          (realistic queries)
//   HARD=1 node scripts/benchmark-synonyms.mjs   (topic words only)
import { decide, evaluateRetrieval, isHeldOut, modelScorer } from '../apps/api/src/ml/embedding-gate.ts';
import { RRF_K, W_MEANING, W_WORDS } from '../apps/api/src/precheck.ts';
import { tokenize, trainTextEmbedding } from '../apps/api/src/ml/text-embedding.ts';
import { corpus } from './lib/synthetic-questions.mjs';

const all = corpus(6000, 7);
// HARD=1: queries lose their product and place names, so only the topic's
// words (said differently in details and title) can find the question.
const hard = process.env.HARD === '1';
const heldOut = all
  .filter(q => isHeldOut(q.id))
  .slice(0, 600)
  .map(q =>
    hard
      ? {
          ...q,
          body: q.body
            .replace(/\b(item|city)\d+\b/g, '')
            .replace(/\s+/g, ' ')
            .trim(),
        }
      : q,
  );
const training = all.filter(q => !isHeldOut(q.id));
const model = trainTextEmbedding(training.map(q => `${q.title}\n${q.body}`));
const index = new Map(model.vocab.map((w, i) => [w, i]));

function neighbours(word, k, bar) {
  const i = index.get(word);
  if (i === undefined) return [];
  const d = model.dims;
  const out = [];
  for (let j = 0; j < model.vocab.length; j++) {
    if (j === i) continue;
    let s = 0;
    for (let c = 0; c < d; c++) s += model.vectors[i * d + c] * model.vectors[j * d + c];
    if (s >= bar) out.push([model.vocab[j], s]);
  }
  return out.sort((a, b) => b[1] - a[1]).slice(0, k);
}

/** BM25 over titles where each query term may carry a weight (expansions weigh less). */
function weightedBm25(titles) {
  const docs = titles.map(t => {
    const tf = new Map();
    const ws = tokenize(t);
    for (const w of ws) tf.set(w, (tf.get(w) ?? 0) + 1);
    return { tf, length: ws.length };
  });
  const n = docs.length;
  const avg = docs.reduce((s, d) => s + d.length, 0) / n;
  const df = new Map();
  for (const d of docs) for (const w of d.tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  const idf = w => Math.log(1 + (n - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5));
  return (terms, doc) => {
    const d = docs[doc];
    let s = 0;
    for (const [w, weight] of terms) {
      const f = d.tf.get(w) ?? 0;
      if (f) s += weight * ((idf(w) * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * d.length) / avg)));
    }
    return s;
  };
}

const bm25 = weightedBm25(heldOut.map(q => q.title));
const synonymCache = new Map();
function terms(query, expand) {
  const words = [...new Set(tokenize(query))];
  const out = new Map(words.map(w => [w, 1]));
  if (!expand) return [...out];
  for (const w of words) {
    const key = `${w}|${expand.k}|${expand.bar}`;
    let syn = synonymCache.get(key);
    if (!syn) synonymCache.set(key, (syn = neighbours(w, expand.k, expand.bar)));
    for (const [s] of syn) if (!out.has(s)) out.set(s, expand.weight);
  }
  return [...out];
}
const wordsScorer = expand => {
  const cache = new Map();
  return (query, c) => {
    let t = cache.get(query);
    if (!t) cache.set(query, (t = terms(query, expand)));
    return bm25(t, c);
  };
};
const meaning = modelScorer(model, heldOut);
function fused(words) {
  const cache = new Map();
  const ranks = (score, query) => {
    const order = heldOut.map((_, c) => c).sort((a, b) => score(query, b) - score(query, a) || a - b);
    const r = new Float64Array(heldOut.length);
    order.forEach((c, i) => (r[c] = i + 1));
    return r;
  };
  return (query, c) => {
    let f = cache.get(query);
    if (!f) {
      const m = ranks(meaning, query);
      const w = ranks(words, query);
      f = Float64Array.from(heldOut, (_, i) => W_MEANING / (RRF_K + m[i]) + W_WORDS / (RRF_K + w[i]));
      cache.set(query, f);
    }
    return f[c];
  };
}

const baseWords = evaluateRetrieval(heldOut, wordsScorer(null));
const baseFused = evaluateRetrieval(heldOut, fused(wordsScorer(null)));
const rows = [];
for (const k of [1, 3])
  for (const bar of [0.5, 0.7])
    for (const weight of [0.5, 1]) {
      const expand = { k, bar, weight };
      const words = evaluateRetrieval(heldOut, wordsScorer(expand));
      const fusedScores = evaluateRetrieval(heldOut, fused(wordsScorer(expand)));
      rows.push({
        k,
        bar,
        weight,
        wordsMrr: +words.mrr.toFixed(3),
        wordsVsPlain: decide(words, baseWords).difference,
        fusedMrr: +fusedScores.mrr.toFixed(3),
        fusedVsPlain: decide(fusedScores, baseFused).difference,
      });
    }
const sample = ['duty', 'tax', 'import', 'visa', 'rent', 'repair', 'price'].map(w => [
  w,
  neighbours(w, 3, 0.5).map(([s, v]) => `${s} ${v.toFixed(2)}`),
]);
console.log(
  JSON.stringify(
    {
      hard,
      heldOut: heldOut.length,
      vocabulary: model.vocab.length,
      plain: { wordsMrr: +baseWords.mrr.toFixed(3), fusedMrr: +baseFused.mrr.toFixed(3) },
      neighbours: Object.fromEntries(sample),
      rows,
    },
    null,
    1,
  ),
);
