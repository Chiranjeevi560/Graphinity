// The living graph's data: real, anonymous, and each private part only for
// the one person it belongs to.
import { beforeAll, describe, expect, it } from 'vitest';
import type { PersonEvent } from '../src/events.ts';
import { GRAPH_SAMPLE } from '../src/routes/graph.ts';
import { announceRouting, routeDueQuestions } from '../src/routing.ts';
import { startApp, type TestApp } from './helpers/app.ts';
import { must, type Body } from './helpers/must.ts';

let h: TestApp;
let names = 0;
// The graph is kept a minute; tests move this clock past that to see changes.
let now = Date.now();
const later = () => {
  now += 61_000;
};

beforeAll(async () => {
  h = await startApp(() => now);
  return h.close;
});

async function member(fields: string[], country = 'IN') {
  const p = await h.person();
  names += 1;
  const handle = `graph.${String(names)}`;
  expect((await h.call('POST', '/me/profile', p.token, { handle, country, fields, adult: true })).statusCode).toBe(201);
  return { ...p, handle };
}

async function ask(token: string, field: string, country: string | null) {
  const res = await h.call('POST', '/questions', token, {
    title: 'How much customs did you pay on a watch through Chennai?',
    field,
    country,
  });
  return must(res.json<{ question: { id: string } }>().question.id);
}

describe('the public graph', () => {
  it('counts members per field and samples people as field sets, with no names or ids', async () => {
    const a = await member(['watches-luxury', 'imports-customs']);
    await member(['watches-luxury']);
    later();
    const res = await h.call('GET', '/graph');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    const graph = res.json<{
      fields: Array<{ slug: string; name: string; members: number }>;
      people: number[][];
      activity: { lastDay: { questions: number; answers: number }; recent: Array<{ field: number; kind: string }> };
    }>();
    const watches = graph.fields.findIndex(f => f.slug === 'watches-luxury');
    expect(must(graph.fields[watches]).members).toBeGreaterThanOrEqual(2);
    // Each person once, though one of them knows two fields.
    const { rows } = await h.t.owner.query<{ n: number }>(
      'SELECT count(DISTINCT profile_id)::int AS n FROM app.profile_fields',
    );
    expect(res.json<{ members: number }>().members).toBe(must(rows[0]).n);
    expect(graph.people.length).toBeLessThanOrEqual(GRAPH_SAMPLE);
    // Every person is just positions in the field list.
    for (const p of graph.people) for (const f of p) expect(graph.fields[f]).toBeDefined();
    const text = res.body;
    expect(text).not.toContain(a.handle);
    expect(text).not.toContain(a.id);
  });

  it('counts exactly how many people know each pair of fields, saying nothing under 5', async () => {
    // Pairs only this test uses: 6 know fitness and food, 2 know fitness and parenting.
    for (let i = 0; i < 6; i++) await member(['fitness', 'food-cooking']);
    for (let i = 0; i < 2; i++) await member(['fitness', 'parenting-schools']);
    later();
    const graph = (await h.call('GET', '/graph')).json<{
      fields: Array<{ slug: string }>;
      links: Array<{ a: number; b: number; shared: number | null }>;
    }>();
    const at = (slug: string) => graph.fields.findIndex(f => f.slug === slug);
    const link = (x: string, y: string) =>
      graph.links.find(l => (l.a === at(x) && l.b === at(y)) || (l.a === at(y) && l.b === at(x)));
    // Exact, from everyone, not from the sample the drawing uses.
    expect(link('fitness', 'food-cooking')?.shared).toBe(6);
    // Under 5 the server itself never sends the number.
    expect(link('fitness', 'parenting-schools')).toMatchObject({ shared: null });
    expect(link('food-cooking', 'parenting-schools')).toBeUndefined();
    for (const l of graph.links) {
      expect(l.a).toBeLessThan(l.b);
      if (l.shared !== null) expect(l.shared).toBeGreaterThanOrEqual(5);
    }
  });

  it('shows recent questions and answers per field, but not hidden ones', async () => {
    const asker = await member(['fitness']);
    const q = await ask(asker.token, 'fitness', null);
    later();
    const graph = (await h.call('GET', '/graph')).json<{
      fields: Array<{ slug: string }>;
      activity: { recent: Array<{ field: number; kind: string }>; lastDay: { questions: number } };
    }>();
    const fitness = graph.fields.findIndex(f => f.slug === 'fitness');
    expect(graph.activity.recent).toContainEqual({ field: fitness, kind: 'question' });
    expect(graph.activity.lastDay.questions).toBeGreaterThanOrEqual(1);
    // Removed by a moderator: gone from the activity too.
    await h.t.owner.query("INSERT INTO app.decisions (question_id, decision) VALUES ($1, 'remove')", [q]);
    later();
    const after = (await h.call('GET', '/graph')).json<{ activity: { recent: Array<{ field: number }> } }>();
    expect(after.activity.recent.filter(e => e.field === fitness)).toHaveLength(0);
  });

  it('is built at most once a minute, whoever asks', async () => {
    later();
    const first = (await h.call('GET', '/graph')).json<{ fields: Array<{ slug: string; members: number }> }>();
    const count = () => must(first.fields.find(f => f.slug === 'food-cooking')).members;
    const before = count();
    await member(['food-cooking']);
    const again = (await h.call('GET', '/graph')).json<{ fields: Array<{ slug: string; members: number }> }>();
    expect(must(again.fields.find(f => f.slug === 'food-cooking')).members).toBe(before);
    later();
    const fresh = (await h.call('GET', '/graph')).json<{ fields: Array<{ slug: string; members: number }> }>();
    expect(must(fresh.fields.find(f => f.slug === 'food-cooking')).members).toBe(before + 1);
  });
});

describe('how far a question went', () => {
  it('is told to the asker in numbers only, and to nobody else', async () => {
    const asker = await member(['shopping'], 'GB');
    const experts = [];
    for (let i = 0; i < 6; i++) experts.push(await member(['shopping'], i < 5 ? 'IN' : 'GB'));
    const q = await ask(asker.token, 'shopping', 'IN');
    await routeDueQuestions(h.t.database);
    const view = async (token?: string) => (await h.call('GET', `/questions/${q}`, token)).json<Body>();

    const mine = await view(asker.token);
    // A wave is 5: the five in the question's country rank first.
    expect(mine.routing).toEqual({ waves: 1, asked: 5, inCountry: 5 });
    expect(mine.whyYou).toBeUndefined();
    // Not for visitors, and not for the people it was put to.
    expect((await view()).routing).toBeUndefined();
    expect((await view(must(experts[0]).token)).routing).toBeUndefined();
  });

  it('says "a few" rather than an exact number under 5, which could point at who', async () => {
    const asker = await member(['software-programming'], 'GB');
    await member(['software-programming'], 'IN');
    await member(['software-programming'], 'IN');
    const q = await ask(asker.token, 'software-programming', 'IN');
    await routeDueQuestions(h.t.database);
    expect((await h.call('GET', `/questions/${q}`, asker.token)).json<Body>().routing).toEqual({
      waves: 1,
      asked: null,
      inCountry: null,
    });
  });

  it('tells each person asked why, and only them', async () => {
    const asker = await member(['government-services'], 'GB');
    const expert = await member(['government-services'], 'IN');
    const outsider = await member(['travel'], 'IN');
    const q = await ask(asker.token, 'government-services', 'IN');
    await routeDueQuestions(h.t.database);
    const theirs = (await h.call('GET', `/questions/${q}`, expert.token)).json<Body>();
    expect(theirs.whyYou).toMatchObject({
      sameCountry: true,
      fieldPoints: 0,
      trustPct: null,
      answeredPct: null,
      newcomer: true,
    });
    const why = theirs.whyYou as Record<string, number | null>;
    expect(why.rankingScore).toBeGreaterThanOrEqual(0);
    expect(why.expertiseWeight).toBeGreaterThanOrEqual(0.01);
    expect(why.circadianFit).toBeGreaterThanOrEqual(0);
    expect(why.diversityFit).toBeGreaterThanOrEqual(0);
    expect((await h.call('GET', `/questions/${q}`, outsider.token)).json<Body>().whyYou).toBeUndefined();
    expect((await h.call('GET', `/questions/${q}`, asker.token)).json<Body>().whyYou).toBeUndefined();
  });

  it('the database itself gives the counts to no one but the asker', async () => {
    const asker = await member(['study-abroad']);
    const other = await member(['study-abroad']);
    const q = await ask(asker.token, 'study-abroad', null);
    await routeDueQuestions(h.t.database);
    const summary = (id: string) =>
      h.t.database.withUser(id, async db => (await db.query('SELECT * FROM app.routing_summary($1)', [q])).rows);
    expect(await summary(asker.id)).toHaveLength(1);
    expect(await summary(other.id)).toEqual([]);
  });
});

describe('announcing a wave', () => {
  it('tells the people asked, and tells the asker it went out', () => {
    const heard: Array<[string, PersonEvent]> = [];
    announceRouting({ publish: (id, e) => heard.push([id, e]) }, [
      { questionId: '7', askerId: 'asker', asked: ['a', 'b'] },
      { questionId: '8', askerId: 'nobody-asked', asked: [] },
    ]);
    expect(heard).toEqual([
      ['a', { type: 'routed', questionId: '7' }],
      ['b', { type: 'routed', questionId: '7' }],
      ['asker', { type: 'sent', questionId: '7' }],
    ]);
  });
});
