import { describe, expect, it } from 'vitest';
import { DIMS, EmbeddingError } from '../src/embeddings.ts';
import { modelName, ownEmbedder, ownEmbedderFromArtifact, swappableEmbedder } from '../src/ml/own-embedder.ts';
import { serializeModel, trainTextEmbedding } from '../src/ml/text-embedding.ts';

const model = trainTextEmbedding(
  ['customs duty on a watch', 'import tax on a watch', 'customs duty on a phone', 'import tax on a phone'],
  { dims: 6 },
);

describe('the own embedder', () => {
  it('names its version and pads to the database’s columns, which leaves similarity unchanged', async () => {
    const e = ownEmbedder(model, 4);
    expect(e.model).toBe(modelName(4));
    const [v] = await e.embed(['customs duty']);
    expect(v).toHaveLength(DIMS);
    expect(v?.slice(model.dims).every(x => x === 0)).toBe(true);
    expect(Math.hypot(...(v ?? []))).toBeCloseTo(1, 6);
  });

  it('gives text with no words a stable vector of its own, never all zeros', async () => {
    const e = ownEmbedder(model, 1);
    const [a, b, c] = await e.embed(['?!?! ...', '?!?! ...', '***']);
    expect(a?.some(x => x !== 0)).toBe(true);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('loads from its artifact, and refuses a model too wide for the columns', async () => {
    const loaded = ownEmbedderFromArtifact(serializeModel(model), 2);
    expect(await loaded.embed(['import tax'])).toEqual(await ownEmbedder(model, 2).embed(['import tax']));
    expect(() => ownEmbedder({ ...model, dims: DIMS + 1 }, 1)).toThrow(EmbeddingError);
  });
});

describe('the swappable embedder', () => {
  it('refuses while nothing serves, then serves whatever was set, by its own name', async () => {
    const live = swappableEmbedder(null);
    expect(live.current()).toBeNull();
    expect(live.embedder.model).toBe('none');
    expect(live.embedder.dims).toBe(DIMS);
    await expect(live.embedder.embed(['x'])).rejects.toBeInstanceOf(EmbeddingError);
    const v1 = ownEmbedder(model, 1);
    live.set(v1);
    expect(live.embedder.model).toBe(modelName(1));
    expect(await live.embedder.embed(['customs duty'])).toEqual(await v1.embed(['customs duty']));
    live.set(ownEmbedder(model, 2));
    expect(live.embedder.model).toBe(modelName(2));
  });
});
