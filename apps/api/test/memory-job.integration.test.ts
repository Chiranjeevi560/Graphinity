// Episodic memory end to end: only with consent, repeats consolidate, old episodes fade, and it goes with the choice.
import { beforeAll, describe, expect, it } from 'vitest';
import { sweepMemory } from '../src/intelligence/memory-job.ts';
import { startApp, type TestApp } from './helpers/app.ts';
import { must } from './helpers/must.ts';

let h: TestApp;
let names = 0;
beforeAll(async () => {
  h = await startApp(() => Date.now());
  return h.close;
});

async function member(allow: boolean) {
  const p = await h.person();
  names += 1;
  await h.call('POST', '/me/profile', p.token, {
    handle: `memory.${String(names)}`,
    country: 'IN',
    fields: ['travel'],
    adult: true,
  });
  await h.t.owner.query("UPDATE app.profiles SET created_at = now() - interval '2 days' WHERE id = $1", [p.id]);
  if (allow)
    expect(
      (
        await h.call('PUT', '/me/consents', p.token, {
          choices: [{ category: 'memory_personalization', enabled: true }],
        })
      ).statusCode,
    ).toBe(200);
  return p;
}
const question = async () => {
  const asker = await member(false);
  const res = await h.call('POST', '/questions', asker.token, {
    title: `Which ferry reaches island ${String(names)} on Sundays?`,
    field: 'travel',
  });
  return must(res.json<{ question: { id: string } }>().question.id);
};
const rows = async (id: string) =>
  (
    await h.t.owner.query<{ tier: string; key: string; reviews: number }>(
      'SELECT tier, key, reviews FROM app.memory_entries WHERE user_id = $1 ORDER BY tier',
      [id],
    )
  ).rows;

describe('reading a question', () => {
  it('remembers the topic only for someone who turned memory on', async () => {
    const [yes, no] = [await member(true), await member(false)];
    const q = await question();
    await h.call('GET', `/questions/${q}`, yes.token);
    await h.call('GET', `/questions/${q}`, no.token);
    expect(await rows(yes.id)).toEqual([{ tier: 'episodic', key: 'travel', reviews: 0 }]);
    expect(await rows(no.id)).toEqual([]);
  });

  it('counts a re-read within the hour as the same episode', async () => {
    const p = await member(true);
    const q = await question();
    await h.call('GET', `/questions/${q}`, p.token);
    await h.call('GET', `/questions/${q}`, p.token);
    expect(must((await rows(p.id))[0]).reviews).toBe(0);
    await h.t.owner.query("UPDATE app.memory_entries SET seen_at = now() - interval '2 hours' WHERE user_id = $1", [
      p.id,
    ]);
    await h.call('GET', `/questions/${q}`, p.token);
    expect(must((await rows(p.id))[0]).reviews).toBe(1);
  });
});

describe('the daily sweep', () => {
  it('makes repeated topics lasting and forgets faded ones, for each person alone', async () => {
    const [repeated, faded, other] = [await member(true), await member(true), await member(true)];
    const add = (id: string, key: string, reviews: number, ago: string) =>
      h.t.owner.query(
        `INSERT INTO app.memory_entries (user_id, tier, key, reviews, seen_at) VALUES ($1, 'episodic', $2, $3, now() - $4::interval)`,
        [id, key, reviews, ago],
      );
    await add(repeated.id, 'visas', 3, '1 hour');
    await add(faded.id, 'visas', 0, '30 days');
    await add(other.id, 'visas', 0, '1 hour');
    expect(await sweepMemory(h.t.database, Date.now())).toBeGreaterThanOrEqual(2);
    expect((await rows(repeated.id)).map(r => r.tier)).toEqual(['episodic', 'semantic']);
    expect(await rows(faded.id)).toEqual([]);
    expect(await rows(other.id)).toEqual([{ tier: 'episodic', key: 'visas', reviews: 0 }]);
  });

  it('turning memory off takes all of it', async () => {
    const p = await member(true);
    const q = await question();
    await h.call('GET', `/questions/${q}`, p.token);
    await h.call('PUT', '/me/consents', p.token, { choices: [{ category: 'memory_personalization', enabled: false }] });
    expect(await rows(p.id)).toEqual([]);
  });

  it('writes nothing for someone who withdrew after the batch was read', async () => {
    const p = await member(true);
    await h.t.owner.query(
      `INSERT INTO app.memory_entries (user_id, tier, key, reviews) VALUES ($1, 'episodic', 'visas', 3)`,
      [p.id],
    );
    await h.t.owner.query(
      `UPDATE app.user_consent_settings SET enabled = false WHERE user_id = $1 AND category = 'memory_personalization'`,
      [p.id],
    );
    await h.t.owner.query(
      `INSERT INTO app.memory_entries (user_id, tier, key, reviews) VALUES ($1, 'episodic', 'visas', 3)`,
      [p.id],
    );
    await sweepMemory(h.t.database, Date.now());
    expect((await rows(p.id)).map(r => r.tier)).toEqual(['episodic']);
  });

  it('a person can check only their own consent', async () => {
    const [a, b] = [await member(true), await member(true)];
    await expect(
      h.t.database.withUser(a.id, q => q.query('SELECT app.memory_allowed_locked($1)', [b.id])),
    ).rejects.toThrow(/only for yourself/);
  });

  it('counts a lasting topic once a day, though the sweep runs hourly', async () => {
    const p = await member(true);
    await h.t.owner.query(
      `INSERT INTO app.memory_entries (user_id, tier, key, reviews) VALUES ($1, 'episodic', 'visas', 3)`,
      [p.id],
    );
    await sweepMemory(h.t.database, Date.now());
    await sweepMemory(h.t.database, Date.now());
    expect(must((await rows(p.id)).find(r => r.tier === 'semantic')).reviews).toBe(0);
  });
});
