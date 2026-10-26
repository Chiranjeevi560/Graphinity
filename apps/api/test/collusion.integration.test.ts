// Collusion review end to end (ADR 0017, migration 0025): the daily job finds
// a group picking each other's answers, moderators see it and decide, a
// confirmed group's points are taken back and later picks between its
// members move none, and every rule holds in the database itself.
import { beforeAll, describe, expect, it } from 'vitest';
import { detectCollusion, underCollusionReview } from '../src/collusion.ts';
import { startApp, type TestApp } from './helpers/app.ts';
import { must, type Body } from './helpers/must.ts';

let h: TestApp;
let names = 0;
let seedQuestion = '';

beforeAll(async () => {
  h = await startApp(() => Date.now());
  return h.close;
});

async function member() {
  const p = await h.person();
  names += 1;
  const handle = `ring.${String(names)}`;
  expect(
    (await h.call('POST', '/me/profile', p.token, { handle, country: 'IN', fields: ['travel'], adult: true }))
      .statusCode,
  ).toBe(201);
  await h.t.owner.query("UPDATE app.profiles SET created_at = now() - interval '2 days' WHERE id = $1", [p.id]);
  return { ...p, handle };
}

async function moderator() {
  const m = await member();
  await h.t.owner.query('INSERT INTO app.moderators (profile_id) VALUES ($1)', [m.id]);
  return m;
}

/** Past picks, written straight into the ledger (triggers off) on one real question. */
async function picks(list: ReadonlyArray<[string, string, number]>) {
  if (!seedQuestion) {
    const asker = await member();
    seedQuestion = must(
      (
        await h.t.owner.query<{ id: string }>(
          "INSERT INTO app.questions (asker_id, field, title) VALUES ($1, 'travel', 'Which ferry goes to the islands on Sundays?') RETURNING id::text",
          [asker.id],
        )
      ).rows[0],
    ).id;
  }
  await h.t.owner.query("SET session_replication_role = 'replica'");
  try {
    for (const [giver, recipient, times] of list)
      for (let k = 0; k < times; k++)
        await h.t.owner.query(
          `INSERT INTO app.points_ledger (recipient_id, giver_id, field, amount, reason, question_id)
           VALUES ($1, $2, 'travel', 5, 'selected', $3)`,
          [recipient, giver, seedQuestion],
        );
  } finally {
    await h.t.owner.query("SET session_replication_role = 'origin'");
  }
}

/** A ring of three picking each other once per pair, among honest askers picking honest experts. */
async function world() {
  const ring = [await member(), await member(), await member()];
  const experts = [await member(), await member(), await member(), await member()];
  const askers = await Promise.all(Array.from({ length: 10 }, () => member()));
  const list: Array<[string, string, number]> = [];
  for (const a of ring) for (const b of ring) if (a !== b) list.push([a.id, b.id, 1]);
  for (const a of askers) for (const e of experts) list.push([a.id, e.id, 4]);
  await picks(list);
  return { ring, experts, askers };
}

const points = async (id: string) =>
  must(
    (
      await h.t.owner.query<{ p: number }>(
        'SELECT coalesce(sum(amount), 0)::int AS p FROM app.points_ledger WHERE recipient_id = $1',
        [id],
      )
    ).rows[0],
  ).p;

const groupOf = async (memberId: string) =>
  (
    await h.t.owner.query<{ id: string; public_id: string; status: string; decided_by: string | null }>(
      `SELECT g.id::text, g.public_id::text, g.status, g.decided_by::text FROM app.collusion_groups g
       JOIN app.collusion_members m ON m.group_id = g.id WHERE m.profile_id = $1`,
      [memberId],
    )
  ).rows;

const review = async (token: string) => (await h.call('GET', '/review', token)).json<Body>();
const decide = (token: string, id: string, decision: string) =>
  h.call('POST', '/review/collusion', token, { id, decision });

describe('the collusion job', () => {
  it('records exactly the ring, once, and refreshes it when found again', async () => {
    const { ring, experts, askers } = await world();
    const first = await detectCollusion(h.t.database);
    expect(first.added).toBeGreaterThanOrEqual(1);
    const [group] = await groupOf(must(ring[0]).id);
    expect(group?.status).toBe('open');
    const { rows } = await h.t.owner.query<{ id: string }>(
      'SELECT profile_id::text AS id FROM app.collusion_members WHERE group_id = $1 ORDER BY 1',
      [must(group).id],
    );
    expect(rows.map(r => r.id)).toEqual(ring.map(r => r.id).sort());
    for (const p of [...experts, ...askers]) expect(await groupOf(p.id)).toEqual([]);
    const again = await detectCollusion(h.t.database);
    expect(again.added).toBe(0);
    expect(await groupOf(must(ring[0]).id)).toHaveLength(1);
  });
});

describe('the review', () => {
  it('shows open groups to moderators only, by handle, and nobody else can read or write them', async () => {
    const { ring } = await world();
    await detectCollusion(h.t.database);
    const mod = await moderator();
    const shown = review(mod.token) as Promise<{
      collusion: Array<{ members: Array<{ handle: string }>; picks: number; lift: number }>;
    }>;
    const group = (await shown).collusion.find(g => g.members.some(m => m.handle === must(ring[0]).handle));
    expect(group?.members.map(m => m.handle)).toEqual(ring.map(r => r.handle).sort());
    expect(group?.picks).toBe(6);
    expect(group?.lift).toBeGreaterThanOrEqual(20);
    const someone = must(ring[1]);
    expect((await h.call('GET', '/review', someone.token)).statusCode).toBe(403);
    const seen = await h.t.database.withUser(someone.id, async q => [
      (await q.query('SELECT 1 FROM app.collusion_groups')).rowCount,
      (await q.query('SELECT 1 FROM app.collusion_members')).rowCount,
      (await q.query(`SELECT ${underCollusionReview('$1::uuid')} AS under`, [someone.id])).rows[0],
    ]);
    expect(seen).toEqual([0, 0, { under: false }]);
    await expect(
      h.t.database.withUser(someone.id, q =>
        q.query(
          `INSERT INTO app.collusion_groups (member_key, members, inside, expected, lift) VALUES ($1, 3, 1, 1, 1)`,
          ['a'.repeat(64)],
        ),
      ),
    ).rejects.toThrow();
    await expect(h.t.database.withUser(someone.id, q => q.query('SELECT app.take_back_collusion(1)'))).rejects.toThrow(
      /only moderators/,
    );
  });

  it('confirming takes back the points members gave each other, keeps honest points, and later picks move none', async () => {
    const { ring, experts } = await world();
    await detectCollusion(h.t.database);
    const mod = await moderator();
    const [a, b] = [must(ring[0]), must(ring[1])];
    // A member's pick of an honest expert is not between members: it stays.
    await picks([[a.id, must(experts[0]).id, 1]]);
    const before = await points(must(experts[0]).id);
    expect(await points(a.id)).toBe(10);
    const group = must((await groupOf(a.id))[0]);
    const res = await decide(mod.token, group.public_id, 'confirm');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ decision: { awardsTakenBack: number } }>().decision.awardsTakenBack).toBe(6);
    for (const r of ring) expect(await points(r.id)).toBe(0);
    expect(await points(must(experts[0]).id)).toBe(before);
    expect(must((await groupOf(a.id))[0])).toMatchObject({ status: 'confirmed', decided_by: mod.id });
    // A new pick between two members, through the real flow: it counts, no points move.
    const q = (
      await h.call('POST', '/questions', a.token, {
        title: 'Is the night ferry to the islands safe in June?',
        field: 'travel',
      })
    ).json<{ question: { id: string } }>().question.id;
    const ans = (
      await h.call('POST', `/questions/${q}/answers`, b.token, {
        body: 'Yes, I took it twice last June and it was fine.',
      })
    ).json<{ answer: { id: string } }>().answer.id;
    expect((await h.call('PUT', `/questions/${q}/selection`, a.token, { answerId: ans })).statusCode).toBeLessThan(300);
    const { rows } = await h.t.owner.query<{ amount: number }>(
      "SELECT amount FROM app.points_ledger WHERE question_id = $1 AND reason = 'selected'",
      [q],
    );
    expect(rows).toEqual([{ amount: 0 }]);
    // Decided once.
    expect((await decide(mod.token, group.public_id, 'dismiss')).json<Body>().error).toBe('already_decided');
    // The job finding it again never undoes the decision.
    await detectCollusion(h.t.database);
    expect(must((await groupOf(a.id))[0]).status).toBe('confirmed');
  });

  it('dismissing moves no points and stays dismissed when found again', async () => {
    const { ring } = await world();
    await detectCollusion(h.t.database);
    const mod = await moderator();
    const a = must(ring[0]);
    const group = must((await groupOf(a.id))[0]);
    expect(
      (await decide(mod.token, group.public_id, 'dismiss')).json<{ decision: { awardsTakenBack: number } }>(),
    ).toEqual({
      decision: { id: group.public_id, decision: 'dismiss', awardsTakenBack: 0 },
    });
    expect(await points(a.id)).toBe(10);
    await detectCollusion(h.t.database);
    expect(must((await groupOf(a.id))[0]).status).toBe('dismissed');
    const shown = (await review(mod.token)) as { collusion: Array<{ id: string }> };
    expect(shown.collusion.some(g => g.id === group.public_id)).toBe(false);
  });

  it('refuses a moderator in the group, an unknown group, and non-moderators', async () => {
    const { ring } = await world();
    await detectCollusion(h.t.database);
    const insider = must(ring[0]);
    await h.t.owner.query('INSERT INTO app.moderators (profile_id) VALUES ($1)', [insider.id]);
    const group = must((await groupOf(insider.id))[0]);
    expect((await decide(insider.token, group.public_id, 'confirm')).json<Body>().error).toBe('own_group');
    expect((await decide(insider.token, group.public_id, 'dismiss')).json<Body>().error).toBe('own_group');
    await expect(
      h.t.database.withUser(insider.id, q => q.query('SELECT app.take_back_collusion($1)', [group.id])),
    ).rejects.toThrow();
    expect(must((await groupOf(insider.id))[0]).status).toBe('open');
    const mod = await moderator();
    expect((await decide(mod.token, '00000000-0000-4000-8000-000000000000', 'confirm')).statusCode).toBe(404);
    expect((await decide(mod.token, group.public_id, 'erase')).statusCode).toBe(400);
    expect((await decide(must(ring[1]).token, group.public_id, 'confirm')).statusCode).toBe(403);
    // Taking back from an open group is refused in the database too.
    await expect(
      h.t.database.withUser(mod.id, q => q.query('SELECT app.take_back_collusion($1)', [group.id])),
    ).rejects.toThrow(/confirmed group/);
  });

  it('lets the system measure but never decide, and a moderator decide but never change the numbers', async () => {
    const { ring } = await world();
    await detectCollusion(h.t.database);
    const group = must((await groupOf(must(ring[0]).id))[0]);
    await expect(
      h.t.database.asSystem(q =>
        q.query("UPDATE app.collusion_groups SET status = 'confirmed' WHERE id = $1", [group.id]),
      ),
    ).rejects.toThrow(/only a moderator/);
    const mod = await moderator();
    await expect(
      h.t.database.withUser(mod.id, q =>
        q.query("UPDATE app.collusion_groups SET status = 'dismissed', lift = 1 WHERE id = $1", [group.id]),
      ),
    ).rejects.toThrow(/only dismiss or confirm/);
    // Who decided comes from the session, whatever the request says.
    const other = await member();
    await h.t.database.withUser(mod.id, q =>
      q.query("UPDATE app.collusion_groups SET status = 'dismissed', decided_by = $2 WHERE id = $1", [
        group.id,
        other.id,
      ]),
    );
    expect(must((await groupOf(must(ring[0]).id))[0]).decided_by).toBe(mod.id);
    // Decided once, in the database too.
    await expect(
      h.t.database.withUser(mod.id, q =>
        q.query("UPDATE app.collusion_groups SET status = 'confirmed' WHERE id = $1", [group.id]),
      ),
    ).rejects.toThrow(/already decided/);
  });
});

describe('deleting an account', () => {
  it('takes the whole group with any member, and a deciding moderator can still leave', async () => {
    const { ring } = await world();
    await detectCollusion(h.t.database);
    const mod = await moderator();
    const group = must((await groupOf(must(ring[0]).id))[0]);
    expect((await decide(mod.token, group.public_id, 'dismiss')).statusCode).toBe(200);
    expect((await h.call('DELETE', '/me', mod.token, { confirm: true })).statusCode).toBeLessThan(300);
    expect(must((await groupOf(must(ring[0]).id))[0]).decided_by).toBeNull();
    expect((await h.call('DELETE', '/me', must(ring[2]).token, { confirm: true })).statusCode).toBeLessThan(300);
    expect(await groupOf(must(ring[0]).id)).toEqual([]);
    const { rows } = await h.t.owner.query('SELECT 1 FROM app.collusion_groups WHERE id = $1', [group.id]);
    expect(rows).toEqual([]);
  });
});

describe('learning', () => {
  it('leaves out accounts in open or confirmed groups, not dismissed ones', async () => {
    const { ring, experts } = await world();
    await detectCollusion(h.t.database);
    const under = (id: string) =>
      h.t.database.asSystem(
        async q => (await q.query<{ u: boolean }>(`SELECT ${underCollusionReview('$1::uuid')} AS u`, [id])).rows[0]?.u,
      );
    expect(await under(must(ring[0]).id)).toBe(true);
    expect(await under(must(experts[0]).id)).toBe(false);
    const mod = await moderator();
    await decide(mod.token, must((await groupOf(must(ring[0]).id))[0]).public_id, 'dismiss');
    expect(await under(must(ring[0]).id)).toBe(false);
  });
});
