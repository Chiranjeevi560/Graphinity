import { describe, expect, it } from 'vitest';
import { createFlags, FLAG_DEFAULTS, switchedEmbedder } from '../src/flags.ts';
import { EmbeddingError, localEmbedder } from '../src/embeddings.ts';

const fakeDb = (answers: Array<Array<{ name: string; enabled: boolean }> | Error>) => ({
  query: () => {
    const next = answers.shift() ?? new Error('no more answers');
    return next instanceof Error ? Promise.reject(next) : Promise.resolve({ rows: next });
  },
});

describe('createFlags', () => {
  it('uses the defaults until the first read succeeds', () => {
    const flags = createFlags(fakeDb([]) as never);
    expect(flags.enabled('embeddings')).toBe(FLAG_DEFAULTS.embeddings);
    expect(flags.enabled('push')).toBe(FLAG_DEFAULTS.push);
    flags.stop();
  });

  it('keeps the last known values when a read fails, so a blip switches nothing', async () => {
    const flags = createFlags(fakeDb([[{ name: 'push', enabled: false }], new Error('connection reset')]) as never);
    await flags.refresh();
    expect(flags.enabled('push')).toBe(false);
    await flags.refresh();
    expect(flags.enabled('push')).toBe(false);
    flags.stop();
  });
});

describe('switchedEmbedder', () => {
  it('passes through while on, and refuses like a spent allowance while off', async () => {
    let on = true;
    const embedder = switchedEmbedder(localEmbedder(), { enabled: () => on });
    expect(await embedder.embed(['a question'])).toHaveLength(1);
    on = false;
    await expect(embedder.embed(['a question'])).rejects.toBeInstanceOf(EmbeddingError);
  });
});
