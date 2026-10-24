import { describe, expect, it } from 'vitest';
import { chooseEmbedder, cosine, DIMS, localEmbedder, vectorLiteral } from '../src/embeddings.ts';

describe('the local embedding (development and tests)', () => {
  it('is deterministic, unit length, and puts shared wording close together', async () => {
    const e = localEmbedder();
    const [a, b, c, again] = await e.embed([
      'How much customs did you pay importing a watch through Chennai?',
      'How much customs duty did you pay on a watch at Chennai?',
      'Best schools for kids in Dubai with an IB curriculum',
      'How much customs did you pay importing a watch through Chennai?',
    ]);
    expect(a).toEqual(again);
    expect(a).toHaveLength(DIMS);
    expect(cosine(a ?? [], a ?? [])).toBeCloseTo(1, 10);
    expect(cosine(a ?? [], b ?? [])).toBeGreaterThan(cosine(a ?? [], c ?? []));
  });
});

describe('vectors in SQL', () => {
  it('writes pgvector’s text form, with nonsense made 0', () => {
    expect(vectorLiteral([0.5, -1, Number.NaN])).toBe('[0.500000,-1.00000,0.00000]');
  });
});

describe('edges', () => {
  it('gives text without words a zero vector, not NaN', async () => {
    const [blank] = await localEmbedder().embed(['?!']);
    expect(blank?.every(x => x === 0)).toBe(true);
  });
});

describe('which embedder the server runs with', () => {
  it('is the local stand-in in development and nothing in production, until Graphinity’s own model is promoted', () => {
    expect(chooseEmbedder({ production: false })?.model).toBe('local-hash-v1');
    expect(chooseEmbedder({ production: true })).toBeNull();
  });
});
