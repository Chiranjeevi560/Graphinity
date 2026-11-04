// Graphinity's own query language model (ADR 0035): how well it predicts titles it never saw, that it suggests only
// phrasing three questions share, and the route: off by default, public titles only, hidden questions never.
import { beforeAll, describe, expect, it } from 'vitest';
import { complete, MIN_QUESTIONS, perplexity, tokens, trainQueryLm } from '../src/ml/query-lm.ts';
import { createCompleter } from '../src/search/completion.ts';
import { startApp, type TestApp } from './helpers/app.ts';
import { must } from './helpers/must.ts';

const places = ['Goa', 'Pune', 'Delhi', 'Kochi', 'Jaipur', 'Mysore'];
const things = ['a laptop', 'a drone', 'two phones', 'a camera', 'gold coins'];
const titles = places.flatMap(p => [
  ...things.map(t => `Customs duty on ${t} at ${p} airport?`),
  `Which ferry goes to the islands from ${p} on Sundays?`,
  `How long does a tourist visa take in ${p}?`,
]);

describe('the model', () => {
  it('predicts unseen titles far better than word frequency alone', () => {
    const train = titles.filter((_, i) => i % 5 !== 0);
    const held = titles.filter((_, i) => i % 5 === 0);
    const lm = trainQueryLm(train);
    // Word frequency alone: what the model would be with no context.
    const counts = new Map<string, number>();
    for (const w of train.flatMap(t => [...tokens(t), '</s>'])) counts.set(w, (counts.get(w) ?? 0) + 1);
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const words = held.flatMap(t => [...tokens(t), '</s>']);
    const unigram = Math.exp(
      -words.reduce((s, w) => s + Math.log(((counts.get(w) ?? 0) + 1) / (total + counts.size)), 0) / words.length,
    );
    expect(perplexity(lm, held)).toBeLessThan(unigram / 2);
  });

  it('finishes a partial word and the phrase after it, from phrasing many questions share', () => {
    const lm = trainQueryLm(titles);
    // Five things are equally likely after "on"; ties go alphabetically.
    expect(complete(lm, 'customs du')[0]).toMatch(/^customs duty on (a|two|gold) /);
    expect(complete(lm, 'which fe')[0]).toMatch(/^which ferry goes to the/);
    expect(complete(lm, '   ')).toEqual([]);
  });

  it('reads words the way people type them, and copes with what it never saw', () => {
    expect(tokens('Customs DUTY, on a “drone”?! ')).toEqual(['customs', 'duty', 'on', 'a', 'drone']);
    const lm = trainQueryLm(titles);
    // A trailing space means the word is finished: suggest what comes next.
    expect(complete(lm, 'customs duty ')[0]).toMatch(/^customs duty on /);
    expect(complete(lm, 'zzz qqq')).toEqual([]);
    expect(perplexity(lm, [])).toBe(Infinity);
    // Unseen words still get a small, positive probability.
    expect(perplexity(lm, ['Totally unseen words here'])).toBeGreaterThan(1);
    // A model trained on nothing has nothing to prefer: every word is certain, and nothing is suggested.
    expect(perplexity(trainQueryLm([]), ['anything'])).toBe(1);
    expect(complete(trainQueryLm([]), 'any')).toEqual([]);
  });

  it('never suggests wording fewer than three questions used', () => {
    const rare = ['Is my neighbour Ravi Kumar allowed to park here?', 'Is my neighbour Ravi Kumar a dentist?'];
    const lm = trainQueryLm([...titles, ...rare]);
    expect(complete(lm, 'is my nei')).toEqual([]);
    const thrice = trainQueryLm([...titles, ...rare, 'Is my neighbour Ravi Kumar moving away?']);
    expect(MIN_QUESTIONS).toBe(3);
    expect(complete(thrice, 'is my nei')[0]).toMatch(/^is my neighbour ravi kumar/);
  });
});

let h: TestApp;
let on = false;
const completer = { current: null as ReturnType<typeof createCompleter> | null };

beforeAll(async () => {
  h = await startApp(() => Date.now(), {
    completionEnabled: () => on,
    completer: { refresh: () => must(completer.current).refresh(), complete: q => must(completer.current).complete(q) },
  });
  completer.current = createCompleter(h.t.database);
  return h.close;
});

describe('GET /search/complete', () => {
  it('is off by default', async () => {
    const res = await h.call('GET', '/search/complete?q=customs');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'completion_off' });
  });

  it('suggests from visible questions only, and refuses odd input', async () => {
    const asker = (await h.person()).id;
    await h.t.owner.query('BEGIN');
    await h.t.owner.query(
      "INSERT INTO app.profiles (id, handle, country, adult_confirmed_at) VALUES ($1, 'lm.asker', 'IN', now())",
      [asker],
    );
    await h.t.owner.query("INSERT INTO app.profile_fields (profile_id, field) VALUES ($1, 'travel')", [asker]);
    await h.t.owner.query('COMMIT');
    // An established account: new ones may post only three questions on their first day.
    await h.t.owner.query("UPDATE app.profiles SET created_at = now() - interval '60 days' WHERE id = $1", [asker]);
    for (const p of ['Goa', 'Pune', 'Delhi'])
      await h.t.owner.query("INSERT INTO app.questions (asker_id, field, title) VALUES ($1, 'travel', $2)", [
        asker,
        `Which ferry goes to the islands from ${p}?`,
      ]);
    // Three more, all hidden by moderators: their words must never come back.
    for (const p of ['Goa', 'Pune', 'Delhi']) {
      const id = must(
        (
          await h.t.owner.query<{ id: string }>(
            "INSERT INTO app.questions (asker_id, field, title) VALUES ($1, 'travel', $2) RETURNING id::text",
            [asker, `Which forger makes fake passports in ${p}?`],
          )
        ).rows[0],
      ).id;
      await h.t.owner.query("INSERT INTO app.decisions (question_id, decision) VALUES ($1, 'remove')", [id]);
    }
    on = true;
    try {
      expect(await must(completer.current).refresh()).toBe(3);
      const ok = await h.call('GET', '/search/complete?q=which%20f');
      expect(ok.statusCode).toBe(200);
      const { suggestions } = ok.json<{ suggestions: string[] }>();
      expect(suggestions[0]).toBe('which ferry goes to the');
      expect(suggestions.join(' ')).not.toMatch(/forger|passport/);
      expect(ok.headers['cache-control']).toBe('public, max-age=300');
      expect((await h.call('GET', '/search/complete')).statusCode).toBe(400);
      expect((await h.call('GET', `/search/complete?q=${'a'.repeat(151)}`)).statusCode).toBe(400);
    } finally {
      on = false;
    }
  });
});
