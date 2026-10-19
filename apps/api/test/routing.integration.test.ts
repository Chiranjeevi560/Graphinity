// Who a question is put to, in which wave, and who can see it.
import { beforeAll, describe, expect, it } from 'vitest';
import type { PersonEvent } from '../src/events.ts';
import { routeDueQuestions, routeWave, WEIGHTS } from '../src/routing.ts';
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

/** The question was asked this many minutes ago (waves count from asking). */
async function askedAgo(questionId: string, minutes: number) {
  await h.t.owner.query("UPDATE app.questions SET created_at = now() - make_interval(mins => $2) WHERE id = $1", [questionId, minutes]);
}

describe('the first wave', () => {
  it('goes to 5 people who know the field, never the asker or people from other fields', async () => {
    const asker = await member({ fields: ['visas-immigration'] });
    for (let i = 0; i < 12; i++) await member({ fields: ['visas-immigration'], joinedDaysAgo: 100 });
    const outsider = await member({ fields: ['food-cooking'] });
    const q = await ask(asker.token, 'visas-immigration');
    await routeDueQuestions(h.t.database);
    const routes = await routedTo(q);
    expect(routes).toHaveLength(5);
    expect(routes.every(r => r.wave === 1)).toBe(true);
    const ids = routes.map(r => r.profile_id);
    expect(ids).not.toContain(asker.id);
    expect(ids).not.toContain(outsider.id);
  });

  it('prefers people in the question’s country, and keeps one place in five for a newcomer', async () => {
    const asker = await member({ fields: ['money-tax'] });
    const locals = [await member({ fields: ['money-tax'], country: 'AE', joinedDaysAgo: 100 }), await member({ fields: ['money-tax'], country: 'AE', joinedDaysAgo: 100 })];
    for (let i = 0; i < 15; i++) await member({ fields: ['money-tax'], joinedDaysAgo: 200 });
    const newcomers = [await member({ fields: ['money-tax'] }), await member({ fields: ['money-tax'] })];
    const q = await ask(asker.token, 'money-tax', 'AE');
    await routeDueQuestions(h.t.database);
    const ids = (await routedTo(q)).map(r => r.profile_id);
    for (const p of locals) expect(ids).toContain(p.id);
    expect(newcomers.filter(n => ids.includes(n.id)).length).toBeGreaterThanOrEqual(1);
  });
});

describe('later waves (Bible §11.2: 5, 5, 5 at 0, 20 and 60 minutes)', () => {
  it('send 5 more at 20 minutes and 5 more at 60, counted from asking', async () => {
    const asker = await member({ fields: ['business-startups'] });
    for (let i = 0; i < 20; i++) await member({ fields: ['business-startups'], joinedDaysAgo: 100 });
    const q = await ask(asker.token, 'business-startups');
    await routeDueQuestions(h.t.database);
    expect(await routedTo(q)).toHaveLength(5);
    await askedAgo(q, 19);
    await routeDueQuestions(h.t.database);
    expect(await routedTo(q)).toHaveLength(5);
    await askedAgo(q, 21);
    await routeDueQuestions(h.t.database);
    expect((await routedTo(q)).filter(r => r.wave === 2)).toHaveLength(5);
    await askedAgo(q, 59);
    await routeDueQuestions(h.t.database);
    expect((await routedTo(q)).filter(r => r.wave === 3)).toHaveLength(0);
    await askedAgo(q, 61);
    await routeDueQuestions(h.t.database);
    expect((await routedTo(q)).filter(r => r.wave === 3)).toHaveLength(5);
  });

  it('skip wave 2 once 3 of those asked have opened it or answered', async () => {
    const asker = await member({ fields: ['study-abroad'] });
    for (let i = 0; i < 12; i++) await member({ fields: ['study-abroad'], joinedDaysAgo: 100 });
    const q = await ask(asker.token, 'study-abroad');
    await routeDueQuestions(h.t.database);
    const first = (await routedTo(q)).map(r => r.profile_id);
    await h.t.owner.query('UPDATE app.routes SET seen_at = now() WHERE question_id = $1 AND profile_id = ANY($2)', [q, first.slice(0, 3)]);
    await askedAgo(q, 25);
    await routeDueQuestions(h.t.database);
    expect((await routedTo(q)).filter(r => r.wave === 2)).toHaveLength(0);
  });

  it('skip wave 3 once there are 3 answers, enough for a consensus', async () => {
    const asker = await member({ fields: ['housing-renting'] });
    for (let i = 0; i < 12; i++) await member({ fields: ['housing-renting'], joinedDaysAgo: 100 });
    const q = await ask(asker.token, 'housing-renting');
    for (let i = 0; i < 3; i++) {
      const helper = await member({ fields: ['housing-renting'] });
      expect((await h.call('POST', `/questions/${q}/answers`, helper.token, { body: `Ask the landlord for the deposit receipt, it took me ${String(i + 2)} weeks.` })).statusCode).toBe(201);
    }
    await routeDueQuestions(h.t.database);
    await askedAgo(q, 65);
    await routeDueQuestions(h.t.database);
    await routeDueQuestions(h.t.database);
    expect((await routedTo(q)).filter(r => r.wave === 3)).toHaveLength(0);
  });
});

describe('the daily budget', () => {
  it('puts at most 3 questions a day to one person (Bible §3.2: attention is scarce)', async () => {
    const asker = await member({ fields: ['shopping'], joinedDaysAgo: 100 });
    const only = await member({ fields: ['shopping'], joinedDaysAgo: 100 });
    for (let i = 0; i < 7; i++) await ask(asker.token, 'shopping');
    await routeDueQuestions(h.t.database);
    const { rows } = await h.t.owner.query<{ n: number }>('SELECT count(*)::int AS n FROM app.routes WHERE profile_id = $1', [only.id]);
    expect(rows).toEqual([{ n: 3 }]);
  });

  it('is held by the database itself, even if the routing job asked for a fourth', async () => {
    const asker = await member({ fields: ['government-services'], joinedDaysAgo: 100 });
    const only = await member({ fields: ['government-services'], joinedDaysAgo: 100 });
    const made: number[] = [];
    for (let i = 0; i < 4; i++) {
      const q = await ask(asker.token, 'government-services');
      await h.t.owner.query('DELETE FROM app.routes WHERE question_id = $1', [q]);
      made.push(await h.t.database.asSystem(async qq =>
        (await qq.query('INSERT INTO app.routes (question_id, profile_id, wave) VALUES ($1, $2, 1)', [q, only.id])).rowCount ?? 0));
    }
    expect(made).toEqual([1, 1, 1, 0]);
  });
});

describe('people already at their daily limit', () => {
  it('don’t take places in a wave: the next people are asked instead', async () => {
    const asker = await member({ fields: ['jobs-careers'], joinedDaysAgo: 100 });
    // Five people who would rank first (they live in the question's country)...
    const busy = [];
    for (let i = 0; i < 5; i++) busy.push(await member({ fields: ['jobs-careers'], country: 'AE', joinedDaysAgo: 100 }));
    // ...have each been asked 3 questions today.
    const earlier: string[] = [];
    for (let i = 0; i < 3; i++) earlier.push(await ask(asker.token, 'cars-vehicles'));
    for (const b of busy) for (const q of earlier) await h.t.owner.query('INSERT INTO app.routes (question_id, profile_id, wave) VALUES ($1, $2, 1)', [q, b.id]);
    const free = [await member({ fields: ['jobs-careers'], joinedDaysAgo: 100 }), await member({ fields: ['jobs-careers'], joinedDaysAgo: 100 })];
    const q = await ask(asker.token, 'jobs-careers', 'AE');
    await routeDueQuestions(h.t.database);
    expect((await routedTo(q)).map(r => r.profile_id).sort()).toEqual(free.map(f => f.id).sort());
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

describe('the score learns from what people did', () => {
  // Without chance, so the order is the score's alone. Everyone joined long
  // ago, so the newcomer places don't apply.
  const noChance = { ...WEIGHTS, chance: 0 };
  const firstPick = async (questionId: string) =>
    (await h.t.database.asSystem(q => routeWave(q, questionId, 1, 1, noChance)))[0];

  /** Points as picks leave them: from a real asker, for a real question. */
  async function points(person: { id: string }, field: string, amount: number) {
    for (let i = 0; i < amount / 5; i++) {
      const giver = await member({ fields: ['travel'], joinedDaysAgo: 30 });
      const qid = await ask(giver.token, field);
      await h.t.owner.query('DELETE FROM app.routes WHERE question_id = $1', [qid]);
      await h.t.owner.query("INSERT INTO app.points_ledger (recipient_id, giver_id, field, amount, reason, question_id) VALUES ($1, $2, $3, 5, 'selected', $4)",
        [person.id, giver.id, field, qid]);
    }
  }

  it('prefers points earned in this field, and ignores points from other fields', async () => {
    const field = 'watches-luxury';
    const asker = await member({ fields: ['travel'], joinedDaysAgo: 30 });
    const carExpert = await member({ fields: [field], joinedDaysAgo: 30 });
    const elsewhereExpert = await member({ fields: [field, 'travel'], joinedDaysAgo: 30 });
    await points(carExpert, field, 20);
    await points(elsewhereExpert, 'travel', 50);
    expect(await firstPick(await ask(asker.token, field))).toBe(carExpert.id);
  });

  it('ranks people who ignore what is put to them below people with no record', async () => {
    const field = 'phones-gadgets';
    const asker = await member({ fields: ['travel'], joinedDaysAgo: 30 });
    const ignorer = await member({ fields: [field], joinedDaysAgo: 30 });
    const fresh = await member({ fields: [field], joinedDaysAgo: 30 });
    // The ignorer has a small edge (one answer an asker said turned out right)...
    const earlier = await ask(asker.token, field);
    await h.t.owner.query('DELETE FROM app.routes WHERE question_id = $1', [earlier]);
    const { rows } = await h.t.owner.query<{ id: string }>('INSERT INTO app.answers (question_id, answerer_id, body) VALUES ($1, $2, $3) RETURNING id',
      [earlier, ignorer.id, 'I did this last year and it went fine for me.']);
    await h.t.owner.query('INSERT INTO app.verdicts (answer_id, correct) VALUES ($1, true)', [must(rows[0]).id]);
    // ...but five earlier questions were put to them, and none answered.
    for (let i = 0; i < 5; i++) {
      const old = await ask(asker.token, 'travel');
      await h.t.owner.query('INSERT INTO app.routes (question_id, profile_id, wave) VALUES ($1, $2, 1)', [old, ignorer.id]);
      // The database stamps the time itself; move it back so today's limit doesn't apply.
      await h.t.owner.query("UPDATE app.routes SET routed_at = now() - interval '3 days' WHERE question_id = $1", [old]);
    }
    expect(await firstPick(await ask(asker.token, field))).toBe(fresh.id);
  });

  it('prefers people whose picked answers in this field turned out right', async () => {
    const field = 'health-hospitals';
    // The wrong one joins first, so a tie (if trust counted for nothing) would favour them.
    const wrong = await member({ fields: [field], joinedDaysAgo: 30 });
    const right = await member({ fields: [field], joinedDaysAgo: 30 });
    // Three different askers each say how a picked answer turned out.
    for (const [answerer, correct] of [[right, true], [right, true], [right, true], [wrong, false], [wrong, false], [wrong, false]] as const) {
      const asker = await member({ fields: ['travel'], joinedDaysAgo: 30 });
      const qid = await ask(asker.token, field);
      await h.t.owner.query('DELETE FROM app.routes WHERE question_id = $1', [qid]);
      const { rows } = await h.t.owner.query<{ id: string }>('INSERT INTO app.answers (question_id, answerer_id, body) VALUES ($1, $2, $3) RETURNING id',
        [qid, answerer.id, 'I did this last year and it went fine for me.']);
      await h.t.owner.query('INSERT INTO app.verdicts (answer_id, correct) VALUES ($1, $2)', [must(rows[0]).id, correct]);
    }
    const asker = await member({ fields: ['travel'], joinedDaysAgo: 30 });
    expect(await firstPick(await ask(asker.token, field))).toBe(right.id);
  });

  it('keeps why each person was asked, for them alone', async () => {
    const field = 'legal-matters';
    const asker = await member({ fields: ['travel'], joinedDaysAgo: 30 });
    const expert = await member({ fields: [field], country: 'IN', joinedDaysAgo: 30 });
    await points(expert, field, 10);
    const qid = await ask(asker.token, field, 'IN');
    await h.t.database.asSystem(q => routeWave(q, qid, 1, 10));
    const { rows } = await h.t.owner.query('SELECT same_country, field_points, trust_pct, answered_pct, newcomer FROM app.routes WHERE question_id = $1 AND profile_id = $2', [qid, expert.id]);
    expect(rows).toEqual([{ same_country: true, field_points: 10, trust_pct: null, answered_pct: null, newcomer: false }]);
  });

  /** The answer rate kept with a new route to this person: what the score saw. */
  async function answeredPct(person: { id: string }, field: string) {
    const asker = await member({ fields: ['travel'], joinedDaysAgo: 30 });
    const qid = await ask(asker.token, field);
    await h.t.database.asSystem(q => routeWave(q, qid, 1, 10, noChance));
    return (await h.t.owner.query<{ answered_pct: number | null }>('SELECT answered_pct FROM app.routes WHERE question_id = $1 AND profile_id = $2', [qid, person.id])).rows[0]?.answered_pct;
  }

  it('gives people a day to answer before a question counts as ignored', async () => {
    const field = 'fitness';
    const asker = await member({ fields: ['travel'], joinedDaysAgo: 30 });
    const busy = await member({ fields: [field], joinedDaysAgo: 30 });
    for (let i = 0; i < 2; i++) {
      const today = await ask(asker.token, 'travel');
      await h.t.owner.query('INSERT INTO app.routes (question_id, profile_id, wave) VALUES ($1, $2, 1)', [today, busy.id]);
    }
    // Two put to them an hour ago, not answered yet: nothing to judge.
    expect(await answeredPct(busy, field)).toBeNull();
  });

  it('doesn’t count an answer a moderator removed as answering', async () => {
    const field = 'shopping';
    const asker = await member({ fields: ['travel'], joinedDaysAgo: 30 });
    const junk = await member({ fields: [field, 'travel'], joinedDaysAgo: 30 });
    const old = await ask(asker.token, 'travel');
    await h.t.owner.query('INSERT INTO app.routes (question_id, profile_id, wave) VALUES ($1, $2, 1)', [old, junk.id]);
    await h.t.owner.query("UPDATE app.routes SET routed_at = now() - interval '3 days' WHERE question_id = $1", [old]);
    const { rows } = await h.t.owner.query<{ id: string }>('INSERT INTO app.answers (question_id, answerer_id, body) VALUES ($1, $2, $3) RETURNING id',
      [old, junk.id, 'Buy followers cheap at my shop, best price today.']);
    expect(await answeredPct(junk, field)).toBe(100);
    await h.t.owner.query("INSERT INTO app.decisions (answer_id, decision) VALUES ($1, 'remove')", [must(rows[0]).id]);
    expect(await answeredPct(junk, field)).toBe(0);
  });
});
