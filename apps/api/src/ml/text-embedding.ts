// Graphinity's own text embedding, learned only from Graphinity's text (ADR
// 0010). Questions that mean the same thing land close together, so "has this
// been asked already?" works by meaning, with no outside AI service.
//
// Method, all from the literature and none of it a black box:
//   1. Word vectors from positive pointwise mutual information (PPMI) over a
//      distance-weighted co-occurrence window, with context smoothing α = 0.75,
//      factorized by a truncated eigendecomposition with eigenvalue weighting
//      p = 0.5. Levy, Goldberg & Dagan (2015) show this matches skip-gram
//      (word2vec) once given the same hyperparameters, and unlike skip-gram it
//      is deterministic and needs no learning-rate tuning.
//   2. Sentence vectors by SIF (Arora, Liang & Ma 2017): each word weighted by
//      a / (a + p(w)) with a = 1e-3, then the first principal component of the
//      training sentences removed. A strong, training-free baseline that beats
//      plain averaging on semantic similarity.
//   3. A word never seen in training still counts, through a hashed vector, so
//      a rare exact code ("BOE-II") can match itself.
import { createHash } from 'node:crypto';
import { valueAt, seededRandom, sparseFromKeys, topEigen } from './linalg.ts';

export const ALGORITHM = 'ppmi-svd-sif';

export interface TrainingOptions {
  /** Vector size. 128 keeps a 20k-word model near 10 MB; more adds little at this corpus size. */
  dims?: number;
  /** Co-occurrence window either side; 5 is word2vec's and Levy et al.'s default. */
  window?: number;
  /** A word must appear this often to get its own vector (fewer: hashed instead). */
  minCount?: number;
  /** Largest vocabulary. */
  maxVocab?: number;
  seed?: number;
}

export const DEFAULTS = { dims: 128, window: 5, minCount: 2, maxVocab: 20_000, seed: 1 } as const;
/** Context-distribution smoothing exponent (Levy et al. 2015, §3.2). */
const CONTEXT_ALPHA = 0.75;
/** Eigenvalue weighting exponent (Levy et al. 2015, §3.3). */
const EIGEN_WEIGHT = 0.5;
/** SIF's smoothing constant (Arora et al. 2017, best range 1e-4..1e-3). */
const SIF_A = 1e-3;

export interface TextEmbeddingModel {
  vocab: string[];
  dims: number;
  /** vocab.length × dims, row-major, each row unit length. */
  vectors: Float32Array;
  /** SIF weight per vocabulary word. */
  weights: Float32Array;
  /** The training sentences' first principal component, removed from every sentence vector. */
  component: Float32Array;
}

export function tokenize(text: string): string[] {
  return (
    text
      .normalize('NFC')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/** Trains on documents (each a question or an answer). Deterministic for a given seed. */
export function trainTextEmbedding(documents: readonly string[], options: TrainingOptions = {}): TextEmbeddingModel {
  const { dims, window, minCount, maxVocab, seed } = { ...DEFAULTS, ...options };
  const docs = documents.map(tokenize);
  const counts = new Map<string, number>();
  for (const d of docs) for (const w of d) counts.set(w, (counts.get(w) ?? 0) + 1);
  // Most frequent first, ties alphabetical: the same corpus always gives the same ids.
  const vocab = [...counts]
    .filter(([, c]) => c >= minCount)
    .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
    .slice(0, maxVocab)
    .map(([w]) => w);
  const id = new Map(vocab.map((w, i) => [w, i]));
  const v = vocab.length;
  if (v < 2) throw new RangeError('not enough distinct words to train on');
  const k = Math.min(dims, v - 1);

  // Symmetric, distance-weighted co-occurrence (a word d positions away counts 1/d).
  const pair = new Map<number, number>();
  for (const d of docs) {
    const ids = d.map(w => id.get(w) ?? -1);
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i] ?? -1;
      if (a < 0) continue;
      for (let j = i + 1; j <= Math.min(ids.length - 1, i + window); j++) {
        const b = ids[j] ?? -1;
        if (b < 0) continue;
        const weight = 1 / (j - i);
        pair.set(a * v + b, (pair.get(a * v + b) ?? 0) + weight);
        pair.set(b * v + a, (pair.get(b * v + a) ?? 0) + weight);
      }
    }
  }
  const rowSum = new Float64Array(v);
  let total = 0;
  for (const [key, c] of pair) {
    rowSum[Math.floor(key / v)] = valueAt(rowSum, Math.floor(key / v)) + c;
    total += c;
  }
  if (total === 0) throw new RangeError('no words appear near each other');
  let smoothedTotal = 0;
  const smoothed = new Float64Array(v);
  for (let i = 0; i < v; i++) {
    smoothed[i] = valueAt(rowSum, i) ** CONTEXT_ALPHA;
    smoothedTotal += valueAt(smoothed, i);
  }
  // PPMI(w, c) = max(0, log p(w,c) / (p(w) p_α(c))). Smoothing only the
  // context makes it slightly asymmetric, so each pair takes the mean of both
  // directions: the eigensolver needs a symmetric matrix. (Counts are kept in
  // both directions, so every unordered pair is visited once, from w ≤ c.)
  const ppmi = (w: number, c: number, count: number) =>
    Math.max(0, Math.log(count / total / ((valueAt(rowSum, w) / total) * (valueAt(smoothed, c) / smoothedTotal))));
  // Both directions of every pair are in `pair`, so each key gets the mean of
  // its two directions directly; written straight into the sparse matrix.
  const keys = new Float64Array(pair.size);
  const values = new Float64Array(pair.size);
  let n = 0;
  for (const [key, count] of pair) {
    const w = Math.floor(key / v);
    const c = key % v;
    const value = (ppmi(w, c, count) + ppmi(c, w, count)) / 2;
    if (value <= 0) continue;
    keys[n] = key;
    values[n] = value;
    n++;
  }
  pair.clear();
  const matrix = sparseFromKeys(v, v, keys.subarray(0, n), values.subarray(0, n));
  const eigen = topEigen(matrix, k, { seed });

  const vectors = new Float32Array(v * dims);
  for (let i = 0; i < v; i++) {
    let norm = 0;
    for (let c = 0; c < eigen.values.length; c++) {
      const x =
        valueAt(eigen.vectors.data, i * eigen.values.length + c) * Math.abs(valueAt(eigen.values, c)) ** EIGEN_WEIGHT;
      vectors[i * dims + c] = x;
      norm += x * x;
    }
    norm = Math.sqrt(norm);
    if (norm > 0) for (let c = 0; c < dims; c++) vectors[i * dims + c] = valueAt(vectors, i * dims + c) / norm;
  }
  let tokens = 0;
  for (const w of vocab) tokens += counts.get(w) ?? 0;
  const weights = Float32Array.from(vocab.map(w => SIF_A / (SIF_A + (counts.get(w) ?? 0) / tokens)));

  const model: TextEmbeddingModel = { vocab, dims, vectors, weights, component: new Float32Array(dims) };
  model.component = firstComponent(
    docs.map(d => rawSentence(model, id, d)),
    dims,
    seed,
  );
  return model;
}

const lookup = new WeakMap<TextEmbeddingModel, Map<string, number>>();
function idsOf(model: TextEmbeddingModel): Map<string, number> {
  let map = lookup.get(model);
  if (!map) {
    map = new Map(model.vocab.map((w, i) => [w, i]));
    lookup.set(model, map);
  }
  return map;
}

/** A word the model never saw: a fixed pseudo-random unit vector from its hash. */
export function hashedVector(word: string, dims: number): Float64Array {
  const h = createHash('sha256').update(word).digest();
  const random = seededRandom(h.readUInt32BE(0));
  const out = new Float64Array(dims);
  let norm = 0;
  for (let c = 0; c < dims; c++) {
    out[c] = random() * 2 - 1;
    norm += valueAt(out, c) ** 2;
  }
  norm = Math.sqrt(norm);
  for (let c = 0; c < dims; c++) out[c] = valueAt(out, c) / norm;
  return out;
}

function rawSentence(model: TextEmbeddingModel, id: Map<string, number>, words: readonly string[]): Float64Array {
  const out = new Float64Array(model.dims);
  if (words.length === 0) return out;
  for (const w of words) {
    const i = id.get(w);
    if (i === undefined) {
      // Unseen: SIF weight with p(w) = 0, which is 1, the most a word can weigh.
      const hv = hashedVector(w, model.dims);
      for (let c = 0; c < model.dims; c++) out[c] = valueAt(out, c) + valueAt(hv, c);
    } else {
      const weight = valueAt(model.weights, i);
      for (let c = 0; c < model.dims; c++)
        out[c] = valueAt(out, c) + weight * valueAt(model.vectors, i * model.dims + c);
    }
  }
  for (let c = 0; c < model.dims; c++) out[c] = valueAt(out, c) / words.length;
  return out;
}

/** The first principal component of the sentence vectors, by power iteration on XᵀX. */
function firstComponent(sentences: readonly Float64Array[], dims: number, seed: number): Float32Array {
  const random = seededRandom(seed + 7);
  let u = Float64Array.from({ length: dims }, () => random() - 0.5);
  for (let iter = 0; iter < 100; iter++) {
    const next = new Float64Array(dims);
    for (const s of sentences) {
      let dot = 0;
      for (let c = 0; c < dims; c++) dot += valueAt(s, c) * valueAt(u, c);
      for (let c = 0; c < dims; c++) next[c] = valueAt(next, c) + dot * valueAt(s, c);
    }
    let norm = 0;
    for (let c = 0; c < dims; c++) norm += valueAt(next, c) ** 2;
    norm = Math.sqrt(norm);
    if (norm === 0) return new Float32Array(dims);
    let change = 0;
    for (let c = 0; c < dims; c++) {
      const value = valueAt(next, c) / norm;
      change += Math.abs(value - valueAt(u, c));
      next[c] = value;
    }
    u = next;
    if (change < 1e-10) break;
  }
  return Float32Array.from(u);
}

/** A unit vector for the text (length `model.dims`), or all zeros for text with no words. */
export function embedText(model: TextEmbeddingModel, text: string): Float64Array {
  const s = rawSentence(model, idsOf(model), tokenize(text));
  let dot = 0;
  for (let c = 0; c < model.dims; c++) dot += valueAt(s, c) * valueAt(model.component, c);
  let norm = 0;
  for (let c = 0; c < model.dims; c++) {
    s[c] = valueAt(s, c) - dot * valueAt(model.component, c);
    norm += valueAt(s, c) ** 2;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) for (let c = 0; c < model.dims; c++) s[c] = valueAt(s, c) / norm;
  return s;
}

// The artifact: a small JSON header, then the float arrays, little-endian.
const MAGIC = 'GTE1';

export function serializeModel(model: TextEmbeddingModel): Buffer {
  const header = Buffer.from(JSON.stringify({ vocab: model.vocab, dims: model.dims }), 'utf8');
  const floats = [model.vectors, model.weights, model.component];
  const out = Buffer.alloc(4 + 4 + header.length + floats.reduce((n, f) => n + f.length * 4, 0));
  out.write(MAGIC, 0, 'ascii');
  out.writeUInt32LE(header.length, 4);
  header.copy(out, 8);
  let at = 8 + header.length;
  for (const f of floats)
    for (const x of f) {
      out.writeFloatLE(x, at);
      at += 4;
    }
  return out;
}

export function deserializeModel(buffer: Buffer): TextEmbeddingModel {
  if (buffer.toString('ascii', 0, 4) !== MAGIC) throw new Error('not a Graphinity text-embedding artifact');
  const headerLength = buffer.readUInt32LE(4);
  const { vocab, dims } = JSON.parse(buffer.toString('utf8', 8, 8 + headerLength)) as { vocab: string[]; dims: number };
  let at = 8 + headerLength;
  const read = (length: number) => {
    const f = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      f[i] = buffer.readFloatLE(at);
      at += 4;
    }
    return f;
  };
  const vectors = read(vocab.length * dims);
  const weights = read(vocab.length);
  const component = read(dims);
  if (at !== buffer.length) throw new Error('artifact length does not match its header');
  return { vocab, dims, vectors, weights, component };
}
