// Topics starting from what they mean in the knowledge graph.
import { beforeAll, describe, expect, it } from 'vitest';
import { projectFeature, refreshKnowledgeGraph } from '../src/platform/jobs.ts';
import { startApp, type TestApp } from './helpers/app.ts';
import { must } from './helpers/must.ts';

let h: TestApp;
let names = 0;

beforeAll(async () => {
  h = await startApp(() => Date.now());
  return h.close;
});

async function member(fields: string[]) {
  const p = await h.person();
  names += 1;
  const res = await h.call('POST', '/me/profile', p.token, {
    handle: `graph.${String(names)}`,
    country: 'IN',
    fields,
    adult: true,
  });
  expect(res.statusCode, res.body).toBe(201);
  return p;
}

describe('topics in the knowledge graph', () => {
  const cosine = (a: readonly number[], b: readonly number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);

  it('projects near vectors to near places, and is repeatable', () => {
    const base = Array.from({ length: 128 }, (_, i) => Math.sin(i * 1.7));
    const near = base.map((x, i) => x + 0.1 * Math.cos(i * 3.1));
    const far = Array.from({ length: 128 }, (_, i) => Math.cos(i * 2.3 + 1));
    const p = (v: number[]) => [...projectFeature(v, 64)];
    expect(cosine(p(base), p(near))).toBeGreaterThan(0.8);
    expect(Math.abs(cosine(p(base), p(far)))).toBeLessThan(0.5);
    expect(p(base)).toEqual(p(base));
    expect([...projectFeature(new Array<number>(8).fill(0), 4)]).toEqual([0, 0, 0, 0]);
  });

  it('starts topics about the same things closer than others, and ignores hidden questions', async () => {
    const vector = (axis: number) => {
      const v = new Array<number>(128).fill(0);
      v[axis] = 1;
      return `[${v.join(',')}]`;
    };
    // A person can only ask a few a day, so each question has its own asker.
    const post = async (title: string, field: string) => {
      const asker = await member([field]);
      const res = await h.call('POST', '/questions', asker.token, { title, field });
      return must(res.json<{ question: { id: string } }>().question.id);
    };
    const store = (id: string, axis: number) =>
      h.t.owner.query(
        `INSERT INTO app.question_embeddings (question_id, model, embedding) VALUES ($1, 'graph-test', $2::extensions.halfvec)
         ON CONFLICT (question_id, model) DO UPDATE SET embedding = EXCLUDED.embedding`,
        [id, vector(axis)],
      );
    const fields = (
      await h.t.owner.query<{ slug: string }>('SELECT slug FROM app.fields ORDER BY slug LIMIT 3')
    ).rows.map(r => r.slug);
    const [a, b, c] = [must(fields[0]), must(fields[1]), must(fields[2])];
    await store(await post('Which forms are needed for the first thing?', a), 3);
    await store(await post('Which forms are needed for the second thing?', b), 3);
    await store(await post('Which forms are needed for the third thing?', c), 90);
    const hidden = await post('Which forms are needed for the hidden thing?', c);
    await store(hidden, 3);
    await h.t.owner.query(`INSERT INTO app.decisions (question_id, decision) VALUES ($1, 'remove')`, [hidden]);
    const means = await h.t.database.asSystem(q =>
      q.query<{ field: string; vector: string }>('SELECT field, vector FROM app.field_mean_vectors()'),
    );
    const mean = JSON.parse(must(means.rows.find(r => r.field === c)).vector) as number[];
    expect(mean[3]).toBe(0);
    expect(mean[90]).toBe(1);
    await refreshKnowledgeGraph(h.t.database, Date.now());
    const embedding = async (key: string) =>
      must(
        (
          await h.t.owner.query<{ embedding: number[] }>(
            `SELECT e.embedding FROM app.kg_node_embeddings e JOIN app.kg_nodes n ON n.id = e.node_id WHERE n.kind = 'field' AND n.key = $1`,
            [key],
          )
        ).rows[0],
      ).embedding;
    const [ea, eb, ec] = [await embedding(a), await embedding(b), await embedding(c)];
    expect(cosine(ea, eb)).toBeGreaterThan(cosine(ea, ec));
    // Only the system may read this; a person's session gets nothing.
    const someone = await member(['travel']);
    const person = await h.t.database.withUser(someone.id, q => q.query('SELECT * FROM app.field_mean_vectors()'));
    expect(person.rowCount).toBe(0);
  });
});
