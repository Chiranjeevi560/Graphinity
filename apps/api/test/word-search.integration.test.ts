// BM25 by words in the database (migration 0020): the collection statistics
// stay exact through every change, the scores are BM25F to the formula, and
// nothing about it is open to the API role beyond calling the function.
import { beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './helpers/app.ts';
import { must } from './helpers/must.ts';

let h: TestApp;
let names = 0;

beforeAll(async () => {
  h = await startApp(() => Date.now());
  return h.close;
});

async function ask(title: string, body = '', field = 'imports-customs') {
  const p = await h.person();
  names += 1;
  expect(
    (
      await h.call('POST', '/me/profile', p.token, {
        handle: `bm.${String(names)}`,
        country: 'IN',
        fields: ['imports-customs', 'travel'],
        adult: true,
      })
    ).statusCode,
  ).toBe(201);
  const res = await h.call('POST', '/questions', p.token, { title, field, ...(body ? { details: body } : {}) });
  expect(res.statusCode).toBe(201);
  return must(res.json<{ question: { id: string } }>().question.id);
}

const wordSearch = async (query: string, opts: { also?: string[]; prefix?: string; field?: string } = {}) =>
  h.t.database.withUser(
    null,
    async q =>
      (
        await q.query<{ id: string; score: number }>(
          'SELECT id::text AS id, score FROM app.word_search($1, $2, $3, $4, 50)',
          [query, opts.also ?? [], opts.prefix ?? null, opts.field ?? null],
        )
      ).rows,
  );

/** The statistics recomputed from scratch, to compare with what the triggers kept. */
async function recount() {
  const kept = await h.t.owner.query<{ lexeme: string; docs: number }>(
    'SELECT lexeme, docs FROM app.search_lexemes WHERE docs > 0 ORDER BY lexeme',
  );
  const fresh = await h.t.owner.query<{ lexeme: string; docs: number }>(
    `SELECT word AS lexeme, ndoc AS docs FROM ts_stat('SELECT search FROM app.questions') ORDER BY word COLLATE "C"`,
  );
  const corpus = await h.t.owner.query<{ kept: string; total: string; docs: string; length: string }>(
    `SELECT c.docs::text AS kept, c.total_length::text AS total,
            (SELECT count(*) FROM app.questions)::text AS docs,
            (SELECT coalesce(sum(length(search)), 0) FROM app.questions)::text AS length
     FROM app.search_corpus c`,
  );
  return { kept: kept.rows, fresh: fresh.rows, corpus: must(corpus.rows[0]) };
}

describe('word search statistics', () => {
  it('stay exact as questions are posted, edited, given meaning and removed', async () => {
    const a = await ask('How much customs duty on a camera lens at Chennai?', 'Paid duty on a lens.');
    await ask('Customs clearance time for books at Delhi airport');
    const check = async () => {
      const r = await recount();
      expect(r.kept).toEqual(r.fresh);
      expect(r.corpus.kept).toBe(r.corpus.docs);
      expect(r.corpus.total).toBe(r.corpus.length);
    };
    await check();
    // An edit by the owner (the API can't edit text): old words out, new words in.
    await h.t.owner.query(
      "UPDATE app.questions SET title = 'How much import tax on a camera lens at Chennai?' WHERE id = $1",
      [a],
    );
    await check();
    // Storing a meaning changes no words, and leaves the counts alone.
    await h.t.owner.query("UPDATE app.questions SET embedding_model = 'm' WHERE id = $1", [a]);
    await check();
    // Several at once, as deleting an account does.
    await h.t.owner.query(
      'DELETE FROM app.questions WHERE id IN (SELECT id FROM app.questions ORDER BY id DESC LIMIT 2)',
    );
    await check();
  });
});

describe('word search ranking', () => {
  it('scores BM25F exactly: rare words count more, title words twice, long questions less', async () => {
    await h.t.owner.query('DELETE FROM app.questions');
    const lens = await ask('Camera lens customs at Chennai airport today');
    const watch = await ask('Watch customs at Chennai airport today please', 'Camera lens too.');
    const rows = await wordSearch('camera lens');
    const stats = must(
      (
        await h.t.owner.query<{ n: number; avg: number }>(
          'SELECT docs::float8 AS n, total_length::float8 / docs AS avg FROM app.search_corpus',
        )
      ).rows[0],
    );
    const docs = new Map(
      (
        await h.t.owner.query<{ id: string; len: number }>(
          'SELECT id::text AS id, length(search) AS len FROM app.questions',
        )
      ).rows.map(r => [r.id, r.len]),
    );
    // Both words are in both questions: df 2 of 2.
    const idf = Math.log(1 + (stats.n - 2 + 0.5) / (2 + 0.5));
    const bm25 = (tf: number, len: number) => (idf * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * len) / stats.avg));
    const expected = new Map([
      // In the title: each counts twice.
      [lens, 2 * bm25(2, must(docs.get(lens)))],
      // In the details only: once each.
      [watch, 2 * bm25(1, must(docs.get(watch)))],
    ]);
    expect(rows.map(r => r.id)).toEqual([lens, watch]);
    for (const r of rows) expect(r.score).toBeCloseTo(must(expected.get(r.id)), 9);
  });

  it('ranks a question holding the rare word above one holding only common ones', async () => {
    const rare = await ask('Is the BOE-II form needed for a gift parcel?');
    for (let i = 0; i < 4; i++) await ask(`Is a form needed for parcel number ${String(i)} at customs?`);
    const ids = (await wordSearch('form needed BOE-II')).map(r => r.id);
    expect(ids[0]).toBe(rare);
    expect(ids.length).toBe(5);
  });

  it('matches whole words, and only the word being typed as a beginning', async () => {
    const q = await ask('Importing a drone into Bengaluru: what paperwork?');
    // Stemmed like the stored text: "imports" and "importing" are one word.
    expect((await wordSearch('imports drone')).map(r => r.id)).toContain(q);
    // A beginning matches only as the word being typed.
    expect((await wordSearch('dro')).map(r => r.id)).not.toContain(q);
    expect((await wordSearch('dro', { prefix: 'dro' })).map(r => r.id)).toContain(q);
    // Wildcards typed by someone are letters, not patterns.
    expect(await wordSearch('%', { prefix: '%' })).toEqual([]);
    expect((await wordSearch('d_', { prefix: 'd_' })).map(r => r.id)).not.toContain(q);
  });

  it('searches the spelling model’s corrections too', async () => {
    const q = await ask('Which courier handles customs for spectacles?');
    expect((await wordSearch('spektacles')).map(r => r.id)).not.toContain(q);
    expect((await wordSearch('spektacles', { also: ['spectacles'] })).map(r => r.id)).toContain(q);
  });

  it('looks within a field, and never returns a hidden question', async () => {
    const travel = await ask('Travel insurance for a Schengen visa from Pune', '', 'travel');
    const hidden = await ask('Travel insurance for a parcel to Pune');
    await h.t.owner.query("INSERT INTO app.decisions (question_id, decision) VALUES ($1, 'remove')", [hidden]);
    expect((await wordSearch('insurance pune')).map(r => r.id)).toEqual([travel]);
    expect(await wordSearch('insurance pune', { field: 'imports-customs' })).toEqual([]);
  });

  it('still finds questions when one word alone is commoner than the candidate budget', async () => {
    // 1,200 questions holding "parcel": more than the 1,000 the budget allows from one word.
    // Loaded in bulk as the owner would, then recounted, as the runbook says.
    const asker = (await h.t.owner.query<{ id: string }>('SELECT asker_id AS id FROM app.questions LIMIT 1')).rows[0]
      ?.id;
    await h.t.owner.query('BEGIN');
    await h.t.owner.query("SET LOCAL session_replication_role = 'replica'");
    await h.t.owner.query(
      `INSERT INTO app.questions (asker_id, field, title)
       SELECT $1, 'imports-customs', 'Parcel number ' || g || ' held at the depot'
       FROM generate_series(1, 1200) g`,
      [must(asker)],
    );
    await h.t.owner.query('COMMIT');
    await h.t.owner.query('SELECT app.rebuild_search_stats()');
    const r = await recount();
    expect(r.kept).toEqual(r.fresh);
    const ids = (await wordSearch('parcel')).map(r => r.id);
    expect(ids.length).toBe(50);
    // From the newest 2,000 when one word is all there is.
    const newest = Number(
      (await h.t.owner.query<{ id: string }>('SELECT max(id)::text AS id FROM app.questions')).rows[0]?.id,
    );
    for (const id of ids) expect(Number(id)).toBeGreaterThan(newest - 2000);
  });

  it('answers nothing for text with no words, and for words nobody used', async () => {
    expect(await wordSearch('?!')).toEqual([]);
    expect(await wordSearch('zxqvbn')).toEqual([]);
  });
});

describe('word search statistics, protected', () => {
  it('are closed to the API role: it can only call the function', async () => {
    for (const sql of [
      'SELECT * FROM app.search_lexemes',
      'SELECT * FROM app.search_corpus',
      "INSERT INTO app.search_lexemes VALUES ('x', 1000000)",
      'UPDATE app.search_corpus SET docs = 0',
      'SELECT app.count_search_lexemes()',
    ])
      await expect(h.t.api.query(sql), sql).rejects.toMatchObject({ code: '42501' });
  });
});
