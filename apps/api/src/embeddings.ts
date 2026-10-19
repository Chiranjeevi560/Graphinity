// Turning a question into numbers that sit close together when two
// questions mean the same thing (docs/SPEC.md §11.1, §12.1).
// Plumbing only (§12.2): embeddings find duplicates and similar questions;
// nothing here writes an answer.
//
// In production: Cloudflare Workers AI's free daily allowance (the owner's
// choice, docs/adr/0001). Past it, Cloudflare refuses rather than bills
// ("further operations will fail with an error", Workers AI pricing page,
// checked 2026-10-19), and Graphinity falls back to word matching.
// Without Cloudflare settings (development, tests): a deterministic local
// embedding that needs no network.
import { createHash } from 'node:crypto';

export interface Embedder {
  /** Which model made the vectors: vectors from different models can't be compared. */
  readonly model: string;
  readonly dims: number;
  /** One unit-length vector per text, in order. Throws when it can't. */
  embed(texts: readonly string[]): Promise<number[][]>;
}

/** bge-base-en-v1.5: 768 numbers, documented request and response; English, like Graphinity. */
export const WORKERS_AI_MODEL = '@cf/baai/bge-base-en-v1.5';
export const DIMS = 768;
const TIMEOUT_MS = 4000;

/**
 * Cloudflare Workers AI over its REST API: POST {text: [...], pooling:
 * "cls"} to /accounts/{id}/ai/run/{model}; the answer is {result: {shape,
 * data}}. "cls" pooling, as Cloudflare recommends, always: vectors made
 * with different pooling can't be compared.
 */
export function workersAiEmbedder(deps: { accountId: string; token: string; fetch: typeof fetch }): Embedder {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(deps.accountId)}/ai/run/${WORKERS_AI_MODEL}`;
  return {
    model: `workers-ai:${WORKERS_AI_MODEL}:cls`,
    dims: DIMS,
    async embed(texts) {
      if (texts.length === 0) return [];
      const res = await deps.fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${deps.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: texts, pooling: 'cls' }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new EmbeddingError(`workers ai ${String(res.status)}`);
      const body = (await res.json()) as { success?: boolean; result?: { data?: unknown } };
      const data = body.result?.data;
      if (body.success !== true || !Array.isArray(data) || data.length !== texts.length)
        throw new EmbeddingError('workers ai: unexpected answer');
      return data.map(row => {
        if (
          !Array.isArray(row) ||
          row.length !== DIMS ||
          !row.every(x => typeof x === 'number' && Number.isFinite(x))
        ) {
          throw new EmbeddingError('workers ai: unexpected vector');
        }
        return unit(row as number[]);
      });
    },
  };
}

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
              .match(/[\p{L}\p{N}]+/gu) ?? [];
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

/** Keeps the last few hundred vectors: someone typing sends the same text more than once. */
export function cached(inner: Embedder, size = 500): Embedder {
  const memo = new Map<string, number[]>();
  return {
    model: inner.model,
    dims: inner.dims,
    async embed(texts) {
      const keys = texts.map(t =>
        createHash('sha256').update(t.normalize('NFC').trim().toLowerCase()).digest('base64url'),
      );
      const missing = [...new Set(keys.filter(k => !memo.has(k)))];
      if (missing.length) {
        const fresh = await inner.embed(missing.map(k => texts[keys.indexOf(k)] ?? ''));
        missing.forEach((k, i) => {
          const v = fresh[i];
          if (!v) return;
          memo.delete(k);
          memo.set(k, v);
          if (memo.size > size) {
            const oldest = memo.keys().next().value;
            if (oldest !== undefined) memo.delete(oldest);
          }
        });
      }
      return keys.map(k => {
        const v = memo.get(k);
        if (!v) throw new EmbeddingError('missing vector');
        return v;
      });
    },
  };
}

export class EmbeddingError extends Error {
  override name = 'EmbeddingError';
}

/**
 * Which embedder the server runs with: Cloudflare when configured; the
 * local stand-in in development; none in production without Cloudflare
 * (word matching only: a hashed-words stand-in is no semantic search).
 */
export function chooseEmbedder(
  config: { production: boolean; workersAi: { accountId: string; token: string } | null },
  fetchImpl: typeof fetch,
): Embedder | null {
  if (config.workersAi) return cached(workersAiEmbedder({ ...config.workersAi, fetch: fetchImpl }));
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
