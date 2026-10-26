// Embedding drift (docs/adr/0019-embedding-drift.md): signals that new
// questions are moving away from what Graphinity's own text model (ADR 0010)
// learned. The model learns its vocabulary from posts, so its weakness on
// new topics is words it can't place. Two numbers per question, judged by the
// same rule as every feature (src/ml/drift.ts):
// - coverage: the share of the question's words in the model's vocabulary;
// - centroid_similarity: cosine between the question's embedding and the
//   centre of the training questions' embeddings. Both are profiled on the
//   held-out questions: a centre fitted on the profiled questions themselves
//   sits closer to them than to any new ones, and false-alarms with nothing
//   changed (scripts/benchmark-embedding-drift.mjs).
// Questions with no words give no signal and are left out.
import { valueAt } from './linalg.ts';
import { embedText, tokenize, type TextEmbeddingModel } from './text-embedding.ts';

export const EMBEDDING_SIGNALS = ['centroid_similarity', 'coverage'] as const;

const vocabularies = new WeakMap<TextEmbeddingModel, Set<string>>();
const vocabularyOf = (model: TextEmbeddingModel) => {
  let v = vocabularies.get(model);
  if (!v) {
    v = new Set(model.vocab);
    vocabularies.set(model, v);
  }
  return v;
};

/** The unit-length mean of the texts' embeddings (zero vectors left out). */
export function centroidOf(model: TextEmbeddingModel, texts: readonly string[]): number[] {
  const sum = new Float64Array(model.dims);
  for (const t of texts) {
    const v = embedText(model, t);
    for (let c = 0; c < model.dims; c++) sum[c] = valueAt(sum, c) + valueAt(v, c);
  }
  let norm = 0;
  for (let c = 0; c < model.dims; c++) norm += valueAt(sum, c) ** 2;
  norm = Math.sqrt(norm);
  return Array.from(sum, x => (norm > 0 ? x / norm : 0));
}

/** Each signal per text with at least one word, in matching order. O(texts x (words + dims)). */
export function embeddingSignals(
  model: TextEmbeddingModel,
  texts: readonly string[],
  centroid: readonly number[],
): Record<(typeof EMBEDDING_SIGNALS)[number], number[]> {
  const vocab = vocabularyOf(model);
  const coverage: number[] = [];
  const similarity: number[] = [];
  for (const t of texts) {
    const words = tokenize(t);
    if (words.length === 0) continue;
    let known = 0;
    for (const w of words) if (vocab.has(w)) known++;
    coverage.push(known / words.length);
    const v = embedText(model, t);
    let dot = 0;
    for (let c = 0; c < model.dims; c++) dot += valueAt(v, c) * (centroid[c] ?? 0);
    similarity.push(dot);
  }
  return { coverage, centroid_similarity: similarity };
}
