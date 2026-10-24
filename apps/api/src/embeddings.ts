// Turning a question into numbers that sit close together when two
// questions mean the same thing (docs/SPEC.md §11.1, §12.1).
// Plumbing only (§12.2): embeddings find duplicates and similar questions;
// nothing here writes an answer.
//
// Graphinity's own model serves (apps/api/src/ml, ADR 0010): trained only on
// Graphinity's posts, run on its own server, with no outside AI. Until one
// has won its quality gate, production matches by words; development and
// tests use the deterministic local stand-in below, which needs no training.
import { createHash } from 'node:crypto';

export interface Embedder {
  /** Which model made the vectors: vectors from different models can't be compared. */
  readonly model: string;
  readonly dims: number;
  /** One unit-length vector per text, in order. Throws when it can't. */
  embed(texts: readonly string[]): Promise<number[][]>;
}

/** Columns of the stored vectors (pgvector halfvec(768)); smaller models are zero-padded. */
export const DIMS = 768;

/**
 * A deterministic stand-in with no network: words and word pairs hashed
 * into 768 buckets (the "hashing trick"). Questions sharing words land
 * close together; it knows no synonyms, so it is for development and tests,
 * never production.
 */
export function localEmbedder(): Embedder {
  return {
    model: 'local-hash-v1',
    dims: DIMS,
    embed(texts) {
      return Promise.resolve(
        texts.map(text => {
          const v = new Array<number>(DIMS).fill(0);
          const words =
            text
              .normalize('NFC')
              .toLowerCase()
              .match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
          const grams = [...words, ...words.slice(1).map((w, i) => `${words[i] ?? ''} ${w}`)];
          for (const g of grams) {
            const h = createHash('sha256').update(g).digest();
            const at = h.readUInt32BE(0) % DIMS;
            v[at] = (v[at] ?? 0) + (h[4] !== undefined && h[4] & 1 ? 1 : -1);
          }
          return unit(v);
        }),
      );
    },
  };
}

export class EmbeddingError extends Error {
  override name = 'EmbeddingError';
}

/**
 * What serves before Graphinity's own model has been promoted: the local
 * stand-in in development, nothing in production (matching by words: a
 * hashed-words stand-in is no search by meaning).
 */
export function chooseEmbedder(config: { production: boolean }): Embedder | null {
  return config.production ? null : localEmbedder();
}

/** Cosine similarity of two unit vectors: their dot product. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

/** pgvector's text form, "[0.1,0.2,...]": sent as a parameter, never spliced into SQL. */
export function vectorLiteral(v: readonly number[]): string {
  return `[${v.map(x => (Number.isFinite(x) ? x : 0).toPrecision(6)).join(',')}]`;
}

function unit(v: number[]): number[] {
  const length = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return length > 0 ? v.map(x => x / length) : v;
}
