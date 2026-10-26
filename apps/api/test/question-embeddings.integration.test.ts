// Meaning stored at the model's own size (migration 0021): an index searched
// the way it was measured, models and sizes never mixed, and the table open
// to the API only as far as each step needs.
import { beforeAll, describe, expect, it } from 'vitest';
import { embedMissing, PRUNE_BATCH } from '../src/backfill.ts';
import { vectorLiteral, type Embedder } from '../src/embeddings.ts';
import { startApp, type TestApp } from './helpers/app.ts';
import { must } from './helpers/must.ts';

/** A unit vector of `dims` numbers along `axis`, leaning `lean` towards the next axis. */
function towards(dims: number, axis: number, lean = 0): number[] {
  const v = new Array<number>(dims).fill(0);
  v[axis % dims] = Math.sqrt(1 - lean * lean);
  v[(axis + 1) % dims] = lean;
  return v;
}

/** The own model's size, with meaning the test controls: anything about duty points along axis 0. */
const own: Embedder = {
  model: 'graphinity:test:v1',
  dims: 128,
  embed: texts => Promise.resolve(texts.map(t => towards(128, /duty/i.test(t) ? 0 : 5))),
};

let h: TestApp;
let names = 0;

beforeAll(async () => {
  h = await startApp(() => Date.now(), { embedder: own });
  return h.close;
});

async function person() {
  const p = await h.person();
  names += 1;
  expect(
    (
      await h.call('POST', '/me/profile', p.token, {
        handle: `vec.${String(names)}`,
        country: 'IN',
        fields: ['imports-customs', 'travel'],
        adult: true,
      })
    ).statusCode,
  ).toBe(201);
  return p;
}

async function ask(title: string, field = 'imports-customs') {
  const p = await person();
  const res = await h.call('POST', '/questions', p.token, { title, field });
  expect(res.statusCode).toBe(201);
  return { id: must(res.json<{ question: { id: string } }>().question.id), asker: p };
}

/** As the owner, so a test can place vectors exactly. */
async function place(questionId: string, v: number[], model = own.model) {
  await h.t.owner.query(
    `INSERT INTO app.question_embeddings (question_id, model, embedding) VALUES ($1, $2, $3::extensions.halfvec)
     ON CONFLICT (question_id, model) DO UPDATE SET embedding = excluded.embedding`,
    [questionId, model, vectorLiteral(v)],
  );
}

const nearest = (v: number[], opts: { model?: string; field?: string; lim?: number } = {}) =>
  h.t.database.withUser(
    null,
    async q =>
      (
        await q.query<{ id: string; similarity: number }>(
          'SELECT id::text AS id, similarity FROM app.nearest_questions($1, $2, $3, $4)',
          [vectorLiteral(v), opts.model ?? own.model, opts.field ?? null, opts.lim ?? 10],
        )
      ).rows,
  );

describe('meaning at the model’s own size', () => {
  it('stores a new question’s vector unpadded, by the model that made it', async () => {
    const { id } = await ask('How much customs duty on a camera lens at Chennai?');
    const { rows } = await h.t.owner.query<{ model: string; dims: number }>(
      'SELECT model, extensions.vector_dims(embedding) AS dims FROM app.question_embeddings WHERE question_id = $1',
      [id],
    );
    expect(rows).toEqual([{ model: own.model, dims: 128 }]);
  });

  it('searches 128 numbers through the index, nearest first, with similarities', async () => {
    const a = (await ask('Which courier clears books fastest in Delhi?')).id;
    const b = (await ask('Which courier clears toys fastest in Delhi?')).id;
    await place(a, towards(128, 40));
    await place(b, towards(128, 40, 0.6));
    const found = await nearest(towards(128, 40), { lim: 2 });
    expect(found.map(r => r.id)).toEqual([a, b]);
    expect(must(found[0]).similarity).toBeCloseTo(1, 3);
    expect(must(found[1]).similarity).toBeCloseTo(0.8, 2);
    // The plan the function runs: the 128-number index, not a scan of every vector.
    const plan = await h.t.owner.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT e.question_id FROM app.question_embeddings e
       WHERE extensions.vector_dims(e.embedding) = 128
       ORDER BY e.embedding::extensions.halfvec(128) OPERATOR(extensions.<=>) $1::extensions.halfvec(128) LIMIT 10`,
      [vectorLiteral(towards(128, 40))],
    );
    expect(plan.rows.map(r => r['QUERY PLAN']).join('\n')).toContain('question_embeddings_128');
  });

  it('is not starved by filtering: many closer vectors of another model still leave a full answer', async () => {
    const mine: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { id } = await ask(`Shipping a harmonium number ${String(i)} from Kolkata`);
      mine.push(id);
      await place(id, towards(128, 90, 0.3));
    }
    // 120 questions nearer to the target, all from another model: the index meets them first.
    const { rows } = await h.t.owner.query<{ id: string }>(
      `SELECT id::text AS id FROM app.questions ORDER BY id DESC LIMIT 1`,
    );
    const asker = (
      await h.t.owner.query<{ asker: string }>('SELECT asker_id AS asker FROM app.questions WHERE id = $1', [
        must(rows[0]).id,
      ])
    ).rows[0]?.asker;
    await h.t.owner.query('BEGIN');
    await h.t.owner.query("SET LOCAL session_replication_role = 'replica'");
    const others = await h.t.owner.query<{ id: string }>(
      `INSERT INTO app.questions (asker_id, field, title)
       SELECT $1, 'imports-customs', 'A crowded question number ' || g FROM generate_series(1, 120) g RETURNING id::text AS id`,
      [must(asker)],
    );
    await h.t.owner.query('COMMIT');
    for (const o of others.rows) await place(o.id, towards(128, 90), 'graphinity:other:v9');
    const found = await nearest(towards(128, 90), { lim: 5 });
    expect(found.map(r => r.id).sort()).toEqual([...mine].sort());
  });

  it('never mixes sizes or models, and keeps to the field and to what anyone may see', async () => {
    const travel = (await ask('Is travel insurance needed for a Schengen visa?', 'travel')).id;
    const hidden = (await ask('Is travel insurance needed for a parcel?')).id;
    await place(travel, towards(128, 70));
    await place(hidden, towards(128, 70));
    await h.t.owner.query("INSERT INTO app.decisions (question_id, decision) VALUES ($1, 'remove')", [hidden]);
    const ids = (await nearest(towards(128, 70), { lim: 50 })).map(r => r.id);
    expect(ids).toContain(travel);
    expect(ids).not.toContain(hidden);
    expect((await nearest(towards(128, 70), { field: 'imports-customs', lim: 50 })).map(r => r.id)).not.toContain(
      travel,
    );
    // A 768-number vector under the same model name is compared only with 768-number ones (exactly).
    const wide = (await ask('Which form for a gift parcel under 10,000?')).id;
    await place(wide, towards(768, 300), 'graphinity:wide:v1');
    expect((await nearest(towards(768, 300), { model: 'graphinity:wide:v1' })).map(r => r.id)).toEqual([wide]);
    expect(await nearest(towards(128, 300 % 128), { model: 'graphinity:wide:v1' })).toEqual([]);
    // Two sizes under one model: an unindexed size compares only with its own size.
    const narrow = (await ask('Which form for a gift parcel under 20,000?')).id;
    await place(narrow, towards(300, 7), 'graphinity:wide:v1');
    expect((await nearest(towards(300, 7), { model: 'graphinity:wide:v1' })).map(r => r.id)).toEqual([narrow]);
  });

  it('runs with the measured search settings, which a small test database can’t show by results', async () => {
    // ef_search 400: recall@50 0.98 at 100,000 questions, against 0.80 at pgvector's default 40
    // (ADR 0015 part 5); an iterative scan so filtering can't return fewer than asked for.
    const { rows } = await h.t.owner.query<{ config: string[] }>(
      `SELECT proconfig AS config FROM pg_proc WHERE oid = 'app.nearest_questions(text, text, text, integer)'::regprocedure`,
    );
    expect(must(rows[0]).config).toEqual(
      expect.arrayContaining(['hnsw.ef_search=400', 'hnsw.iterative_scan=relaxed_order']),
    );
  });

  it('goes when its question goes', async () => {
    const { id } = await ask('How long does customs duty clearance take in Pune?');
    await h.t.owner.query('DELETE FROM app.questions WHERE id = $1', [id]);
    expect((await h.t.owner.query('SELECT 1 FROM app.question_embeddings WHERE question_id = $1', [id])).rows).toEqual(
      [],
    );
  });
});

describe('similar to a question someone opened (recommendations)', () => {
  const similar = (seed: string, model = own.model) =>
    h.t.database.withUser(null, async q =>
      (
        await q.query<{ id: string }>('SELECT id::text AS id FROM app.similar_questions($1, $2, 10)', [seed, model])
      ).rows.map(r => r.id),
    );

  it('finds the nearest by the seed’s own vector, never the seed, a hidden one or another model’s', async () => {
    const seed = (await ask('How long does customs take for a harmonium at Kolkata?')).id;
    const near = (await ask('How long does customs take for a sitar at Kolkata?')).id;
    const hidden = (await ask('How long does customs take for a tabla at Kolkata?')).id;
    const otherModel = (await ask('How long does customs take for a flute at Kolkata?')).id;
    await place(seed, towards(128, 110));
    await place(near, towards(128, 110, 0.2));
    await place(hidden, towards(128, 110, 0.1));
    await h.t.owner.query('DELETE FROM app.question_embeddings WHERE question_id = $1', [otherModel]);
    await place(otherModel, towards(128, 110), 'graphinity:other:v2');
    await h.t.owner.query("INSERT INTO app.decisions (question_id, decision) VALUES ($1, 'remove')", [hidden]);
    const ids = await similar(seed);
    expect(ids[0]).toBe(near);
    expect(ids).not.toContain(seed);
    expect(ids).not.toContain(hidden);
    expect(ids).not.toContain(otherModel);
    // A hidden seed, or one with no vector, gives nothing.
    expect(await similar(hidden)).toEqual([]);
    expect(await similar('999999999')).toEqual([]);
  });
});

describe('routing’s closeness in meaning (φ1)', () => {
  it('compares a new question with what someone answered only under the same model', async () => {
    const target = (await ask('How much duty on a laptop through Hyderabad customs?')).id;
    const earlier = (await ask('How much duty on a tablet through Hyderabad customs?')).id;
    const answerer = await person();
    await h.t.owner.query('INSERT INTO app.answers (question_id, answerer_id, body) VALUES ($1, $2, $3)', [
      earlier,
      answerer.id,
      'Paid duty on my tablet there last month, about a fifth of the price.',
    ]);
    await place(target, towards(128, 20));
    // The earlier question's vector only under another model: nothing to compare.
    await h.t.owner.query('DELETE FROM app.question_embeddings WHERE question_id = $1', [earlier]);
    await place(earlier, towards(128, 20), 'graphinity:retired:v0');
    const proximity = () =>
      h.t.database.asSystem(
        async q =>
          (
            await q.query<{ proximity: number }>(
              'SELECT proximity FROM app.experience_proximity($1, ARRAY[$2]::uuid[])',
              [target, answerer.id],
            )
          ).rows,
      );
    expect(await proximity()).toEqual([]);
    await place(earlier, towards(128, 20, 0.6));
    const [row] = await proximity();
    expect(must(row).proximity).toBeCloseTo(0.8, 2);
    await h.t.owner.query('DELETE FROM app.question_embeddings WHERE model = $1', ['graphinity:retired:v0']);
  });
});

describe('the background job', () => {
  it('fills in what the serving model hasn’t embedded, then clears other models’ vectors', async () => {
    const { id } = await ask('Which duty applies to a drone imported to Goa?');
    await h.t.owner.query('DELETE FROM app.question_embeddings WHERE question_id = $1', [id]);
    await place(id, towards(128, 3), 'graphinity:retired:v0');
    while ((await embedMissing(h.t.database, own)) > 0) {
      /* catch up on this file's questions */
    }
    const kept = await h.t.owner.query<{ model: string }>(
      'SELECT model FROM app.question_embeddings WHERE question_id = $1 ORDER BY model',
      [id],
    );
    expect(kept.rows).toEqual([{ model: own.model }]);
    expect(
      (await h.t.owner.query('SELECT 1 FROM app.question_embeddings WHERE model <> $1 LIMIT 1', [own.model])).rows,
    ).toEqual([]);
    expect(PRUNE_BATCH).toBeGreaterThan(0);
  });
});

describe('the vectors, protected', () => {
  it('can be stored by a request only for the question its asker just posted', async () => {
    const mine = await ask('A question of my own about customs duty here');
    const theirs = await ask('Someone else’s question about customs duty here');
    const store = (userId: string, questionId: string) =>
      h.t.database.withUser(userId, q =>
        q.query("INSERT INTO app.question_embeddings (question_id, model, embedding) VALUES ($1, 'x:v1', $2)", [
          questionId,
          vectorLiteral(towards(128, 1)),
        ]),
      );
    await expect(store(mine.asker.id, mine.id)).resolves.toBeDefined();
    await expect(store(mine.asker.id, theirs.id)).rejects.toMatchObject({ code: '42501' });
  });

  it('are not readable, changeable or removable by a request, and the batch store is the job’s alone', async () => {
    const { id, asker } = await ask('A question whose meaning is private plumbing');
    const asUser = (sql: string, params: unknown[] = []) => h.t.database.withUser(asker.id, q => q.query(sql, params));
    expect((await asUser('SELECT * FROM app.question_embeddings')).rows).toEqual([]);
    expect(
      (await asUser('UPDATE app.question_embeddings SET created_at = now() WHERE question_id = $1', [id])).rowCount,
    ).toBe(0);
    expect((await asUser('DELETE FROM app.question_embeddings WHERE question_id = $1', [id])).rowCount).toBe(0);
    await expect(
      asUser('SELECT app.store_question_embeddings($1::bigint[], $2, $3::text[])', [
        [id],
        'x:v2',
        [vectorLiteral(towards(128, 2))],
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    // The job skips a question deleted meanwhile instead of failing the batch.
    const stored = await h.t.database.asSystem(q =>
      q.query<{ n: number }>('SELECT app.store_question_embeddings($1::bigint[], $2, $3::text[]) AS n', [
        [id, '999999999'],
        'x:v3',
        [vectorLiteral(towards(128, 2)), vectorLiteral(towards(128, 4))],
      ]),
    );
    expect(stored.rows).toEqual([{ n: 1 }]);
  });
});
