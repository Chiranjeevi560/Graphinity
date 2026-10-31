// The personal signals and category purge through the real server, on real
// Postgres as the restricted role.
import { beforeAll, describe, expect, it } from 'vitest';
import { SIGNALS } from '../src/personalization/signals.ts';
import { startApp, type TestApp } from './helpers/app.ts';
import type { Body } from './helpers/must.ts';

let h: TestApp;
let names = 0;

beforeAll(async () => {
  h = await startApp(() => Date.now());
  return h.close;
});

async function member() {
  const p = await h.person();
  names += 1;
  const res = await h.call('POST', '/me/profile', p.token, {
    handle: `sig.${String(names)}`,
    country: 'IN',
    fields: ['travel'],
    adult: true,
  });
  expect(res.statusCode).toBe(201);
  return p;
}

interface Summary {
  name: string;
  count: number;
  confidence: number;
  evidence: number;
}
const signals = async (token: string) =>
  (await h.call('GET', '/me/signals', token)).json<{ signals: Summary[] }>().signals;
const of = (list: Summary[], name: string) => list.find(s => s.name === name);

const consent = (token: string, category: string, enabled: boolean) =>
  h.call('PUT', '/me/consents', token, { choices: [{ category, enabled }] });

describe('GET /me/signals', () => {
  it('needs signing in, runs every signal query, and counts what this person did', async () => {
    expect((await h.call('GET', '/me/signals')).statusCode).toBe(401);
    const asker = await member();
    const answerer = await member();
    const q = (
      await h.call('POST', '/questions', asker.token, {
        title: 'Which ferry goes to the islands on Sundays?',
        field: 'travel',
      })
    ).json<{ question: { id: string } }>().question.id;
    const a = (
      await h.call('POST', `/questions/${q}/answers`, answerer.token, {
        body: 'The 9am ferry from the main pier runs every Sunday.',
      })
    ).json<{ answer: { id: string } }>().answer.id;
    expect((await h.call('PUT', `/questions/${q}/selection`, asker.token, { answerId: a })).statusCode).toBe(200);

    const mine = await signals(asker.token);
    expect(mine).toHaveLength(SIGNALS.length);
    expect(of(mine, 'question_asked')?.count).toBe(1);
    expect(of(mine, 'pick_given')?.count).toBe(1);
    expect(of(mine, 'answer_received')?.count).toBe(1);
    expect(of(mine, 'field_selected')?.count).toBe(1);
    expect(of(mine, 'pick_received')?.count).toBe(0);
    expect(of(mine, 'question_asked')?.confidence).toBeGreaterThan(0);
    expect(of(mine, 'question_asked')?.confidence).toBeLessThan(1);

    const theirs = await signals(answerer.token);
    expect(of(theirs, 'answer_written')?.count).toBe(1);
    expect(of(theirs, 'pick_received')?.count).toBe(1);
    expect(of(theirs, 'question_asked')?.count).toBe(0);
  });

  it('counts old actions for less', async () => {
    const fresh = await member();
    const old = await member();
    for (const p of [fresh, old])
      await h.call('POST', '/questions', p.token, { title: 'Is the night bus to Goa safe in June?', field: 'travel' });
    await h.t.owner.query("UPDATE app.questions SET created_at = now() - interval '360 days' WHERE asker_id = $1", [
      old.id,
    ]);
    const [a, b] = [of(await signals(fresh.token), 'question_asked'), of(await signals(old.token), 'question_asked')];
    expect(a?.evidence).toBeCloseTo(1, 1);
    expect(b?.evidence).toBeCloseTo(0.25, 1);
    expect(a?.count).toBe(b?.count);
  });
});

describe('DELETE /me/graph/categories/:category', () => {
  const add = (token: string, category: string, label: string) =>
    h.call('POST', '/me/graph/nodes', token, { category, entityType: 'skill', label, source: 'user_entered' });

  it('forgets one category for this person only, and leaves the choice on', async () => {
    const me = await member();
    const other = await member();
    for (const p of [me, other]) {
      expect((await consent(p.token, 'learning_expertise', true)).statusCode).toBe(200);
      expect((await consent(p.token, 'ownership', true)).statusCode).toBe(200);
    }
    expect((await add(me.token, 'learning_expertise', 'Welding')).statusCode).toBe(201);
    expect(
      (
        await h.call('POST', '/me/graph/nodes', me.token, {
          category: 'ownership',
          entityType: 'product',
          label: 'Kettle',
          source: 'user_entered',
        })
      ).statusCode,
    ).toBe(201);
    expect((await add(other.token, 'learning_expertise', 'Plumbing')).statusCode).toBe(201);

    expect((await h.call('DELETE', '/me/graph/categories/learning_expertise')).statusCode).toBe(401);
    const res = await h.call('DELETE', '/me/graph/categories/learning_expertise', me.token);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ deleted: number }>().deleted).toBe(1);

    const labels = async (id: string) =>
      (
        await h.t.owner.query<{ label: string }>('SELECT label FROM app.personal_graph_nodes WHERE user_id = $1', [id])
      ).rows.map(r => r.label);
    expect(await labels(me.id)).toEqual(['Kettle']);
    expect(await labels(other.id)).toEqual(['Plumbing']);
    const { rows } = await h.t.owner.query(
      "SELECT enabled FROM app.user_consent_settings WHERE user_id = $1 AND category = 'learning_expertise'",
      [me.id],
    );
    expect(rows).toEqual([{ enabled: true }]);
  });

  it('refuses a category that does not exist, or a malformed one', async () => {
    const me = await member();
    const res = await h.call('DELETE', '/me/graph/categories/not_a_category', me.token);
    expect(res.statusCode).toBe(404);
    expect(res.json<Body>().error).toBe('unknown_category');
    expect((await h.call('DELETE', "/me/graph/categories/x';drop", me.token)).statusCode).toBe(400);
  });

  it('forgets saved searches and memory with their own categories', async () => {
    const me = await member();
    await consent(me.token, 'memory_personalization', true);
    await h.t.database.withUser(me.id, q =>
      q.query(
        "INSERT INTO app.memory_entries (user_id, tier, key, value) VALUES ($1, 'procedural', 'currency', 'INR')",
        [me.id],
      ),
    );
    expect(of(await signals(me.token), 'memory_procedural')?.count).toBe(1);
    const res = await h.call('DELETE', '/me/graph/categories/memory_personalization', me.token);
    expect(res.json<{ deleted: number }>().deleted).toBe(1);
    expect(of(await signals(me.token), 'memory_procedural')?.count).toBe(0);
  });
});
