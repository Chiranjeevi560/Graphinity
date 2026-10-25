// POST /search on a real database with pgvector (ADR 0015 part 2): one engine
// with the Ask check, results anyone may see, reasons in words, its own limit
// and kill switch.
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Embedder } from '../src/embeddings.ts';
import { speller, trainSpelling } from '../src/ml/spelling.ts';
import { startApp, type TestApp } from './helpers/app.ts';
import { must } from './helpers/must.ts';

/**
 * Meaning the test controls: anything about paying tax or duty points one
 * way; any other text points its own way, far from everything else. So
 * "import tax" is close in meaning to "customs duty" while sharing none of its
 * words, as a trained model makes it, and nothing else is close to anything.
 */
const DIMS = 768;
const meaning: Embedder = {
  model: 'test-meaning-v1',
  dims: DIMS,
  embed: texts =>
    Promise.resolve(
      texts.map(t => {
        const v = new Array<number>(DIMS).fill(0);
        v[
          /\b(tax|duty|levy)\b/i.test(t)
            ? 0
            : 1 + (createHash('sha256').update(t).digest().readUInt16BE(0) % (DIMS - 1))
        ] = 1;
        return v;
      }),
    ),
};

let h: TestApp;
let names = 0;

beforeAll(async () => {
  h = await startApp(() => Date.now(), { embedder: meaning });
  return h.close;
});

async function member(app: TestApp = h) {
  const p = await app.person();
  names += 1;
  expect(
    (
      await app.call('POST', '/me/profile', p.token, {
        handle: `find.${String(names)}`,
        country: 'IN',
        fields: ['imports-customs', 'travel'],
        adult: true,
      })
    ).statusCode,
  ).toBe(201);
  return p;
}

async function ask(title: string, field = 'imports-customs', app: TestApp = h) {
  const p = await member(app);
  const res = await app.call('POST', '/questions', p.token, { title, field });
  expect(res.statusCode).toBe(201);
  return must(res.json<{ question: { id: string } }>().question.id);
}

interface Result {
  id: string;
  title: string;
  field: { slug: string; name: string };
  answerCount: number;
  lastAnsweredAt: string | null;
  reasons: string[];
}
interface Search {
  results: Result[];
  corrections: Array<{ from: string; to: string }>;
  meaning: boolean;
}
const search = async (query: string, extra: object = {}, token?: string, app: TestApp = h) => {
  const res = await app.call('POST', '/search', token, { query, ...extra });
  expect(res.statusCode).toBe(200);
  return res.json<Search>();
};

describe('search', () => {
  it('finds by words and by meaning, and says which, in words', async () => {
    const duty = await ask('How much customs duty did you pay on a watch at Chennai airport?');
    const visa = await ask('How long did your Schengen visa appointment take in Delhi?', 'travel');
    // Shares no word with the duty question: only meaning can find it.
    const byMeaning = await search('import tax');
    expect(byMeaning.meaning).toBe(true);
    expect(byMeaning.results.find(r => r.id === duty)).toMatchObject({ reasons: ['meaning'] });
    // Nearest by meaning, but nowhere near it: left out, not padded in.
    expect(byMeaning.results.map(r => r.id)).not.toContain(visa);
    // Every word, and close in meaning too.
    expect((await search('customs duty watch')).results[0]).toMatchObject({
      id: duty,
      reasons: ['every_word', 'meaning'],
      field: { slug: 'imports-customs' },
      answerCount: 0,
      lastAnsweredAt: null,
    });
    // Some of the words only.
    expect((await search('schengen passport')).results.find(r => r.id === visa)).toMatchObject({
      reasons: ['some_words'],
    });
  });

  it('finds exact codes that mean nothing to a model', async () => {
    const q = await ask('Do I need the BOE-II form for a gift parcel under 10,000?');
    expect((await search('BOE-II')).results[0]).toMatchObject({ id: q, reasons: ['every_word'] });
  });

  it('matches whole words on the Search screen, and completes the word being typed only in the Ask check', async () => {
    const q = await ask('Shipping a harmonium from Kolkata: which courier?');
    // A search is submitted whole: "harmon" is not a word anyone means.
    expect((await search('harmon kolkata')).results.find(r => r.id === q)).toMatchObject({ reasons: ['some_words'] });
    expect((await search('harmon')).results.map(r => r.id)).not.toContain(q);
    // While typing a question, the last word is unfinished, and "harmon" may become "harmonium".
    const typed = await h.call('POST', '/questions/precheck', undefined, { title: 'Courier for my harmon' });
    expect(typed.json<{ questions: Array<{ id: string }> }>().questions.map(x => x.id)).toContain(q);
  });

  it('sends nothing about other people: no trust, reputation or authors', async () => {
    await ask('Which courier clears camera lenses fastest at Mumbai customs?');
    const { results } = await search('camera lenses');
    expect(results.length).toBeGreaterThan(0);
    for (const r of results)
      expect(Object.keys(r).sort()).toEqual(['answerCount', 'field', 'id', 'lastAnsweredAt', 'reasons', 'title']);
  });

  it('times each stage in Server-Timing, and nothing else', async () => {
    const res = await h.call('POST', '/search', undefined, { query: 'customs duty' });
    const timing = String(res.headers['server-timing']);
    expect(timing).toMatch(/^embed;dur=[\d.]+, words;dur=[\d.]+, meaning;dur=[\d.]+, fetch;dur=[\d.]+$/);
  });

  it('looks within a field when asked to', async () => {
    const travel = await ask('Is travel insurance needed for a Schengen visa from Hyderabad?', 'travel');
    const customs = await ask('Is insurance needed for a parcel cleared through Hyderabad customs?');
    const ids = (await search('insurance hyderabad', { field: 'travel' })).results.map(r => r.id);
    expect(ids).toContain(travel);
    expect(ids).not.toContain(customs);
  });

  it('never shows a hidden question', async () => {
    const q = await ask('Can I carry three bottles of whisky through Kochi airport duty free?');
    await h.t.owner.query("INSERT INTO app.decisions (question_id, decision) VALUES ($1, 'remove')", [q]);
    const { results } = await search('whisky kochi duty');
    expect(results.map(r => r.id)).not.toContain(q);
  });

  it('keeps a signed-in search in their own history only while they allow it', async () => {
    const p = await member();
    const history = async () =>
      (
        await h.t.owner.query<{ signal_type: string; value: unknown }>(
          `SELECT signal_type, value FROM app.personal_signal_events
           WHERE user_id = $1 AND consent_category = 'search_history'`,
          [p.id],
        )
      ).rows;
    await search('courier customs', {}, p.token);
    expect(await history()).toEqual([]);
    expect(
      (await h.call('PUT', '/me/consents', p.token, { choices: [{ category: 'search_history', enabled: true }] }))
        .statusCode,
    ).toBe(200);
    await search('courier customs', { field: 'imports-customs' }, p.token);
    expect(await history()).toEqual([
      { signal_type: 'search', value: { query: 'courier customs', field: 'imports-customs' } },
    ]);
  });

  it('answers a search too short to mean anything with nothing, and refuses what it can’t search', async () => {
    expect(await search('a')).toEqual({ results: [], corrections: [], meaning: false });
    const long = await h.call('POST', '/search', undefined, { query: 'customs '.repeat(30) });
    expect(long.statusCode).toBe(400);
    expect(long.json()).toMatchObject({ error: 'invalid_query', reason: 'too_long' });
    const control = await h.call('POST', '/search', undefined, { query: 'customs\u0007duty' });
    expect(control.statusCode).toBe(400);
    expect(control.json()).toMatchObject({ error: 'invalid_query', reason: 'invalid_characters' });
    expect((await h.call('POST', '/search', undefined, { query: 'customs', page: 2 })).statusCode).toBe(400);
    expect((await h.call('POST', '/search', undefined, { query: 7 })).statusCode).toBe(400);
    expect((await h.call('POST', '/search', undefined, { query: 'customs', field: 'Nope!' })).statusCode).toBe(400);
    // Never in the address: there is no GET form to put a search in a URL.
    expect((await h.call('GET', '/search?query=customs')).statusCode).toBe(404);
  });
});

describe('search, with Graphinity’s own spelling model', () => {
  it('finds through typos and says what it also searched for', async () => {
    const learned = speller(
      trainSpelling(
        Array.from({ length: 5 }, () => 'customs duty on a camera lens at the airport'),
        { lambda: 4, mu: 5, minCount: 2, keep: -1000 },
      ),
    );
    const app = await startApp(() => Date.now(), { speller: learned });
    try {
      const q = await ask('Customs duty on a camera lens', 'imports-customs', app);
      const found = await search('cusotms camrea please', {}, undefined, app);
      // Words only here (no model serving), and still found.
      expect(found.meaning).toBe(false);
      expect(found.corrections).toEqual([
        { from: 'cusotms', to: 'customs' },
        { from: 'camrea', to: 'camera' },
      ]);
      expect(found.results[0]).toMatchObject({ id: q, reasons: ['some_words'] });
    } finally {
      await app.close();
    }
  });
});

describe('search, protected', () => {
  it('refuses while switched off, and the Ask check keeps working', async () => {
    let on = false;
    const app = await startApp(() => Date.now(), { searchEnabled: () => on });
    try {
      const res = await app.call('POST', '/search', undefined, { query: 'customs duty' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: 'search_off' });
      expect(
        (await app.call('POST', '/questions/precheck', undefined, { title: 'Customs duty on a camera lens' }))
          .statusCode,
      ).toBe(200);
      on = true;
      expect((await app.call('POST', '/search', undefined, { query: 'customs duty' })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('limits each visitor and each person on their own', async () => {
    const app = await startApp(() => 0, { limits: { search: { capacity: 2, refillPerSecond: 0.5, maxKeys: 100 } } });
    try {
      const go = (token?: string) => app.call('POST', '/search', token, { query: 'customs duty' });
      expect((await go()).statusCode).toBe(200);
      expect((await go()).statusCode).toBe(200);
      const refused = await go();
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject({ error: 'rate_limited' });
      expect(refused.headers['retry-after']).toBe('2');
      // A signed-in person behind the same address has their own allowance.
      const p = await app.person();
      expect((await go(p.token)).statusCode).toBe(200);
      expect((await go(p.token)).statusCode).toBe(200);
      expect((await go(p.token)).statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });
});
