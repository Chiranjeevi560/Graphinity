// Who a question is put to, in which wave, and who can see it.
import { beforeAll, describe, expect, it } from 'vitest';
import type { PersonEvent } from '../src/events.ts';
import { routeDueQuestions } from '../src/routing.ts';
import { startApp, type TestApp } from './helpers/app.ts';
import { must } from './helpers/must.ts';

let h: TestApp;
let names = 0;

beforeAll(async () => {
  h = await startApp(() => Date.now());
  return h.close;
});

async function member(opts: { country?: string; fields?: string[]; joinedDaysAgo?: number } = {}) {
  const p = await h.person();
  names += 1;
  const handle = `route.${String(names)}`;
  const res = await h.call('POST', '/me/profile', p.token, { handle, country: opts.country ?? 'IN', fields: opts.fields ?? ['imports-customs'], adult: true });
  expect(res.statusCode).toBe(201);
  if (opts.joinedDaysAgo) {
    await h.t.owner.query(`UPDATE app.profiles SET created_at = now() - make_interval(days => $2) WHERE id = $1`, [p.id, opts.joinedDaysAgo]);
  }
  return { ...p, handle };
}

/** A field nobody else in this test file uses, so other tests' people don't crowd the candidates. */
async function ask(token: string, field: string, country: string | null = null): Promise<string> {
  const res = await h.call('POST', '/questions', token, { title: 'Where do I renew a work visa without an agent?', field, country });
  return must(res.json<{ question: { id: string } }>().question.id);
}

async function routedTo(questionId: string): Promise<Array<{ profile_id: string; wave: number }>> {
  return (await h.t.owner.query<{ profile_id: string; wave: number }>('SELECT profile_id, wave FROM app.routes WHERE question_id = $1', [questionId])).rows;
}

async function olderWaves(questionId: string, minutes: number) {
  await h.t.owner.query("UPDATE app.routes SET routed_at = routed_at - make_interval(mins => $2) WHERE question_id = $1", [questionId, minutes]);
}

describe('the first wave', () => {
  it('goes to up to 10 people who know the field, never the asker or people from other fields', async () => {
    const asker = await member({ fields: ['visas-immigration'] });
    const experts = [];
    for (let i = 0; i < 12; i++) experts.push(await member({ fields: ['visas-immigration'], joinedDaysAgo: 100 }));
    const outsider = await member({ fields: ['food-cooking'] });
    const q = await ask(asker.token, 'visas-immigration');
    await routeDueQuestions(h.t.database);
    const routes = await routedTo(q);
    expect(routes).toHaveLength(10);
    expect(routes.every(r => r.wave === 1)).toBe(true);
    const ids = routes.map(r => r.profile_id);
    expect(ids).not.toContain(asker.id);
    expect(ids).not.toContain(outsider.id);
  });

  it('prefers people in the question’s country, and keeps places for newcomers', async () => {
    const asker = await member({ fields: ['money-tax'] });
    const locals = [await member({ fields: ['money-tax'], country: 'AE', joinedDaysAgo: 100 }), await member({ fields: ['money-tax'], country: 'AE', joinedDaysAgo: 100 })];
    const veterans = [];
    for (let i = 0; i < 15; i++) veterans.push(await member({ fields: ['money-tax'], joinedDaysAgo: 200 }));
    const newcomers = [await member({ fields: ['money-tax'] }), await member({ fields: ['money-tax'] })];
    const q = await ask(asker.token, 'money-tax', 'AE');
    await routeDueQuestions(h.t.database);
    const ids = (await routedTo(q)).map(r => r.profile_id);
    for (const p of [...locals, ...newcomers]) expect(ids).toContain(p.id);
    expect(veterans.length).toBe(15);
  });
});

describe('later waves', () => {
  it('reach more people only after 15 minutes without an answer, and stop once answered', async () => {
    const asker = await member({ fields: ['business-startups'] });
    for (let i = 0; i < 45; i++) await member({ fields: ['business-startups'], joinedDaysAgo: 100 });
    const q = await ask(asker.token, 'business-startups');
    await routeDueQuestions(h.t.database);
    expect(await routedTo(q)).toHaveLength(10);
    // Not yet: 14 minutes.
    await olderWaves(q, 14);
    await routeDueQuestions(h.t.database);
    expect(await routedTo(q)).toHaveLength(10);
    await olderWaves(q, 2);
    await routeDueQuestions(h.t.database);
    const after = await routedTo(q);
    expect(after.filter(r => r.wave === 2)).toHaveLength(30);

    // Someone answers: no third wave, however long it waits.
    const answerer = await member({ fields: ['business-startups'] });
    expect((await h.call('POST', `/questions/${q}/answers`, answerer.token, { body: 'Open it online, it took me ten minutes.' })).statusCode).toBe(201);
    await olderWaves(q, 120);
    await routeDueQuestions(h.t.database);
    expect((await routedTo(q)).filter(r => r.wave === 3)).toHaveLength(0);
  });
});

describe('the daily budget', () => {
  it('puts at most 5 questions a day to one person', async () => {
    const asker = await member({ fields: ['shopping'] });
    const only = await member({ fields: ['shopping'], joinedDaysAgo: 100 });
    for (let i = 0; i < 7; i++) await ask(asker.token, 'shopping');
    await routeDueQuestions(h.t.database);
    const { rows } = await h.t.owner.query<{ n: number }>('SELECT count(*)::int AS n FROM app.routes WHERE profile_id = $1', [only.id]);
    expect(rows).toEqual([{ n: 5 }]);
  });
});

describe('privacy', () => {
  it('lets only the person asked see a route, and only the routing job create one', async () => {
    const asker = await member({ fields: ['parenting-schools'] });
    const chosen = await member({ fields: ['parenting-schools'], joinedDaysAgo: 100 });
    const stranger = await member({ fields: ['food-cooking'] });
    const q = await ask(asker.token, 'parenting-schools');
    await routeDueQuestions(h.t.database);
    const seenBy = (user: string | null) => h.t.database.withUser(user, async qq => (await qq.query('SELECT 1 FROM app.routes WHERE question_id = $1', [q])).rowCount);
    expect(await seenBy(chosen.id)).toBe(1);
    expect(await seenBy(asker.id)).toBe(0);
    expect(await seenBy(stranger.id)).toBe(0);
    expect(await seenBy(null)).toBe(0);
    await expect(h.t.database.withUser(asker.id, qq =>
      qq.query('INSERT INTO app.routes (question_id, profile_id, wave) VALUES ($1, $2, 1)', [q, stranger.id]))).rejects.toMatchObject({ code: '42501' });
    // Never to the asker, even from the job itself.
    await expect(h.t.database.asSystem(qq =>
      qq.query('INSERT INTO app.routes (question_id, profile_id, wave) VALUES ($1, $2, 2)', [q, asker.id]))).rejects.toMatchObject({ code: '23514' });
  });
});

describe('the inbox', () => {
  it('lists questions put to you, and opening one marks it seen', async () => {
    const asker = await member({ fields: ['fitness'] });
    const chosen = await member({ fields: ['fitness'], joinedDaysAgo: 100 });
    const q = await ask(asker.token, 'fitness');
    await routeDueQuestions(h.t.database);
    const inbox = () => h.call('GET', '/me/inbox', chosen.token).then(r => r.json<{ questions: Array<{ id: string; seen: boolean }>; unseen: number }>());
    expect(await inbox()).toMatchObject({ unseen: 1, questions: [{ id: q, seen: false }] });
    await h.call('GET', `/questions/${q}`, chosen.token);
    expect(await inbox()).toMatchObject({ unseen: 0, questions: [{ id: q, seen: true }] });
    expect((await h.call('GET', '/me/inbox')).statusCode).toBe(401);
    expect((await h.call('GET', '/me/inbox', asker.token)).json<{ questions: unknown[] }>().questions).toEqual([]);
  });
});

describe('events', () => {
  it('tells the asker when someone answers, and the job when a question is asked', async () => {
    const asker = await member({ fields: ['housing-renting'] });
    const answerer = await member({ fields: ['housing-renting'] });
    const heard: PersonEvent[] = [];
    const asked: string[] = [];
    const stop = h.events.subscribe(asker.id, e => heard.push(e));
    h.events.onAsked(id => asked.push(id));
    const q = await ask(asker.token, 'housing-renting');
    await h.call('POST', `/questions/${q}/answers`, answerer.token, { body: 'Water them early in the morning, not at night.' });
    stop();
    expect(asked).toContain(q);
    expect(heard).toEqual([{ type: 'answered', questionId: q }]);
  });
});
