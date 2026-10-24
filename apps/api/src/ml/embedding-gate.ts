// The quality gate for a newly trained text embedding (ADR 0010). A model
// serves only if it measurably finds the right question better than what
// serves today, on questions it never saw while training.
//
// The test is the job the model does: given a question's details, find its
// own title among every held-out title (as "has this been asked?" finds the
// earlier question). Mean reciprocal rank and recall@10 per query; the
// decision is a paired bootstrap of the per-query difference (Efron &
// Tibshirani 1993), so "better" means better beyond the noise of which
// questions happened to be held out, not by a hand-picked margin.
import { createHash } from 'node:crypto';
import { RRF_K, W_MEANING, W_WORDS } from '../precheck.ts';
import { bm25Index } from './bm25.ts';
import { valueAt, seededRandom } from './linalg.ts';
import { embedText, tokenize, type TextEmbeddingModel } from './text-embedding.ts';

/** One question in five is held out of training, by a hash of its id: stable as data grows. */
export const isHeldOut = (questionId: string) =>
  createHash('sha256').update(questionId).digest().readUInt8(0) % 5 === 0;

/** Details shorter than this say too little to be a fair query. */
export const MIN_QUERY_WORDS = 6;
/**
 * Fewer evaluable questions than this and the gate doesn't decide: below about
 * 30 the bootstrap's interval is too unreliable (the usual CLT rule of thumb).
 */
export const MIN_QUERIES = 30;
export const BOOTSTRAP_SAMPLES = 2000;
export const RECALL_AT = 10;

export interface HeldOutQuestion {
  id: string;
  title: string;
  body: string;
}

export interface RetrievalScores {
  queries: number;
  mrr: number;
  recallAt10: number;
  /** Per query, in a fixed order, for the paired comparison. */
  reciprocalRanks: number[];
}

/** Ranks every title for each query with `score`; ties count against the target (no luck). */
export function evaluateRetrieval(
  questions: readonly HeldOutQuestion[],
  score: (query: string, candidate: number) => number,
): RetrievalScores {
  const queries = questions
    .map((q, i) => ({ i, body: q.body }))
    .filter(q => tokenize(q.body).length >= MIN_QUERY_WORDS);
  const reciprocalRanks: number[] = [];
  let hits = 0;
  for (const q of queries) {
    const target = score(q.body, q.i);
    let rank = 1;
    for (let c = 0; c < questions.length; c++) if (c !== q.i && score(q.body, c) >= target) rank++;
    reciprocalRanks.push(1 / rank);
    if (rank <= RECALL_AT) hits++;
  }
  const n = reciprocalRanks.length;
  return {
    queries: n,
    mrr: n ? reciprocalRanks.reduce((s, x) => s + x, 0) / n : 0,
    recallAt10: n ? hits / n : 0,
    reciprocalRanks,
  };
}

/** Word matching (BM25) over the titles: what serves when no model does. */
export function bm25Scorer(questions: readonly HeldOutQuestion[]) {
  const index = bm25Index(questions.map(q => q.title));
  return (query: string, candidate: number) => index.score(query, candidate);
}

/** Cosine between the query and each title under a model. Titles are embedded once. */
export function modelScorer(model: TextEmbeddingModel, questions: readonly HeldOutQuestion[]) {
  const titles = questions.map(q => embedText(model, q.title));
  const cache = new Map<string, Float64Array>();
  return (query: string, candidate: number) => {
    let v = cache.get(query);
    if (!v) {
      v = embedText(model, query);
      cache.set(query, v);
    }
    const t = titles[candidate];
    if (!t) return 0;
    let s = 0;
    for (let i = 0; i < v.length; i++) s += valueAt(v, i) * valueAt(t, i);
    return s;
  };
}

/**
 * What actually serves: meaning and words fused by reciprocal rank (the
 * precheck's own weights and k, spec §12.1), so a model is judged by what it
 * adds to word matching, not by replacing it. Ranks are computed once per
 * query over every candidate; ties break by position, deterministically.
 */
export function fusedScorer(model: TextEmbeddingModel, questions: readonly HeldOutQuestion[]) {
  const meaning = modelScorer(model, questions);
  const words = bm25Scorer(questions);
  const cache = new Map<string, Float64Array>();
  const ranks = (score: (q: string, c: number) => number, query: string) => {
    const order = questions.map((_, c) => c).sort((a, b) => score(query, b) - score(query, a) || a - b);
    const rank = new Float64Array(questions.length);
    order.forEach((c, i) => (rank[c] = i + 1));
    return rank;
  };
  return (query: string, candidate: number) => {
    let fused = cache.get(query);
    if (!fused) {
      const m = ranks(meaning, query);
      const w = ranks(words, query);
      fused = new Float64Array(questions.length);
      for (let c = 0; c < questions.length; c++)
        fused[c] = W_MEANING / (RRF_K + valueAt(m, c)) + W_WORDS / (RRF_K + valueAt(w, c));
      cache.set(query, fused);
    }
    return valueAt(fused, candidate);
  };
}

export interface GateDecision {
  promote: boolean;
  reason: string;
  /** Mean per-query MRR difference (candidate − baseline) and its 95% interval. */
  difference: { mean: number; low: number; high: number } | null;
}

/** Promote only if the 95% interval of the paired MRR difference lies above zero. */
export function decide(candidate: RetrievalScores, baseline: RetrievalScores, seed = 1): GateDecision {
  const n = candidate.queries;
  if (n !== baseline.queries) throw new Error('candidate and baseline must be scored on the same queries');
  if (n < MIN_QUERIES)
    return {
      promote: false,
      reason: `only ${String(n)} evaluable held-out questions; ${String(MIN_QUERIES)} needed`,
      difference: null,
    };
  const diffs = candidate.reciprocalRanks.map((x, i) => x - valueAt(baseline.reciprocalRanks, i));
  const random = seededRandom(seed);
  const means: number[] = [];
  for (let b = 0; b < BOOTSTRAP_SAMPLES; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += valueAt(diffs, Math.floor(random() * n));
    means.push(s / n);
  }
  means.sort((x, y) => x - y);
  const low = valueAt(means, Math.floor(0.025 * BOOTSTRAP_SAMPLES));
  const high = valueAt(means, Math.floor(0.975 * BOOTSTRAP_SAMPLES) - 1);
  const mean = diffs.reduce((s, x) => s + x, 0) / n;
  const difference = { mean, low, high };
  return low > 0
    ? {
        promote: true,
        reason: `MRR better by ${mean.toFixed(4)} (95% interval ${low.toFixed(4)} to ${high.toFixed(4)})`,
        difference,
      }
    : {
        promote: false,
        reason: `not better beyond noise: MRR difference ${mean.toFixed(4)} (95% interval ${low.toFixed(4)} to ${high.toFixed(4)})`,
        difference,
      };
}
