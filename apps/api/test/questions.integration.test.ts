// Asking, answering and reading, end to end: the real server, the real
// token verifier and a real Postgres as the restricted role.
import { beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './helpers/app.ts';
import { must, type Body } from './helpers/must.ts';

let h: TestApp;
let handles = 0;

beforeAll(async () => {
  h = await startApp(() => Date.parse('2026-10-18T10:00:00Z'));
  return h.close;
});

/** A signed-in person with a profile. */
async function member(country = 'IN') {
  const p = await h.person();
  handles += 1;
  const res = await h.call('POST', '/me/profile', p.token, { handle: `member.${String(handles)}`, country, fields: ['imports-customs'], adult: true });
  expect(res.statusCode).toBe(201);
  return { ...p, handle: `member.${String(handles)}` };
}

const question = { title: 'How do I import a watch into the UAE without paying twice?', details: 'Bought in Switzerland.\nShipping to Dubai.', field: 'imports-customs', country: 'AE' };

async function ask(token: string, body: object = question): Promise<string> {
  const res = await h.call('POST', '/questions', token, body);
  expect(res.statusCode, res.body).toBe(201);
  return must(res.json<{ question: { id: string } }>().question.id, 'question id');
}

const answerText = 'Declare it at customs and keep the Swiss export receipt.';

interface QuestionPage {
  question: { id: string; title: string; body: string; field: { slug: string; name: string }; country: { code: string; name: string } | null; asker: { handle: string }; answerCount: number };
  answers: Array<{ id: string; body: string; answerer: { handle: string } }>;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

describe('asking', () => {
  it('needs sign-in and a profile', async () => {
    expect((await h.call('POST', '/questions', undefined, question)).statusCode).toBe(401);
    const noProfile = await h.person();
    const res = await h.call('POST', '/questions', noProfile.token, question);
    expect(res.statusCode).toBe(403);
    expect(res.json<Body>().error).toBe('no_profile');
  });

  it('stores a tidy title and shows it to anyone, without anyone’s id', async () => {
    const m = await member();
    const id = await ask(m.token, { ...question, title: '  How do I import   a watch\tinto the UAE?  ' });
    const res = await h.call('GET', `/questions/${id}`);
    expect(res.statusCode).toBe(200);
    const page = res.json<QuestionPage>();
    expect(page.question).toMatchObject({
      title: 'How do I import a watch into the UAE?',
      body: 'Bought in Switzerland.\nShipping to Dubai.',
      field: { slug: 'imports-customs', name: 'Imports & Customs' },
      country: { code: 'AE', name: 'United Arab Emirates' },
      asker: { handle: m.handle },
      answerCount: 0,
    });
    expect(res.body).not.toMatch(UUID);
  });

  it('accepts a question about anywhere, with no details', async () => {
    const m = await member();
    const id = await ask(m.token, { title: question.title, field: 'imports-customs', country: null });
    expect((await h.call('GET', `/questions/${id}`)).json<QuestionPage>().question).toMatchObject({ country: null, body: '' });
  });

  it('explains what is wrong with a title, in plain words', async () => {
    const m = await member();
    const short = await h.call('POST', '/questions', m.token, { ...question, title: 'Watch import?' });
    expect(short.statusCode).toBe(400);
    expect(short.json<Body>()).toMatchObject({ error: 'invalid_title', reason: 'too_short', message: 'Write the question in full, at least 15 characters.' });
    const hidden = await h.call('POST', '/questions', m.token, { ...question, title: 'How do I import\u0007 a watch into Dubai?' });
    expect(hidden.json<Body>()).toMatchObject({ error: 'invalid_title', reason: 'invalid_characters' });
    const long = await h.call('POST', '/questions', m.token, { ...question, details: 'x'.repeat(5001) });
    expect(long.json<Body>()).toMatchObject({ error: 'invalid_details', reason: 'too_long' });
  });

  it('refuses unknown fields and countries, and anything extra', async () => {
    const m = await member();
    expect((await h.call('POST', '/questions', m.token, { ...question, field: 'not-a-field' })).statusCode).toBe(400);
    expect((await h.call('POST', '/questions', m.token, { ...question, country: 'ZZ' })).statusCode).toBe(400);
    expect((await h.call('POST', '/questions', m.token, { ...question, asker_id: m.id })).statusCode).toBe(400);
  });
});

describe('reading', () => {
  it('lists the newest first, a page at a time', async () => {
    const m = await member();
    // An established member: a new account may ask only 3 on day one.
    await h.t.owner.query("UPDATE app.profiles SET created_at = now() - interval '2 days' WHERE id = $1", [m.id]);
    const ids: string[] = [];
    for (let i = 0; i < 22; i++) ids.push(await ask(m.token, { ...question, title: `Paging question number ${String(i)} for the list` }));
    const first = (await h.call('GET', '/questions')).json<{ questions: Array<{ id: string }>; next: string | null }>();
    expect(first.questions).toHaveLength(20);
    expect(first.questions[0]?.id).toBe(ids.at(-1));
    const second = (await h.call('GET', `/questions?before=${must(first.next)}`)).json<{ questions: Array<{ id: string }> }>();
    expect(second.questions[0]?.id).toBe(ids.at(-21));
    expect(Number(second.questions[0]?.id)).toBeLessThan(Number(first.questions.at(-1)?.id));
  });

  it('says plainly when a question doesn’t exist, and refuses ids that aren’t numbers', async () => {
    expect((await h.call('GET', '/questions/999999999')).json<Body>()).toMatchObject({ error: 'not_found' });
    expect((await h.call('GET', '/questions/0')).statusCode).toBe(400);
    expect((await h.call('GET', '/questions/1;DROP')).statusCode).toBe(400);
    expect((await h.call('GET', '/questions?before=-1')).statusCode).toBe(400);
  });
});

describe('the sitemap list', () => {
  it('lists the newest questions with titles and dates, and nobody’s id', async () => {
    const m = await member();
    const id = await ask(m.token, { ...question, title: 'Which bus goes from the airport to the old town?' });
    const res = await h.call('GET', '/sitemap/questions');
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    const { questions } = res.json<{ questions: Array<{ id: string; title: string; createdAt: string }> }>();
    expect(questions[0]).toMatchObject({ id, title: 'Which bus goes from the airport to the old town?' });
    expect(res.body).not.toMatch(UUID);
  });
});

describe('finding similar questions while typing', () => {
  it('finds a question from half-typed words', async () => {
    const m = await member();
    const id = await ask(m.token, { ...question, title: 'Importing a vintage wristwatch into Singapore: what duty applies?' });
    const res = await h.call('GET', `/questions/similar?q=${encodeURIComponent('wristwat duty singap')}`);
    expect(res.json<{ questions: Array<{ id: string }> }>().questions.map(q => q.id)).toContain(id);
  });

  it('returns nothing, without an error, for text that has no words', async () => {
    for (const q of ['', '!!!', "& | ! :* <-> ( ) '", 'a']) {
      const res = await h.call('GET', `/questions/similar?q=${encodeURIComponent(q)}`);
      expect(res.statusCode, q).toBe(200);
      expect(res.json<{ questions: unknown[] }>().questions, q).toEqual([]);
    }
  });
});

describe('answering', () => {
  it('shows an answer under the question with the answerer’s chosen name', async () => {
    const asker = await member(), answerer = await member('AE');
    const id = await ask(asker.token);
    const res = await h.call('POST', `/questions/${id}/answers`, answerer.token, { body: `  ${answerText}\r\n` });
    expect(res.statusCode).toBe(201);
    const page = (await h.call('GET', `/questions/${id}`)).json<QuestionPage>();
    expect(page.question.answerCount).toBe(1);
    expect(page.answers).toEqual([expect.objectContaining({ body: answerText, answerer: { handle: answerer.handle } })]);
  });

  it('allows one answer per person per question', async () => {
    const asker = await member(), answerer = await member();
    const id = await ask(asker.token);
    expect((await h.call('POST', `/questions/${id}/answers`, answerer.token, { body: answerText })).statusCode).toBe(201);
    const again = await h.call('POST', `/questions/${id}/answers`, answerer.token, { body: `${answerText} Again.` });
    expect(again.statusCode).toBe(409);
    expect(again.json<Body>().error).toBe('already_answered');
  });

  it('refuses answering your own question', async () => {
    const asker = await member();
    const id = await ask(asker.token);
    const res = await h.call('POST', `/questions/${id}/answers`, asker.token, { body: answerText });
    expect(res.statusCode).toBe(409);
    expect(res.json<Body>()).toMatchObject({ error: 'own_question', message: 'You can’t answer your own question.' });
  });

  it('needs sign-in, a profile, a real question and enough words', async () => {
    const asker = await member(), answerer = await member();
    const id = await ask(asker.token);
    expect((await h.call('POST', `/questions/${id}/answers`, undefined, { body: answerText })).statusCode).toBe(401);
    expect((await h.call('POST', `/questions/${id}/answers`, (await h.person()).token, { body: answerText })).json<Body>().error).toBe('no_profile');
    expect((await h.call('POST', '/questions/999999999/answers', answerer.token, { body: answerText })).statusCode).toBe(404);
    expect((await h.call('POST', `/questions/${id}/answers`, answerer.token, { body: 'Yes.' })).json<Body>()).toMatchObject({ error: 'invalid_answer', reason: 'too_short' });
  });

  it('takes a long answer from a signed-in person, but no large body from anyone signed out', async () => {
    const asker = await member(), answerer = await member();
    const id = await ask(asker.token);
    // 10,000 four-byte characters: the longest allowed answer, 40 kB on the wire.
    expect((await h.call('POST', `/questions/${id}/answers`, answerer.token, { body: '😀'.repeat(10_000) })).statusCode).toBe(201);
    expect((await h.call('POST', `/questions/${id}/answers`, undefined, { body: '😀'.repeat(10_000) })).statusCode).toBe(401);
  });
});

describe('the database itself', () => {
  it('refuses an answer to your own question even if the API forgot to check', async () => {
    const asker = await member();
    const id = await ask(asker.token);
    await expect(h.t.database.withUser(asker.id, q =>
      q.query('INSERT INTO app.answers (question_id, answerer_id, body) VALUES ($1, $2, $3)', [id, asker.id, answerText]),
    )).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses writing as someone else', async () => {
    const a = await member(), b = await member();
    await expect(h.t.database.withUser(b.id, q =>
      q.query('INSERT INTO app.questions (asker_id, field, title) VALUES ($1, $2, $3)', [a.id, 'imports-customs', question.title]),
    )).rejects.toMatchObject({ code: '42501' });
    const id = await ask(a.token);
    const other = await member();
    await expect(h.t.database.withUser(b.id, q =>
      q.query('INSERT INTO app.answers (question_id, answerer_id, body) VALUES ($1, $2, $3)', [id, other.id, answerText]),
    )).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses untidy or hidden text sent straight to it', async () => {
    const m = await member();
    const insert = (title: string, body = '') => h.t.database.withUser(m.id, q =>
      q.query('INSERT INTO app.questions (asker_id, field, title, body) VALUES ($1, $2, $3, $4)', [m.id, 'imports-customs', title, body]));
    await expect(insert('Two  spaces in this question title')).rejects.toMatchObject({ code: '23514' });
    await expect(insert(' Leading space in this question')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('A bell \u0007 hidden in this title')).rejects.toMatchObject({ code: '23514' });
    await expect(insert(question.title, 'A tab\there')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('Too short?')).rejects.toMatchObject({ code: '23514' });
  });

  it('cannot change or delete questions or answers (not offered yet)', async () => {
    const m = await member();
    const id = await ask(m.token);
    await expect(h.t.database.withUser(m.id, q => q.query("UPDATE app.questions SET title = 'Changed title of the question' WHERE id = $1", [id])))
      .rejects.toMatchObject({ code: '42501' });
    await expect(h.t.database.withUser(m.id, q => q.query('DELETE FROM app.questions WHERE id = $1', [id])))
      .rejects.toMatchObject({ code: '42501' });
  });
});

describe('deleting an account', () => {
  it('deletes the person’s questions and answers too', async () => {
    const asker = await member(), answerer = await member();
    const id = await ask(asker.token);
    const theirs = await ask(answerer.token);
    expect((await h.call('POST', `/questions/${id}/answers`, answerer.token, { body: answerText })).statusCode).toBe(201);
    expect((await h.call('DELETE', '/me', answerer.token, { confirm: true })).statusCode).toBe(204);
    expect((await h.call('GET', `/questions/${id}`)).json<QuestionPage>().answers).toEqual([]);
    expect((await h.call('GET', `/questions/${theirs}`)).statusCode).toBe(404);
  });
});
