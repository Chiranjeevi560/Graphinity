// Graphinity's own text embedding behind the Embedder interface search
// already uses (embeddings.ts), so precheck, backfill and nearest-question
// search need no change to use it.
import { DIMS, EmbeddingError, type Embedder } from '../embeddings.ts';
import { ALGORITHM, deserializeModel, embedText, hashedVector, type TextEmbeddingModel } from './text-embedding.ts';

/**
 * The most numbers a stored vector may have (app.question_embeddings). The
 * database indexes the own model's size, 128 (migration 0021); other sizes
 * are compared exactly until a migration adds their index.
 */
export const MAX_DIMS = 2000;

export function modelName(version: number): string {
  return `graphinity:${ALGORITHM}:v${String(version)}`;
}

export function ownEmbedder(model: TextEmbeddingModel, version: number): Embedder {
  if (model.dims > MAX_DIMS)
    throw new EmbeddingError(`a ${String(model.dims)}-dimension model is larger than ${String(MAX_DIMS)} numbers`);
  return {
    model: modelName(version),
    // Stored at the model's own size: padding to 768 made the index three times larger (ADR 0015 part 5).
    dims: model.dims,
    embed: texts =>
      Promise.resolve(
        texts.map(text => {
          const v = embedText(model, text);
          // Text with no words at all still gets a stable vector, matching only itself.
          return Array.from(v.some(x => x !== 0) ? v : hashedVector(text.trim(), model.dims));
        }),
      ),
  };
}

export function ownEmbedderFromArtifact(artifact: Buffer, version: number): Embedder {
  return ownEmbedder(deserializeModel(artifact), version);
}

/**
 * An embedder whose model can be replaced while the server runs (a new
 * version promoted). The name is read on every use, so each query and each
 * stored vector names the model that actually made it.
 */
export function swappableEmbedder(initial: Embedder | null): {
  embedder: Embedder;
  set(next: Embedder | null): void;
  current(): Embedder | null;
} {
  let inner = initial;
  return {
    embedder: {
      get model() {
        return inner?.model ?? 'none';
      },
      get dims() {
        return inner?.dims ?? DIMS;
      },
      embed: texts => (inner ? inner.embed(texts) : Promise.reject(new EmbeddingError('no model serving'))),
    },
    set(next) {
      inner = next;
    },
    current: () => inner,
  };
}
