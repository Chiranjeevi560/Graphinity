// Picking, helpful marks, verdicts and standing, through the real server.
// The database-level attacks are in points.db.integration.test.ts.
import { beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './helpers/app.ts';
import { must, type Body } from './helpers/must.ts';

let h: TestApp;
let names = 0;

beforeAll(async () => {
  h = await startApp(() => Date.parse('2026-10-18T10:00:00Z'));
  return h.close;
});

async function member() {
  const p = await h.person();
  names += 1;
  const handle = `standing.${String(names)}`;
  expect((await h.call('POST', '/me/profile', p.token, { handle, country: 'IN', fields: ['imports-customs'], adult: true })).statusCode).toBe(201);
  return { ...p, handle };
}

async function ask(token: string): Promise<string> {
  const res = await h.call('POST', '/questions', token, { title: 'How do I import a watch into the UAE without paying twice?', field: 'imports-customs' });
  return must(res.json<{ question: { id: string } }>().question.id);
}

async function answer(questionId: string, token: string): Promise<string> {
  const res = await h.call('POST', `/questions/${questionId}/answers`, token, { body: 'Declare it at customs and keep the export receipt.' });
  return must(res.json<{ answer: { id: string } }>().answer.id);
}

const pick = (token: string, q: string, a: string, reason?: string) =>
  h.call('PUT', `/questions/${q}/selection`, token, { answerId: a, ...(reason ? { reason } : {}) });

interface Standing { points: Array<{ field: { slug: string }; points: number; medal: string | null }>; trust: { correct: number; askers: number } | null }
async function standingOf(handle: string): Promise<Standing> {
  return (await h.call('GET', `/profiles/${handle}`)).json<{ standing: Standing }>().standing;
}

describe('picking the answer that helped', () => {
  it('gives the author 5 points in the question’s field', async () => {
    const asker = await member(), author = await member();
    const q = await ask(asker.token);
    const a = await answer(q, author.token);
    const res = await pick(asker.token, q, a);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ selection: { answerId: a, changesLeft: 2 } });
    expect((await standingOf(author.handle)).points).toEqual([{ field: { slug: 'imports-customs', name: 'Imports & Customs' }, points: 5, medal: null }]);
    // Picking the same answer again changes nothing.
    expect((await pick(asker.token, q, a)).json()).toEqual({ selection: { answerId: a, changesLeft: 2 } });
    expect((await standingOf(author.handle)).points[0]?.points).toBe(5);
  });

  it('copes with two first picks at the same moment', async () => {
    const asker = await member(), first = await member(), second = await member();
    const q = await ask(asker.token);
    const [x, y] = [await answer(q, first.token), await answer(q, second.token)];
    const results = await Promise.all([pick(asker.token, q, x), pick(asker.token, q, x)]);
    expect(results.map(r => r.statusCode)).toEqual([200, 200]);
    expect((await standingOf(first.handle)).points[0]?.points).toBe(5);
    // A different answer at the same moment: one wins, the other is a change needing a reason.
    const q2 = await ask(asker.token);
    const [p, r] = [await answer(q2, first.token), await answer(q2, second.token)];
    const codes = (await Promise.all([pick(asker.token, q2, p), pick(asker.token, q2, r)])).map(res => res.statusCode).sort();
    expect(codes).toEqual([200, 400]);
    expect(y).toBeTruthy();
  });

  it('is only for the asker, and only for answers to that question', async () => {
    const asker = await member(), author = await member(), stranger = await member();
    const q = await ask(asker.token), other = await ask(asker.token);
    const a = await answer(q, author.token), elsewhere = await answer(other, author.token);
    expect((await pick(stranger.token, q, a)).json<Body>()).toMatchObject({ error: 'not_your_question' });
    expect((await pick(asker.token, q, elsewhere)).json<Body>()).toMatchObject({ error: 'not_an_answer' });
    expect((await pick(asker.token, '999999999', a)).statusCode).toBe(404);
    expect((await h.call('PUT', `/questions/${q}/selection`, undefined, { answerId: a })).statusCode).toBe(401);
    expect((await pick(asker.token, q, a, 'because')).statusCode).toBe(400);
  });

  it('can change twice, each time with a reason, moving the points', async () => {
    const asker = await member(), first = await member(), second = await member(), third = await member();
    const q = await ask(asker.token);
    const [x, y, z] = [await answer(q, first.token), await answer(q, second.token), await answer(q, third.token)];
    await pick(asker.token, q, x);
    expect((await pick(asker.token, q, y)).json<Body>()).toMatchObject({ error: 'reason_required', message: 'Say why you’re changing your pick.' });
    expect((await pick(asker.token, q, y, 'better_answer_later')).json()).toEqual({ selection: { answerId: y, changesLeft: 1 } });
    expect((await pick(asker.token, q, z, 'picked_by_mistake')).json()).toEqual({ selection: { answerId: z, changesLeft: 0 } });
    const third_try = await pick(asker.token, q, x, 'better_answer_later');
    expect(third_try.statusCode).toBe(409);
    expect(third_try.json<Body>().error).toBe('no_changes_left');
    expect([(await standingOf(first.handle)).points, (await standingOf(second.handle)).points]).toEqual([[], []]);
    expect((await standingOf(third.handle)).points[0]?.points).toBe(5);
  });

  it('records "turned out wrong" as the asker’s verdict on the old pick', async () => {
    const asker = await member(), wrong = await member(), right = await member();
    const q = await ask(asker.token);
    const [x, y] = [await answer(q, wrong.token), await answer(q, right.token)];
    await pick(asker.token, q, x);
    await pick(asker.token, q, y, 'turned_out_wrong');
    const { rows } = await h.t.owner.query('SELECT correct FROM app.verdicts WHERE answer_id = $1', [x]);
    expect(rows).toEqual([{ correct: false }]);
  });
});

describe('helpful marks', () => {
  it('give 2 points, once, and only the asker can mark', async () => {
    const asker = await member(), author = await member(), stranger = await member();
    const q = await ask(asker.token);
    const a = await answer(q, author.token);
    expect((await h.call('POST', `/answers/${a}/helpful`, stranger.token)).json<Body>()).toMatchObject({ error: 'not_your_question' });
    expect((await h.call('POST', `/answers/${a}/helpful`, asker.token)).json()).toEqual({ helpful: true });
    expect((await h.call('POST', `/answers/${a}/helpful`, asker.token)).json()).toEqual({ helpful: true });
    expect((await standingOf(author.handle)).points[0]?.points).toBe(2);
    expect((await h.call('GET', `/questions/${q}`)).json<{ answers: Array<{ helpful: boolean }> }>().answers).toEqual([expect.objectContaining({ helpful: true })]);
  });
});

describe('saying how it turned out', () => {
  it('works only on the current pick, from the asker, and shows on the question', async () => {
    const asker = await member(), author = await member(), other = await member();
    const q = await ask(asker.token);
    const [a, b] = [await answer(q, author.token), await answer(q, other.token)];
    const say = (token: string, id: string, correct: boolean) => h.call('PUT', `/answers/${id}/verdict`, token, { correct });
    expect((await say(asker.token, a, true)).json<Body>()).toMatchObject({ error: 'not_picked' });
    await pick(asker.token, q, a);
    expect((await say(author.token, a, true)).json<Body>()).toMatchObject({ error: 'not_your_question' });
    expect((await say(asker.token, b, true)).json<Body>()).toMatchObject({ error: 'not_picked' });
    expect((await say(asker.token, a, true)).json()).toEqual({ verdict: { correct: true } });
    expect((await h.call('GET', `/questions/${q}`)).json<{ selection: unknown }>().selection).toEqual({ answerId: a, changesLeft: 2, correct: true });
  });
});

describe('standing on a profile', () => {
  it('earns a bronze medal at 10 points in a field', async () => {
    const author = await member();
    for (let i = 0; i < 2; i++) {
      const asker = await member();
      const q = await ask(asker.token);
      await pick(asker.token, q, await answer(q, author.token));
    }
    expect((await standingOf(author.handle)).points).toEqual([expect.objectContaining({ points: 10, medal: 'bronze' })]);
  });

  it('shows trust only once three different askers have said, each counted once', async () => {
    const author = await member();
    const [one, two, three] = [await member(), await member(), await member()];
    async function picked(asker: { token: string }, correct: boolean) {
      const q = await ask(asker.token);
      const a = await answer(q, author.token);
      await pick(asker.token, q, a);
      await h.call('PUT', `/answers/${a}/verdict`, asker.token, { correct });
    }
    await picked(one, true);
    await picked(one, true);
    await picked(two, false);
    // Two askers so far, however many verdicts: not shown yet.
    expect((await standingOf(author.handle)).trust).toBeNull();
    await picked(three, true);
    expect((await standingOf(author.handle)).trust).toEqual({ correct: 2, askers: 3 });
  });

  it('never shows who gave whom points', async () => {
    const asker = await member(), author = await member();
    const q = await ask(asker.token);
    await pick(asker.token, q, await answer(q, author.token));
    const body = (await h.call('GET', `/profiles/${author.handle}`)).body;
    expect(body).not.toContain(asker.handle);
    expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect((await h.call('GET', '/me', author.token)).json<{ standing: Standing }>().standing.points[0]?.points).toBe(5);
  });
});
