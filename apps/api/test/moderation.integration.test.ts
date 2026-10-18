// Reports, hiding, the owner's review, blocking, new-account limits and
// shared-network hints, through the real server and the database.
import { beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './helpers/app.ts';
import { must, type Body } from './helpers/must.ts';

let h: TestApp;
let names = 0;

beforeAll(async () => {
  h = await startApp(() => Date.now());
  return h.close;
});

async function member(opts: { established?: boolean } = {}) {
  const p = await h.person();
  names += 1;
  const handle = `mod.${String(names)}`;
  expect((await h.call('POST', '/me/profile', p.token, { handle, country: 'IN', fields: ['travel'], adult: true })).statusCode).toBe(201);
  if (opts.established !== false) await h.t.owner.query("UPDATE app.profiles SET created_at = now() - interval '2 days' WHERE id = $1", [p.id]);
  return { ...p, handle };
}

async function moderator() {
  const m = await member();
  // Only the owner can make a moderator, in the SQL editor.
  await h.t.owner.query('INSERT INTO app.moderators (profile_id) VALUES ($1)', [m.id]);
  return m;
}

async function ask(token: string): Promise<string> {
  const res = await h.call('POST', '/questions', token, { title: 'Which ferry goes to the islands on Sundays?', field: 'travel' });
  expect(res.statusCode, res.body).toBe(201);
  return must(res.json<{ question: { id: string } }>().question.id);
}

const report = (token: string, q: string, reason = 'spam', note?: string) =>
  h.call('POST', `/questions/${q}/report`, token, { reason, ...(note ? { note } : {}) });

describe('reporting', () => {
  it('takes a reason, once per person, never on your own post', async () => {
    const author = await member(), reader = await member();
    const q = await ask(author.token);
    expect((await h.call('POST', `/questions/${q}/report`, undefined, { reason: 'spam' })).statusCode).toBe(401);
    expect((await report(author.token, q)).json<Body>().error).toBe('own_post');
    expect((await report(reader.token, q, 'nonsense')).statusCode).toBe(400);
    expect((await report(reader.token, q, 'spam', 'Selling fake tickets')).statusCode).toBe(201);
    expect((await report(reader.token, q, 'abuse')).statusCode).toBe(201);
    const { rows } = await h.t.owner.query('SELECT reason FROM app.reports WHERE question_id = $1', [q]);
    expect(rows).toEqual([{ reason: 'spam' }]);
  });

  it('lets nobody but moderators read others’ reports', async () => {
    const author = await member(), reader = await member(), other = await member();
    const q = await ask(author.token);
    await report(reader.token, q);
    const visible = (who: string | null) => h.t.database.withUser(who, async qq => (await qq.query('SELECT 1 FROM app.reports WHERE question_id = $1', [q])).rowCount);
    expect([await visible(reader.id), await visible(author.id), await visible(other.id), await visible(null)]).toEqual([1, 0, 0, 0]);
  });
});

describe('hiding after three reports', () => {
  it('hides the post from everyone but its author and moderators', async () => {
    const author = await member(), mod = await moderator();
    const q = await ask(author.token);
    for (let i = 0; i < 2; i++) await report((await member()).token, q);
    expect((await h.call('GET', `/questions/${q}`)).statusCode).toBe(200);
    await report((await member()).token, q);
    expect((await h.call('GET', `/questions/${q}`)).statusCode).toBe(404);
    expect((await h.call('GET', '/questions')).json<{ questions: Array<{ id: string }> }>().questions.map(x => x.id)).not.toContain(q);
    expect((await h.call('GET', `/questions/${q}`, author.token)).json<{ question: { hidden: boolean } }>().question.hidden).toBe(true);
    expect((await h.call('GET', `/questions/${q}`, mod.token)).statusCode).toBe(200);
  });

  it('comes back when a moderator keeps it; three new reports hide it again', async () => {
    const author = await member(), mod = await moderator();
    const q = await ask(author.token);
    for (let i = 0; i < 3; i++) await report((await member()).token, q);
    expect((await h.call('POST', '/review/decision', mod.token, { kind: 'question', id: q, decision: 'keep' })).statusCode).toBe(200);
    expect((await h.call('GET', `/questions/${q}`)).statusCode).toBe(200);
    for (let i = 0; i < 2; i++) await report((await member()).token, q);
    expect((await h.call('GET', `/questions/${q}`)).statusCode).toBe(200);
    await report((await member()).token, q);
    expect((await h.call('GET', `/questions/${q}`)).statusCode).toBe(404);
  });

  it('stays hidden once a moderator removes it, reports or not', async () => {
    const author = await member(), mod = await moderator();
    const q = await ask(author.token);
    expect((await h.call('POST', '/review/decision', mod.token, { kind: 'question', id: q, decision: 'remove' })).statusCode).toBe(200);
    expect((await h.call('GET', `/questions/${q}`)).statusCode).toBe(404);
  });
});

describe('the review', () => {
  it('is for moderators only, even straight to the database', async () => {
    const someone = await member();
    const q = await ask(someone.token);
    expect((await h.call('GET', '/review', someone.token)).json<Body>().error).toBe('not_a_moderator');
    expect((await h.call('POST', '/review/decision', someone.token, { kind: 'question', id: q, decision: 'remove' })).statusCode).toBe(403);
    await expect(h.t.database.withUser(someone.id, qq => qq.query("INSERT INTO app.decisions (question_id, decision, decided_by) VALUES ($1, 'remove', $2)", [q, someone.id])))
      .rejects.toMatchObject({ code: '42501' });
    // Nobody can make themselves a moderator.
    await expect(h.t.database.withUser(someone.id, qq => qq.query('INSERT INTO app.moderators (profile_id) VALUES ($1)', [someone.id])))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('lists reported posts with counts, reasons and notes', async () => {
    const author = await member(), mod = await moderator();
    const q = await ask(author.token);
    await report((await member()).token, q, 'spam', 'Same link in every post');
    await report((await member()).token, q, 'misleading');
    const review = (await h.call('GET', '/review', mod.token)).json<{ items: Array<{ id: string; reports: number; reasons: string[]; notes: string[]; author: { handle: string }; hidden: boolean }> }>();
    expect(review.items.find(i => i.id === q)).toMatchObject({
      reports: 2, reasons: ['misleading', 'spam'], notes: ['Same link in every post'], author: { handle: author.handle }, hidden: false,
    });
  });

  it('shows people giving each other points from the same network', async () => {
    const asker = await member(), helper = await member(), mod = await moderator();
    const fromHome = (method: 'POST' | 'PUT', url: string, token: string, payload: object) => h.app.inject({
      method, url, remoteAddress: '203.0.113.7', headers: { authorization: `Bearer ${token}` }, payload,
    });
    const q = must((await fromHome('POST', '/questions', asker.token, { title: 'Is the museum free on the first Sunday?', field: 'travel' })).json<{ question: { id: string } }>().question.id);
    const a = must((await fromHome('POST', `/questions/${q}/answers`, helper.token, { body: 'Yes, every first Sunday of the month.' })).json<{ answer: { id: string } }>().answer.id);
    await fromHome('PUT', `/questions/${q}/selection`, asker.token, { answerId: a });
    // Network marks are written in the background.
    await new Promise(r => setTimeout(r, 200));
    const review = (await h.call('GET', '/review', mod.token)).json<{ sharedNetworks: Array<{ giver: string; recipient: string; points: number }> }>();
    expect(review.sharedNetworks).toContainEqual({ giver: asker.handle, recipient: helper.handle, points: 5 });
    // Stored only as keyed hashes, never the address.
    const { rows } = await h.t.owner.query<{ network_hash: string }>('SELECT network_hash FROM app.network_marks WHERE profile_id = $1', [asker.id]);
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain('203.0.113');
  });
});

describe('blocking', () => {
  it('stops a person posting, answering and reporting until unblocked', async () => {
    const mod = await moderator(), troll = await member(), author = await member();
    const q = await ask(author.token);
    expect((await h.call('POST', '/review/block', troll.token, { handle: author.handle })).statusCode).toBe(403);
    expect((await h.call('POST', '/review/block', mod.token, { handle: mod.handle })).json<Body>().error).toBe('not_yourself');
    expect((await h.call('POST', '/review/block', mod.token, { handle: troll.handle, reason: 'Spam' })).statusCode).toBe(200);
    expect((await h.call('POST', '/questions', troll.token, { title: 'Buy cheap followers here, best price today!', field: 'travel' })).json<Body>().error).toBe('blocked');
    expect((await h.call('POST', `/questions/${q}/answers`, troll.token, { body: 'Buy cheap followers here, best price.' })).json<Body>().error).toBe('blocked');
    expect((await report(troll.token, q)).json<Body>().error).toBe('blocked');
    expect((await h.call('GET', '/me', troll.token)).json<{ blocked: boolean }>().blocked).toBe(true);
    // The database refuses too, whatever the API does.
    await expect(h.t.database.withUser(troll.id, qq => qq.query("INSERT INTO app.questions (asker_id, field, title) VALUES ($1, 'travel', 'A question long enough to ask here')", [troll.id])))
      .rejects.toMatchObject({ code: '42501' });
    await expect(h.t.database.withUser(troll.id, qq => qq.query('DELETE FROM app.blocks WHERE profile_id = $1', [troll.id]))).resolves.toMatchObject({ rowCount: 0 });
    // Reading still works, and so does unblocking.
    expect((await h.call('GET', `/questions/${q}`, troll.token)).statusCode).toBe(200);
    expect((await h.call('DELETE', '/review/block', mod.token, { handle: troll.handle })).statusCode).toBe(200);
    expect((await h.call('POST', `/questions/${q}/answers`, troll.token, { body: 'Take the morning ferry, it is quieter.' })).statusCode).toBe(201);
  });
});

describe('new accounts', () => {
  it('ask 3 questions and give 10 answers on their first day', async () => {
    const fresh = await member({ established: false });
    for (let i = 0; i < 3; i++) await ask(fresh.token);
    const fourth = await h.call('POST', '/questions', fresh.token, { title: 'One more question on the very first day?', field: 'travel' });
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json<Body>()).toMatchObject({ error: 'new_account_limit', message: 'New accounts can ask 3 questions and give 10 answers on their first day. Try again tomorrow.' });

    const asker = await member();
    for (let i = 0; i < 10; i++) {
      const q = await ask(asker.token);
      expect((await h.call('POST', `/questions/${q}/answers`, fresh.token, { body: 'Take the earliest ferry, it is the quietest.' })).statusCode).toBe(201);
    }
    const q = await ask(asker.token);
    expect((await h.call('POST', `/questions/${q}/answers`, fresh.token, { body: 'Take the earliest ferry, it is the quietest.' })).json<Body>().error).toBe('new_account_limit');

    // A day later, the limit is gone.
    await h.t.owner.query("UPDATE app.profiles SET created_at = now() - interval '25 hours' WHERE id = $1", [fresh.id]);
    expect((await h.call('POST', `/questions/${q}/answers`, fresh.token, { body: 'Take the earliest ferry, it is the quietest.' })).statusCode).toBe(201);
  });
});

describe('the database itself', () => {
  it('still hides posts when the table owner is also a member of app_api (as on Supabase, Postgres 16+)', async () => {
    // A regression check for the Supabase setup: the owner is a non-inheriting
    // member of app_api there. (It bypasses row-level security, so the check
    // that counts reports isn't affected by policies written for app_api.)
    const owner = must((await h.t.owner.query<{ me: string }>('SELECT current_user AS me')).rows[0]).me;
    await h.t.owner.query(`GRANT app_api TO ${owner} WITH INHERIT FALSE`);
    try {
      const author = await member();
      const q = await ask(author.token);
      for (let i = 0; i < 3; i++) await report((await member()).token, q);
      expect((await h.call('GET', `/questions/${q}`)).statusCode).toBe(404);
    } finally {
      await h.t.owner.query(`REVOKE app_api FROM ${owner}`);
    }
  });

  it('counts only reports from accounts over a day old, and drops a deleted reporter’s report', async () => {
    const author = await member(), mod = await moderator();
    const q = await ask(author.token);
    const fresh = [await member({ established: false }), await member({ established: false }), await member({ established: false })];
    for (const f of fresh) await report(f.token, q);
    expect((await h.call('GET', `/questions/${q}`)).statusCode).toBe(200);
    // They still reach the review.
    const review = (await h.call('GET', '/review', mod.token)).json<{ items: Array<{ id: string; reports: number }> }>();
    expect(review.items.find(i => i.id === q)?.reports).toBe(3);
    await h.call('DELETE', '/me', must(fresh[0]).token, { confirm: true });
    const { rows } = await h.t.owner.query('SELECT count(*)::int AS n FROM app.reports WHERE question_id = $1', [q]);
    expect(rows).toEqual([{ n: 2 }]);
  });

  it('refuses answers to a hidden question, and a moderator deciding on their own post', async () => {
    const author = await member(), mod = await moderator(), other = await member();
    const q = await ask(author.token);
    await h.call('POST', '/review/decision', mod.token, { kind: 'question', id: q, decision: 'remove' });
    await expect(h.t.database.withUser(other.id, qq => qq.query('INSERT INTO app.answers (question_id, answerer_id, body) VALUES ($1, $2, $3)', [q, other.id, 'An answer that is long enough to count'])))
      .rejects.toMatchObject({ code: '42501' });
    const own = await ask(mod.token);
    await expect(h.t.database.withUser(mod.id, qq => qq.query("INSERT INTO app.decisions (question_id, decision, decided_by) VALUES ($1, 'keep', $2)", [own, mod.id])))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('takes moderation away from a blocked moderator, and never tells the blocked who blocked them', async () => {
    const a = await moderator(), b = await moderator();
    await h.call('POST', '/review/block', a.token, { handle: b.handle, reason: 'Abusing reviews' });
    expect((await h.call('GET', '/review', b.token)).statusCode).toBe(403);
    expect((await h.call('DELETE', '/review/block', b.token, { handle: b.handle })).statusCode).toBe(403);
    const seen = await h.t.database.withUser(b.id, async qq => ({
      blocks: (await qq.query('SELECT * FROM app.blocks WHERE profile_id = $1', [b.id])).rows.length,
      details: (await qq.query('SELECT * FROM app.block_details WHERE profile_id = $1', [b.id])).rows.length,
    }));
    expect(seen).toEqual({ blocks: 1, details: 0 });
  });

  it('holds the new-account limit when a post arrives while another is still being saved', async () => {
    const fresh = await member({ established: false });
    for (let i = 0; i < 2; i++) await ask(fresh.token);
    const insert = 'INSERT INTO app.questions (asker_id, field, title) VALUES ($1, \'travel\', \'A question long enough to ask here\')';
    // The third question, saved but not yet committed...
    await h.t.api.query('BEGIN');
    await h.t.api.query("SELECT set_config('app.user_id', $1, true)", [fresh.id]);
    await h.t.api.query(insert, [fresh.id]);
    // ...while a fourth arrives on another connection. It must wait, then be refused.
    const fourth = h.t.database.withUser(fresh.id, q => q.query(insert, [fresh.id]));
    let settled = false;
    void fourth.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(r => setTimeout(r, 300));
    expect(settled).toBe(false);
    await h.t.api.query('COMMIT');
    await expect(fourth).rejects.toMatchObject({ code: '23514', hint: 'new_account_limit' });
  });

  it('stamps the join date itself', async () => {
    // A join date sent straight to the database is ignored.
    const p = await h.person();
    await h.t.database.withUser(p.id, async qq => {
      await qq.query("INSERT INTO app.profiles (id, handle, country, adult_confirmed_at, created_at) VALUES ($1, 'backdated.one', 'IN', now(), '2020-01-01')", [p.id]);
      await qq.query("INSERT INTO app.profile_fields (profile_id, field) VALUES ($1, 'travel')", [p.id]);
    });
    const { rows } = await h.t.owner.query<{ recent: boolean }>("SELECT created_at > now() - interval '1 minute' AS recent FROM app.profiles WHERE id = $1", [p.id]);
    expect(rows).toEqual([{ recent: true }]);
  });
});
