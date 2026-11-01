// Remembered topics reaching the feed.
import { beforeAll, describe, expect, it } from 'vitest';
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
    handle: `mem.${String(names)}`,
    country: 'IN',
    fields,
    adult: true,
  });
  expect(res.statusCode, res.body).toBe(201);
  return p;
}

const allow = (token: string, categories: string[], enabled = true) =>
  h.call('PUT', '/me/consents', token, { choices: categories.map(category => ({ category, enabled })) });

describe('remembered topics in the feed', () => {
  it('recommends from them only while memory is on, and says why', async () => {
    const asker = await member(['travel']);
    const posted = await h.call('POST', '/questions', asker.token, {
      title: 'How long does a tourist visa take?',
      field: 'travel',
    });
    const id = must(posted.json<{ question: { id: string } }>().question.id);
    const reader = await member(['imports-customs']);
    expect((await allow(reader.token, ['feed_personalization', 'memory_personalization'])).statusCode).toBe(200);
    const feed = async () =>
      (await h.call('GET', '/me/recommendations', reader.token)).json<{
        recommendations: Array<{ id: string; reason: string; trace?: { source: string; consent: string | null } }>;
      }>().recommendations;
    await h.t.owner.query(
      `INSERT INTO app.memory_entries (user_id, tier, key, reviews) VALUES ($1, 'semantic', 'travel', 4)`,
      [reader.id],
    );
    const found = (await feed()).find(r => r.id === id);
    expect(found?.reason).toBe('In a topic you keep coming back to');
    // Withdrawing deletes the memory, so it can't feed anything.
    expect((await allow(reader.token, ['memory_personalization'], false)).statusCode).toBe(200);
    const after = (await feed()).find(r => r.id === id);
    expect(after?.reason).not.toBe('In a topic you keep coming back to');
  });
});
