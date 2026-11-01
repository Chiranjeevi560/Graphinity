// POST /search on a real database with pgvector (ADR 0015 part 2): one engine
// with the Ask check, results anyone may see, reasons in words, its own limit
// and kill switch.
import { enrol } from '../src/experiments/enrol.ts';
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

describe('the cascade and diversified search', () => {
  const titles = ['customs duty on watches', 'customs duty on a watch', 'customs duty for watches abroad'];
  const body = { query: 'customs duty' };

  it('answers with each stage, and refuses unknown fields and long context', async () => {
    for (const t of titles) await ask(t);
    await ask('customs duty on old cameras');
    const res = await h.call('POST', '/search/retrieve-and-rank', undefined, body);
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json<{
      results: Array<{ propensity: number; trace: { retrieved: number; shown: number } }>;
      stages: { retrieved: number; shown: number };
    }>();
    expect(out.stages.shown).toBe(out.results.length);
    expect(out.results.length).toBeGreaterThan(1);
    out.results.forEach((r, i) => {
      expect(r.propensity).toBe(1);
      expect(r.trace.shown).toBe(i + 1);
      expect(r.trace.retrieved).toBeGreaterThan(0);
    });
    expect(
      (await h.call('POST', '/search/retrieve-and-rank', undefined, { query: 'x y', countryIso: 'IN' })).statusCode,
    ).toBe(400);
    const context = Array.from({ length: 6 }, () => 'travel');
    expect(
      (await h.call('POST', '/search/retrieve-and-rank', undefined, { ...body, sessionGraphContext: context }))
        .statusCode,
    ).toBe(400);
  });

  it('says the same refusals as search does', async () => {
    const call = (app: TestApp, query: string) => app.call('POST', '/search/retrieve-and-rank', undefined, { query });
    const short = await call(h, 'x');
    expect(short.statusCode).toBe(200);
    expect(short.json()).toEqual({ results: [], stages: { retrieved: 0, preRanked: 0, ranked: 0, shown: 0 } });
    const long = await call(h, 'a'.repeat(201));
    expect(long.statusCode).toBe(400);
    expect(long.json<{ reason: string }>().reason).toBe('too_long');
    expect((await call(h, 'a\u0000b')).statusCode).toBe(400);
    const off = await startApp(() => 0, { searchEnabled: () => false });
    try {
      expect((await call(off, 'customs')).statusCode).toBe(503);
    } finally {
      await off.close();
    }
    const tight = await startApp(() => 0, { limits: { search: { capacity: 1, refillPerSecond: 0.001, maxKeys: 10 } } });
    try {
      expect((await call(tight, 'customs')).statusCode).toBe(200);
      const refused = await call(tight, 'customs');
      expect(refused.statusCode).toBe(429);
      expect(refused.headers['retry-after']).toBeTruthy();
    } finally {
      await tight.close();
    }
  });

  it('lifts a topic the session is heading to, and only a little', async () => {
    await ask('customs duty on hotel bookings', 'travel');
    await h.t.owner.query(
      `INSERT INTO app.kg_session_transitions (from_key, to_key, prior_key, decayed_transition_count)
       VALUES ('imports-customs', 'travel', '', 9) ON CONFLICT (from_key, to_key, prior_key) DO NOTHING`,
    );
    const res = await h.call('POST', '/search/retrieve-and-rank', undefined, {
      ...body,
      sessionGraphContext: ['imports-customs'],
    });
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json<{
      results: Array<{ field: { slug: string }; trace: { retrieved: number; preRanked: number } }>;
    }>();
    const travel = out.results.find(r => r.field.slug === 'travel');
    expect(must(travel).trace.preRanked).toBeLessThan(must(travel).trace.retrieved);
  });

  it('hands over vectors only for what may be seen, and refuses a huge request', async () => {
    const id = await ask('customs duty hidden vector question');
    const vector = `[${new Array(DIMS).fill(0.1).join(',')}]`;
    await h.t.owner.query(
      'INSERT INTO app.question_embeddings (question_id, model, embedding) VALUES ($1, $2, $3::extensions.halfvec)',
      [id, 'vector-test', vector],
    );
    const read = (ids: string) =>
      h.t.database.withUser(null, q => q.query(`SELECT * FROM app.question_vectors(${ids}::bigint[], 'vector-test')`));
    expect((await read(`ARRAY[${id}]`)).rowCount).toBe(1);
    expect((await read(`ARRAY(SELECT generate_series(1, 200) UNION ALL SELECT ${id})`)).rowCount).toBe(0);
    await h.t.owner.query(`INSERT INTO app.decisions (question_id, decision) VALUES ($1, 'remove')`, [id]);
    expect((await read(`ARRAY[${id}]`)).rowCount).toBe(0);
  });

  it('diversifies only for people who chose to help, in the treatment arm of a running experiment', async () => {
    const app = await startApp(() => Date.now(), { embedder: meaning });
    try {
      // The last is longest, so words rank it last; its meaning is the one that differs.
      const ids = await Promise.all(
        [
          'saffron tariff first',
          'saffron tariff second',
          'saffron tariff third with many more words than the others',
        ].map(t => ask(t, 'imports-customs', app)),
      );
      // The first two are a perfect match in meaning and the third isn't, so plain search also puts it last.
      const near = must((await meaning.embed(['saffron tariff']))[0]).indexOf(1);
      for (const [i, id] of ids.entries()) {
        const v = new Array<number>(DIMS).fill(0);
        v[i === 2 ? (near + 1) % DIMS : near] = 1;
        await app.t.owner.query(
          `INSERT INTO app.question_embeddings (question_id, model, embedding) VALUES ($1, $2, $3::extensions.halfvec)
           ON CONFLICT (question_id, model) DO UPDATE SET embedding = EXCLUDED.embedding`,
          [id, meaning.model, `[${v.join(',')}]`],
        );
      }
      const layer = (
        await app.t.owner.query<{ id: string }>(
          `INSERT INTO app.exp_layers (name) VALUES ('search_d') RETURNING layer_id AS id`,
        )
      ).rows[0]?.id;
      // Nearly everyone in treatment, so the arm isn't what this test depends on.
      await app.t.owner.query(
        `INSERT INTO app.exp_definitions (layer_id, name, bucket_start, bucket_end, control_share, status)
         VALUES ($1, 'search_diversity', 0, 10000, 0.0001, 'running')`,
        [layer],
      );
      const stamped = await app.t.owner.query<{ s: Date | null }>(
        `SELECT started_at AS s FROM app.exp_definitions WHERE name = 'search_diversity'`,
      );
      expect(stamped.rows[0]?.s).toBeTruthy();
      const search = async (token: string) =>
        (await app.call('POST', '/search', token, { query: 'saffron tariff' }))
          .json<{ results: Result[] }>()
          .results.map(r => r.id);
      const helper = await member(app);
      const other = await member(app);
      await app.call('PUT', '/me/consents', helper.token, {
        choices: [{ category: 'search_improvement', enabled: true }],
      });
      const plain = await search(other.token);
      expect(plain.slice(0, 2).includes(must(ids[2]))).toBe(false);
      const diverse = await search(helper.token);
      expect(diverse.slice(0, 2).includes(must(ids[2]))).toBe(true);
      const enrolled = async (id: string) =>
        (await app.t.owner.query('SELECT 1 FROM app.exp_unit_metrics WHERE subject = $1', [id])).rowCount;
      expect(await enrolled(helper.id)).toBe(1);
      expect(await enrolled(other.id)).toBe(0);
      // Consent is checked where the row is written, so withdrawing can't slip between the two.
      expect(await enrol(app.t.database, other.id, 'search_diversity')).toBeNull();
      expect(await enrolled(other.id)).toBe(0);
      // Who saw what is on the record, so later learning can tell these apart.
      const logged = await app.t.owner.query<{ experiment: string }>(
        'SELECT experiment FROM app.searches WHERE user_id = $1',
        [helper.id],
      );
      expect(logged.rows[0]?.experiment).toBe('search_diversity/treatment');
      // Asking which arm enters nobody, and withdrawing forgets.
      const fresh = await member(app);
      expect((await app.call('GET', '/me/experiments', fresh.token)).statusCode).toBe(200);
      expect(await enrolled(fresh.id)).toBe(0);
      await app.call('PUT', '/me/consents', helper.token, {
        choices: [{ category: 'search_improvement', enabled: false }],
      });
      expect(await enrolled(helper.id)).toBe(0);
    } finally {
      await app.close();
    }
  });
});
