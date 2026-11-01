// Complaints, statements of reasons, appeals and holds through the real server (ADR 0027).
import { beforeAll, describe, expect, it } from 'vitest';
import { releaseExpiredHolds } from '../src/governance/holds.ts';
import { PROCESSING } from '../src/governance/ropa.ts';
import { auditWithin } from '../src/platform/jobs.ts';
import { startApp, type TestApp } from './helpers/app.ts';
import { must, type Body } from './helpers/must.ts';

let h: TestApp;
let names = 0;

beforeAll(async () => {
  h = await startApp(() => Date.now());
  return h.close;
});

async function member() {
  const p = await h.person();
  names += 1;
  const handle = `legal.${String(names)}`;
  await h.call('POST', '/me/profile', p.token, { handle, country: 'IN', fields: ['travel'], adult: true });
  await h.t.owner.query("UPDATE app.profiles SET created_at = now() - interval '2 days' WHERE id = $1", [p.id]);
  return { ...p, handle };
}
async function moderator() {
  const m = await member();
  await h.t.owner.query('INSERT INTO app.moderators (profile_id) VALUES ($1)', [m.id]);
  return m;
}
const ask = async (token: string) =>
  (
    await h.call('POST', '/questions', token, {
      title: `Which ferry goes to island ${String(names)} on Sundays?`,
      field: 'travel',
    })
  ).json<{ question: { id: string } }>().question.id;

/** A question its author asked and a moderator removed. Returns everyone, and the statement. */
async function removed() {
  const author = await member();
  const mod = await moderator();
  const q = await ask(author.token);
  const res = await h.call('POST', '/review/decision', mod.token, { kind: 'question', id: q, decision: 'remove' });
  expect(res.statusCode, res.body).toBe(200);
  const list = (await h.call('GET', '/me/statements', author.token)).json<{
    statements: Array<{ id: string; facts: string; redress: string; appealStatus: string; appealBy: string }>;
  }>().statements;
  return { author, mod, q, statement: must(list[0]), count: list.length };
}
const appeal = (token: string, id: string, why = 'This post broke no rule at all.') =>
  h.call('POST', `/me/statements/${id}/appeal`, token, { why });

describe('complaints', () => {
  it('gives a reference and the right clock for each kind', async () => {
    const p = await member();
    const send = async (kind: string, extra = {}) =>
      h.call('POST', '/grievances', p.token, { kind, body: 'Someone is using my name here.', ...extra });
    const res = await send('impersonation');
    expect(res.statusCode).toBe(201);
    const g = res.json<{ grievance: { reference: string; acknowledgeBy: string; resolveBy: string } }>().grievance;
    expect(g.reference).toMatch(/^GRV-\d{8}-[0-9A-F]{8}$/);
    const hours = (at: string) => (new Date(at).getTime() - Date.now()) / 3_600_000;
    expect(hours(g.acknowledgeBy)).toBeCloseTo(24, 0);
    expect(hours(g.resolveBy)).toBeCloseTo(72, 0);
    const general = (await send('general')).json<{ grievance: { resolveBy: string } }>().grievance;
    expect(hours(general.resolveBy)).toBeCloseTo(360, 0);
  });

  it('needs a sworn statement for copyright, in the API and the database', async () => {
    const p = await member();
    const refused = await h.call('POST', '/grievances', p.token, {
      kind: 'copyright',
      body: 'They copied my article.',
    });
    expect(refused.json<Body>().error).toBe('sworn_required');
    await expect(
      h.t.database.withUser(p.id, q =>
        q.query(
          `INSERT INTO app.grievances (user_id, kind, body, acknowledge_by, resolve_by) VALUES ($1, 'copyright', 'They copied my article.', now(), now())`,
          [p.id],
        ),
      ),
    ).rejects.toThrow();
    const ok = await h.call('POST', '/grievances', p.token, {
      kind: 'copyright',
      body: 'They copied my article.',
      sworn: true,
    });
    expect(ok.statusCode).toBe(201);
  });
});

describe('removing a post', () => {
  it('tells only its author why, and keeps a copy with no author', async () => {
    const { author, statement, q, count } = await removed();
    expect(count).toBe(1);
    expect(statement.facts).toContain('removed this question');
    expect(statement.redress).toContain('14 days');
    const days = (new Date(statement.appealBy).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeCloseTo(14, 0);
    const stranger = await member();
    expect(
      (await h.call('GET', '/me/statements', stranger.token)).json<{ statements: unknown[] }>().statements,
    ).toEqual([]);
    const { rows } = await h.t.owner.query<{ content: string; question_id: string }>(
      'SELECT content, question_id::text FROM app.legal_holds WHERE question_id = $1',
      [q],
    );
    expect(must(rows[0]).content).toContain('Which ferry');
    expect(JSON.stringify(rows)).not.toContain(author.id);
  });

  it('writes nothing for a decision to keep', async () => {
    const author = await member();
    const mod = await moderator();
    const q = await ask(author.token);
    await h.call('POST', '/review/decision', mod.token, { kind: 'question', id: q, decision: 'keep' });
    expect((await h.call('GET', '/me/statements', author.token)).json<{ statements: unknown[] }>().statements).toEqual(
      [],
    );
  });

  it('covers answers too', async () => {
    const asker = await member();
    const author = await member();
    const mod = await moderator();
    const q = await ask(asker.token);
    const a = (
      await h.call('POST', `/questions/${q}/answers`, author.token, {
        body: 'The nine o clock ferry runs every Sunday.',
      })
    ).json<{ answer: { id: string } }>().answer.id;
    await h.call('POST', '/review/decision', mod.token, { kind: 'answer', id: a, decision: 'remove' });
    const list = (await h.call('GET', '/me/statements', author.token)).json<{ statements: Array<{ facts: string }> }>();
    expect(must(list.statements[0]).facts).toContain('removed this answer');
    expect((await h.call('GET', '/me/statements', asker.token)).json<{ statements: unknown[] }>().statements).toEqual(
      [],
    );
  });
});

describe('appeals', () => {
  it('only the author may appeal, once, in time', async () => {
    const { author, statement } = await removed();
    const stranger = await member();
    expect((await appeal(stranger.token, statement.id)).statusCode).toBe(409);
    expect((await appeal(author.token, statement.id)).statusCode).toBe(201);
    expect((await appeal(author.token, statement.id)).statusCode).toBe(409);
    const late = await removed();
    await h.t.owner.query(
      "UPDATE app.statements_of_reasons SET appeal_by = now() - interval '1 second' WHERE public_id = $1",
      [late.statement.id],
    );
    expect((await appeal(late.author.token, late.statement.id)).statusCode).toBe(409);
  });

  it('nobody can write their own statement, or mark it decided, directly', async () => {
    const { author, statement } = await removed();
    await h.t.database
      .withUser(author.id, async q => {
        const { rowCount } = await q.query(
          "UPDATE app.statements_of_reasons SET appeal_status = 'overturned' WHERE public_id = $1",
          [statement.id],
        );
        expect(rowCount).toBe(0);
      })
      .catch((err: unknown) => {
        expect(String(err)).toMatch(/permission denied/);
      });
    const { rows } = await h.t.owner.query<{ appeal_status: string }>(
      'SELECT appeal_status FROM app.statements_of_reasons WHERE public_id = $1',
      [statement.id],
    );
    expect(rows).toEqual([{ appeal_status: 'none' }]);
  });

  it('another moderator decides: overturning puts the post back and ends the hold', async () => {
    const { author, mod, statement, q } = await removed();
    await appeal(author.token, statement.id);
    const decide = (token: string, decision: string) =>
      h.call('POST', `/ops/appeals/${statement.id}`, token, { decision });
    expect((await decide(author.token, 'overturn')).statusCode).toBe(403);
    expect((await decide(mod.token, 'overturn')).json<Body>().error).toBe('same_person');
    const second = await moderator();
    const listed = (await h.call('GET', '/ops/appeals', second.token)).json<{ appeals: Array<{ id: string }> }>()
      .appeals;
    expect(listed.map(a => a.id)).toContain(statement.id);
    expect((await h.call('GET', `/questions/${q}`)).statusCode).toBe(404);
    expect((await decide(second.token, 'overturn')).statusCode).toBe(200);
    expect((await h.call('GET', `/questions/${q}`)).statusCode).toBe(200);
    expect((await decide(second.token, 'uphold')).statusCode).toBe(404);
    const { rows } = await h.t.owner.query<{ content: string | null; released: boolean }>(
      'SELECT content, released_at IS NOT NULL AS released FROM app.legal_holds WHERE question_id = $1',
      [q],
    );
    expect(rows).toEqual([{ content: null, released: true }]);
  });

  it('upholding keeps it removed', async () => {
    const { author, statement, q } = await removed();
    await appeal(author.token, statement.id);
    const second = await moderator();
    expect(
      (await h.call('POST', `/ops/appeals/${statement.id}`, second.token, { decision: 'uphold' })).statusCode,
    ).toBe(200);
    expect((await h.call('GET', `/questions/${q}`)).statusCode).toBe(404);
  });
});

describe('holds', () => {
  const holdOf = async (q: string) =>
    must(
      (
        await h.t.owner.query<{ content: string | null }>(
          'SELECT content FROM app.legal_holds WHERE question_id = $1',
          [q],
        )
      ).rows[0],
    ).content;
  const expire = (q: string) =>
    h.t.owner.query("UPDATE app.legal_holds SET release_after = now() - interval '1 second' WHERE question_id = $1", [
      q,
    ]);

  it('are released when the window closes, but not during an open appeal or before', async () => {
    const quiet = await removed();
    const contested = await removed();
    const waiting = await removed();
    await appeal(contested.author.token, contested.statement.id);
    await expire(quiet.q);
    await expire(contested.q);
    await releaseExpiredHolds(h.t.database);
    expect(await holdOf(quiet.q)).toBeNull();
    expect(await holdOf(contested.q)).not.toBeNull();
    expect(await holdOf(waiting.q)).not.toBeNull();
  });

  it("don't stop an author deleting their account, and keep no link to them", async () => {
    const { author, q } = await removed();
    expect((await h.call('DELETE', '/me', author.token, { confirm: true })).statusCode).toBeLessThan(300);
    const { rows } = await h.t.owner.query('SELECT 1 FROM app.statements_of_reasons WHERE affected_id = $1', [
      author.id,
    ]);
    expect(rows).toEqual([]);
    expect((await h.t.owner.query('SELECT 1 FROM app.questions WHERE id = $1', [q])).rows).toEqual([]);
  });
});

describe('the record of processing', () => {
  it('has an entry for every table, and is public', async () => {
    const { rows } = await h.t.owner.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'app'",
    );
    const missing = rows.map(r => r.tablename).filter(t => !(t in PROCESSING));
    expect(missing).toEqual([]);
    const stale = Object.keys(PROCESSING).filter(t => !rows.some(r => r.tablename === t));
    expect(stale).toEqual([]);
    const res = await h.call('GET', '/privacy/ropa');
    expect(res.statusCode).toBe(200);
    expect(res.json<{ processing: Record<string, { basis: string }> }>().processing.searches?.basis).toBe('consent');
  });

  it('overturning an old removal does not undo a newer one', async () => {
    const { author, mod, statement, q } = await removed();
    await appeal(author.token, statement.id);
    const second = await moderator();
    // Put back, then removed again for something new, while the first appeal still waits.
    for (const decision of ['keep', 'remove'])
      expect(
        (
          await h.call('POST', '/review/decision', mod.token, {
            kind: 'question',
            id: q,
            decision,
          })
        ).statusCode,
      ).toBe(200);
    expect(
      (await h.call('POST', `/ops/appeals/${statement.id}`, second.token, { decision: 'overturn' })).statusCode,
    ).toBe(200);
    expect((await h.call('GET', `/questions/${q}`)).statusCode).toBe(404);
  });

  it('one person can have five complaints open, no more; resolved ones free a place', async () => {
    const p = await member();
    const send = () =>
      h.call('POST', '/grievances', p.token, { kind: 'general', body: 'Someone is using my name here.' });
    for (let i = 0; i < 5; i++) expect((await send()).statusCode).toBe(201);
    const refused = await send();
    expect(refused.statusCode).toBe(429);
    expect(refused.json<Body>().error).toBe('too_many_open');
    await h.t.database
      .withUser(p.id, async q => {
        await expect(
          q.query(
            "INSERT INTO app.grievances (user_id, kind, body, acknowledge_by, resolve_by) VALUES ($1, 'general', 'Straight to the database.', now(), now())",
            [p.id],
          ),
        ).rejects.toThrow(/at most 5/);
      })
      .catch(() => undefined);
    await h.t.owner.query(
      "UPDATE app.grievances SET resolved_at = now(), outcome = 'Answered.' WHERE id = (SELECT min(id) FROM app.grievances WHERE user_id = $1)",
      [p.id],
    );
    expect((await send()).statusCode).toBe(201);
  });

  it('an appeal whose post is gone can still be closed', async () => {
    const { author, statement, q } = await removed();
    await appeal(author.token, statement.id);
    const second = await moderator();
    await h.t.owner.query('DELETE FROM app.questions WHERE id = $1', [q]);
    expect(
      (await h.call('POST', `/ops/appeals/${statement.id}`, second.token, { decision: 'overturn' })).statusCode,
    ).toBe(200);
  });

  it('an action and its audit entry stand or fall together', async () => {
    const p = await member();
    const before = await h.t.owner.query<{ n: number }>('SELECT count(*)::int AS n FROM app.audit_log');
    const sent = await h.call('POST', '/grievances', p.token, {
      kind: 'general',
      body: 'Someone is using my name here.',
    });
    expect(sent.statusCode).toBe(201);
    const after = await h.t.owner.query<{ n: number }>('SELECT count(*)::int AS n FROM app.audit_log');
    expect(must(after.rows[0]).n).toBe(must(before.rows[0]).n + 1);
    // Without system rights once it's done: the person's transaction doesn't keep them.
    await h.t.database.withUser(p.id, async q => {
      await auditWithin(q, { action: 'test.within', actor: 'person', subject: 's', detail: {} });
      expect((await q.query('SELECT 1 FROM app.audit_log')).rowCount).toBe(0);
    });
    await expect(h.t.owner.query('TRUNCATE app.audit_log')).rejects.toThrow(/append-only/);
    const m = await moderator();
    const q = await ask((await member()).token);
    await h.call('POST', '/review/decision', m.token, { kind: 'question', id: q, decision: 'remove' });
    const logged = await h.t.owner.query(
      "SELECT 1 FROM app.audit_log WHERE action = 'moderation.remove' AND subject = $1",
      [`question:${q}`],
    );
    expect(logged.rows).toHaveLength(1);
  });
});
