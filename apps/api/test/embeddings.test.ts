import { describe, expect, it } from 'vitest';
import { cached, chooseEmbedder, cosine, DIMS, EmbeddingError, localEmbedder, vectorLiteral, workersAiEmbedder, WORKERS_AI_MODEL } from '../src/embeddings.ts';

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

describe('Cloudflare Workers AI', () => {
  const vector = Array.from({ length: DIMS }, (_, i) => (i === 0 ? 3 : 0));
  function fake(status: number, body: unknown) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = ((url: string, init: RequestInit) => { calls.push({ url, init }); return Promise.resolve(new Response(JSON.stringify(body), { status })); }) as unknown as typeof fetch;
    return { f, calls };
  }

  it('asks the documented endpoint with cls pooling and returns unit vectors', async () => {
    const { f, calls } = fake(200, { success: true, result: { shape: [2, DIMS], data: [vector, vector], pooling: 'cls' } });
    const out = await workersAiEmbedder({ accountId: 'acc 1', token: 'tok', fetch: f }).embed(['a', 'b']);
    expect(out).toHaveLength(2);
    expect(out[0]?.[0]).toBeCloseTo(1, 10);
    expect(calls[0]?.url).toBe(`https://api.cloudflare.com/client/v4/accounts/acc%201/ai/run/${WORKERS_AI_MODEL}`);
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Bearer tok');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ text: ['a', 'b'], pooling: 'cls' });
  });

  it('refuses anything but the expected answer (the free allowance used up, an outage, a changed format)', async () => {
    const attempt = (status: number, body: unknown) => workersAiEmbedder({ accountId: 'a', token: 't', fetch: fake(status, body).f }).embed(['x']);
    await expect(attempt(429, { success: false })).rejects.toBeInstanceOf(EmbeddingError);
    await expect(attempt(200, { success: false, errors: [{ message: 'limit' }] })).rejects.toBeInstanceOf(EmbeddingError);
    await expect(attempt(200, { success: true, result: { data: [[1, 2, 3]] } })).rejects.toBeInstanceOf(EmbeddingError);
    await expect(attempt(200, { success: true, result: { data: [] } })).rejects.toBeInstanceOf(EmbeddingError);
    await expect(attempt(200, { success: true, result: { data: [vector.map(() => Number.NaN)] } })).rejects.toBeInstanceOf(EmbeddingError);
  });
});

describe('the cache', () => {
  it('asks once per distinct text, however often it’s typed', async () => {
    let asked = 0;
    const counting = { model: 'm', dims: 2, embed: (texts: readonly string[]) => { asked += texts.length; return Promise.resolve(texts.map(() => [1, 0])); } };
    const c = cached(counting, 2);
    await c.embed(['Hello there', 'hello there ']);
    await c.embed(['Hello there']);
    expect(asked).toBe(1);
    await c.embed(['two']);
    await c.embed(['three']);
    await c.embed(['hello there']);
    expect(asked).toBe(4);
  });
});

describe('vectors in SQL', () => {
  it('writes pgvector’s text form, with nonsense made 0', () => {
    expect(vectorLiteral([0.5, -1, Number.NaN])).toBe('[0.500000,-1.00000,0.00000]');
  });
});

describe('edges', () => {
  it('sends nothing for nothing, and gives text without words a zero vector, not NaN', async () => {
    let called = false;
    const e = workersAiEmbedder({ accountId: 'a', token: 't', fetch: (() => { called = true; return Promise.reject(new Error('no')); }) });
    expect(await e.embed([])).toEqual([]);
    expect(called).toBe(false);
    const [blank] = await localEmbedder().embed(['?!']);
    expect(blank?.every(x => x === 0)).toBe(true);
  });
});

describe('which embedder the server runs with', () => {
  const fetchNever = (() => Promise.reject(new Error('unused'))) as unknown as typeof fetch;
  it('uses Cloudflare when configured, the local stand-in in development, and nothing in production without it', () => {
    expect(chooseEmbedder({ production: true, workersAi: { accountId: 'a'.repeat(32), token: 't'.repeat(24) } }, fetchNever)?.model).toBe(`workers-ai:${WORKERS_AI_MODEL}:cls`);
    expect(chooseEmbedder({ production: false, workersAi: null }, fetchNever)?.model).toBe('local-hash-v1');
    expect(chooseEmbedder({ production: true, workersAi: null }, fetchNever)).toBeNull();
  });
});
