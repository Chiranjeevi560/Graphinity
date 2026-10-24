// Feature flags and kill switches, read from app.feature_flags (migration
// 0002). The owner flips one in the SQL editor; every server sees it within
// one refresh, with no deploy. Reads never wait on the database: they come
// from the last refresh, and a refresh that fails keeps the last known values,
// so a database blip can't switch a feature off (or on) by itself.
import type { Database } from './db.ts';
import type { Embedder } from './embeddings.ts';
import { EmbeddingError } from './embeddings.ts';

/** The switches the code knows, with the value used before the first refresh succeeds. */
export const FLAG_DEFAULTS = {
  /** Search by meaning through Cloudflare Workers AI. */
  embeddings: true,
  /** Notifications to people's devices. */
  push: true,
  /** Finite, consent-gated knowledge suggestions. */
  recommendations: true,
  /** Daily training of Graphinity's own models (ADR 0010). */
  model_training: true,
} as const;

export type FlagName = keyof typeof FLAG_DEFAULTS;

/**
 * How often servers re-read the flags. Thirty seconds bounds how long a kill
 * switch takes to work everywhere, for one tiny query per server per period
 * (2,880 a day, against no meaningful free-tier limit).
 */
export const REFRESH_MS = 30_000;

export interface Flags {
  enabled(name: FlagName): boolean;
  /** Re-reads now. Resolves even when the database can't be reached. */
  refresh(): Promise<void>;
  stop(): void;
}

export function createFlags(
  db: Pick<Database, 'query'>,
  options: { refreshMs?: number; onChange?: (name: string, enabled: boolean) => void } = {},
): Flags {
  const values = new Map<string, boolean>();
  const refresh = async () => {
    try {
      const { rows } = await db.query<{ name: string; enabled: boolean }>(
        'SELECT name, enabled FROM app.feature_flags',
      );
      for (const r of rows) {
        const before = values.get(r.name);
        values.set(r.name, r.enabled);
        if (before !== undefined && before !== r.enabled) options.onChange?.(r.name, r.enabled);
      }
    } catch {
      // Keep the last known values; the next refresh tries again.
    }
  };
  const timer = setInterval(() => void refresh(), options.refreshMs ?? REFRESH_MS);
  timer.unref();
  return {
    enabled: name => values.get(name) ?? FLAG_DEFAULTS[name],
    refresh,
    stop: () => {
      clearInterval(timer);
    },
  };
}

/**
 * The embedder, behind the `embeddings` switch. Off, it refuses like an
 * exhausted Cloudflare allowance does, so every caller's existing fallback
 * (matching by words) takes over with no change to the callers.
 */
export function switchedEmbedder(inner: Embedder, flags: Pick<Flags, 'enabled'>): Embedder {
  return {
    // Read through on every use: the inner model can be replaced while the server runs.
    get model() {
      return inner.model;
    },
    get dims() {
      return inner.dims;
    },
    embed: texts =>
      flags.enabled('embeddings') ? inner.embed(texts) : Promise.reject(new EmbeddingError('turned off')),
  };
}
