// The points rules, tested straight against Postgres as the restricted API
// role, as if the API had a bug or was misused: the database must refuse
// every way of getting points that didn't happen.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Database, Queryable } from '../src/db.ts';
import { createTestDatabase, type TestDatabase } from './helpers/database.ts';
import { must } from './helpers/must.ts';

let t: TestDatabase;
let db: Database;

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.database;
  return async () => {
    await t.close();
  };
});

let names = 0;
async function member(): Promise<string> {
  const id = randomUUID();
  names += 1;
  await db.withUser(id, async q => {
    await q.query("INSERT INTO app.profiles (id, handle, country, adult_confirmed_at) VALUES ($1, $2, 'IN', now())", [
      id,
      `points.${String(names)}`,
    ]);
    await q.query("INSERT INTO app.profile_fields (profile_id, field) VALUES ($1, 'imports-customs')", [id]);
  });
  // An established member: these tests ask more than a new account may on day one.
  await t.owner.query("UPDATE app.profiles SET created_at = now() - interval '2 days' WHERE id = $1", [id]);
  return id;
}

async function question(asker: string): Promise<string> {
  return db.withUser(
    asker,
    async q =>
      must(
        (
          await q.query<{ id: string }>(
            "INSERT INTO app.questions (asker_id, field, title) VALUES ($1, 'imports-customs', 'A question long enough to ask here') RETURNING id::text AS id",
            [asker],
          )
        ).rows[0],
      ).id,
  );
}

async function answer(questionId: string, answerer: string): Promise<string> {
  return db.withUser(
    answerer,
    async q =>
      must(
        (
          await q.query<{ id: string }>(
            "INSERT INTO app.answers (question_id, answerer_id, body) VALUES ($1, $2, 'An answer that is long enough to count') RETURNING id::text AS id",
            [questionId, answerer],
          )
        ).rows[0],
      ).id,
  );
}

const as = <T>(user: string, work: (q: Queryable) => Promise<T>) => db.withUser(user, work);
const select = (asker: string, questionId: string, answerId: string) =>
  as(asker, q =>
    q.query('INSERT INTO app.selections (question_id, answer_id) VALUES ($1, $2)', [questionId, answerId]),
  );
const change = (asker: string, questionId: string, answerId: string, reason: string | null = 'better_answer_later') =>
  as(asker, q =>
    q.query('UPDATE app.selections SET answer_id = $2, change_reason = $3 WHERE question_id = $1', [
      questionId,
      answerId,
      reason,
    ]),
  );
const markHelpful = (asker: string, answerId: string) =>
  as(asker, q => q.query('INSERT INTO app.helpful_marks (answer_id) VALUES ($1)', [answerId]));

async function points(person: string): Promise<number> {
  const { rows } = await t.owner.query<{ total: number }>(
    'SELECT COALESCE(sum(amount), 0)::int AS total FROM app.points_ledger WHERE recipient_id = $1',
    [person],
  );
  return must(rows[0]).total;
}

describe('picking an answer', () => {
  it('gives its author 5 points, and only the asker can pick', async () => {
    const asker = await member(),
      author = await member(),
      stranger = await member();
    const q = await question(asker);
    const a = await answer(q, author);
    await expect(select(stranger, q, a)).rejects.toMatchObject({ code: '42501' });
    await select(asker, q, a);
    expect(await points(author)).toBe(5);
  });

  it('refuses an answer from another question', async () => {
    const asker = await member(),
      author = await member();
    const q1 = await question(asker),
      q2 = await question(asker);
    const elsewhere = await answer(q2, author);
    await expect(select(asker, q1, elsewhere)).rejects.toMatchObject({ code: '23514' });
  });

  it('moves the points on a change, needs a reason, and allows two changes', async () => {
    const asker = await member(),
      a1 = await member(),
      a2 = await member(),
      a3 = await member();
    const q = await question(asker);
    const [x, y, z] = [await answer(q, a1), await answer(q, a2), await answer(q, a3)];
    await select(asker, q, x);
    await expect(change(asker, q, y, null)).rejects.toMatchObject({ code: '23514' });
    await change(asker, q, y);
    expect([await points(a1), await points(a2)]).toEqual([0, 5]);
    await change(asker, q, z, 'turned_out_wrong');
    await expect(change(asker, q, x)).rejects.toMatchObject({ code: '23514' });
    expect([await points(a1), await points(a2), await points(a3)]).toEqual([0, 0, 5]);
    const { rows } = await t.owner.query<{ changes: number }>(
      'SELECT changes FROM app.selections WHERE question_id = $1',
      [q],
    );
    expect(rows).toEqual([{ changes: 2 }]);
  });

  it('counts changes itself, whatever the caller sends', async () => {
    const asker = await member(),
      a1 = await member(),
      a2 = await member();
    const q = await question(asker);
    const [x, y] = [await answer(q, a1), await answer(q, a2)];
    await select(asker, q, x);
    // The API role has no right to set the count at all.
    await expect(
      as(asker, qq => qq.query('UPDATE app.selections SET changes = 0 WHERE question_id = $1', [q])),
    ).rejects.toMatchObject({ code: '42501' });
    await change(asker, q, y);
    await change(asker, q, x);
    await expect(change(asker, q, y)).rejects.toMatchObject({ code: '23514' });
  });
});

describe('the ledger', () => {
  it('refuses points that didn’t happen, even sent straight to it', async () => {
    const asker = await member(),
      friend = await member();
    const q = await question(asker);
    const a = await answer(q, friend);
    const forge = (giver: string, recipient: string, amount: number, reason: string, reverses: string | null = null) =>
      as(giver, qq =>
        qq.query(
          "INSERT INTO app.points_ledger (recipient_id, giver_id, field, amount, reason, question_id, answer_id, reverses) VALUES ($1, $2, 'imports-customs', $3, $4, $5, $6, $7)",
          [recipient, giver, amount, reason, q, a, reverses],
        ),
      );
    // No pick, no mark: nothing to award.
    await expect(forge(asker, friend, 5, 'selected')).rejects.toMatchObject({ code: '42501' });
    await expect(forge(asker, friend, 2, 'helpful')).rejects.toMatchObject({ code: '42501' });
    await select(asker, q, a);
    await markHelpful(asker, a);
    // Giving as someone who isn't the asker (here, to themselves).
    await expect(forge(friend, friend, 2, 'helpful')).rejects.toMatchObject({ code: '42501' });
    // A second award for the same pick.
    await expect(forge(asker, friend, 5, 'selected')).rejects.toMatchObject({ code: '23505' });
    // Taking back an award whose answer is still the pick.
    const award = must(
      (
        await t.owner.query<{ id: string }>(
          "SELECT id::text AS id FROM app.points_ledger WHERE answer_id = $1 AND reason = 'selected'",
          [a],
        )
      ).rows[0],
    ).id;
    await expect(forge(asker, friend, -5, 'selection_changed', award)).rejects.toMatchObject({ code: '42501' });
    // A real helpful mark, but the wrong amount for it.
    await expect(forge(asker, friend, 50, 'helpful')).rejects.toMatchObject({ code: '23514' });
    expect(await points(friend)).toBe(7);
  });

  it('can’t be edited or deleted by the API', async () => {
    const asker = await member(),
      author = await member();
    const q = await question(asker);
    await select(asker, q, await answer(q, author));
    await expect(
      as(asker, qq => qq.query('UPDATE app.points_ledger SET amount = 5 WHERE recipient_id = $1', [author])),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      as(asker, qq => qq.query('DELETE FROM app.points_ledger WHERE recipient_id = $1', [author])),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('isn’t fooled by a temporary table standing in for a real one', async () => {
    const asker = await member(),
      author = await member(),
      outsider = await member();
    const q = await question(asker);
    const a = await answer(q, author);
    await as(asker, async qq => {
      await qq.query('CREATE TEMP TABLE answers (id bigint, question_id bigint, answerer_id uuid) ON COMMIT DROP');
      await qq.query('INSERT INTO answers VALUES ($1, $2, $3)', [a, q, outsider]);
      await qq.query('INSERT INTO app.selections (question_id, answer_id) VALUES ($1, $2)', [q, a]);
    });
    expect([await points(author), await points(outsider)]).toEqual([5, 0]);
  });
});

describe('helpful marks', () => {
  it('give 2 points once, only from the asker', async () => {
    const asker = await member(),
      author = await member(),
      stranger = await member();
    const q = await question(asker);
    const a = await answer(q, author);
    await expect(markHelpful(stranger, a)).rejects.toMatchObject({ code: '42501' });
    await markHelpful(asker, a);
    await expect(markHelpful(asker, a)).rejects.toMatchObject({ code: '23505' });
    expect(await points(author)).toBe(2);
  });
});

describe('the pair cap', () => {
  it('lets one asker give one person points 3 times in 30 days; picks still work after', async () => {
    const asker = await member(),
      author = await member();
    for (let i = 0; i < 4; i++) {
      const q = await question(asker);
      await select(asker, q, await answer(q, author));
    }
    expect(await points(author)).toBe(15);
    const { rows } = await t.owner.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM app.selections s JOIN app.questions q ON q.id = s.question_id WHERE q.asker_id = $1',
      [asker],
    );
    expect(rows).toEqual([{ n: 4 }]);
  });

  it('frees a slot when an award is taken back, and resets after 30 days', async () => {
    const asker = await member(),
      author = await member(),
      other = await member();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const q = await question(asker);
      ids.push(q);
      await select(asker, q, await answer(q, author));
    }
    // Move one pick away from the author: their award is taken back.
    const first = must(ids[0]);
    await change(asker, first, await answer(first, other));
    const q4 = await question(asker);
    await select(asker, q4, await answer(q4, author));
    expect(await points(author)).toBe(15);
    // Age every award to 31 days, as the owner (time travel for the test).
    await t.owner.query(
      "UPDATE app.points_ledger SET created_at = now() - interval '31 days' WHERE recipient_id = $1",
      [author],
    );
    const q5 = await question(asker);
    await select(asker, q5, await answer(q5, author));
    expect(await points(author)).toBe(20);
  });

  it('holds when many picks arrive at the same moment', async () => {
    const asker = await member(),
      author = await member();
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < 6; i++) {
      const q = await question(asker);
      pairs.push([q, await answer(q, author)]);
    }
    // Separate connections, all at once.
    await Promise.all(pairs.map(([q, a]) => select(asker, q, a)));
    expect(await points(author)).toBe(15);
  });
});

describe('awards the cap stopped', () => {
  it('can’t be paid out later by writing the ledger directly', async () => {
    const asker = await member(),
      author = await member();
    for (let i = 0; i < 3; i++) {
      const q = await question(asker);
      await select(asker, q, await answer(q, author));
    }
    // Over the cap: the pick and the mark work, no points move.
    const q = await question(asker);
    const a = await answer(q, author);
    await select(asker, q, a);
    await markHelpful(asker, a);
    expect(await points(author)).toBe(15);
    // A month later the cap has room again; the stopped awards stay stopped.
    await t.owner.query(
      "UPDATE app.points_ledger SET created_at = now() - interval '31 days' WHERE recipient_id = $1",
      [author],
    );
    const pay = (amount: number, reason: string) =>
      as(asker, qq =>
        qq.query(
          "INSERT INTO app.points_ledger (recipient_id, giver_id, field, amount, reason, question_id, answer_id) VALUES ($1, $2, 'imports-customs', $3, $4, $5, $6)",
          [author, asker, amount, reason, q, a],
        ),
      );
    await expect(pay(2, 'helpful')).rejects.toMatchObject({ code: '23505' });
    await expect(pay(5, 'selected')).rejects.toMatchObject({ code: '23505' });
    expect(await points(author)).toBe(15);
  });
});

describe('when the picked answer’s author deletes their account', () => {
  it('keeps the count of changes, makes picking again free, and nobody can empty a pick by hand', async () => {
    const asker = await member(),
      leaving = await member(),
      staying = await member(),
      third = await member();
    const q = await question(asker);
    const [x, y, z] = [await answer(q, staying), await answer(q, leaving), await answer(q, third)];
    await select(asker, q, x);
    await change(asker, q, y);
    // Emptying a pick by hand would be a free change: refused.
    await expect(
      as(asker, qq => qq.query('UPDATE app.selections SET answer_id = NULL WHERE question_id = $1', [q])),
    ).rejects.toMatchObject({ code: '23514' });
    await as(leaving, qq => qq.query('DELETE FROM app.profiles WHERE id = $1', [leaving]));
    const after = await t.owner.query('SELECT answer_id, changes FROM app.selections WHERE question_id = $1', [q]);
    expect(after.rows).toEqual([{ answer_id: null, changes: 1 }]);
    // Picking again is free and pays; one change is still left.
    await as(asker, qq => qq.query('UPDATE app.selections SET answer_id = $2 WHERE question_id = $1', [q, z]));
    expect(await points(third)).toBe(5);
    await change(asker, q, x);
    await expect(change(asker, q, z)).rejects.toMatchObject({ code: '23514' });
    expect([await points(staying), await points(third)]).toEqual([5, 0]);
  });
});

describe('tricks with the API role’s own privileges', () => {
  it('can’t empty a pick from a trigger of its own on a temporary table', async () => {
    const asker = await member(),
      author = await member();
    const q = await question(asker);
    await select(asker, q, await answer(q, author));
    await expect(
      as(asker, async qq => {
        await qq.query('CREATE TEMP TABLE poke (x int) ON COMMIT DROP');
        await qq.query(`CREATE FUNCTION pg_temp.empty_pick() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN UPDATE app.selections SET answer_id = NULL WHERE question_id = ${q}; RETURN NULL; END $$`);
        await qq.query(
          'CREATE TRIGGER poke_after AFTER INSERT ON poke FOR EACH ROW EXECUTE FUNCTION pg_temp.empty_pick()',
        );
        await qq.query('INSERT INTO poke VALUES (1)');
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('can’t move points at a stricter isolation level, where the cap count would miss others', async () => {
    const asker = await member(),
      author = await member();
    const q = await question(asker);
    const a = await answer(q, author);
    await t.api.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      await t.api.query("SELECT set_config('app.user_id', $1, true)", [asker]);
      await expect(
        t.api.query('INSERT INTO app.selections (question_id, answer_id) VALUES ($1, $2)', [q, a]),
      ).rejects.toMatchObject({ code: '25000' });
    } finally {
      await t.api.query('ROLLBACK');
    }
  });

  it('needs a reason sent with every change; an earlier one isn’t reused', async () => {
    const asker = await member(),
      a1 = await member(),
      a2 = await member(),
      a3 = await member();
    const q = await question(asker);
    const [x, y, z] = [await answer(q, a1), await answer(q, a2), await answer(q, a3)];
    await select(asker, q, x);
    await change(asker, q, y, 'turned_out_wrong');
    // Leaving the reason out of the next change: refused, and no verdict on y.
    await expect(
      as(asker, qq => qq.query('UPDATE app.selections SET answer_id = $2 WHERE question_id = $1', [q, z])),
    ).rejects.toMatchObject({ code: '23514' });
    const { rows } = await t.owner.query(
      'SELECT answer_id::text AS answer_id, correct FROM app.verdicts WHERE answer_id IN ($1, $2) ORDER BY 1',
      [x, y],
    );
    expect(rows).toEqual([{ answer_id: x, correct: false }]);
    const stored = await t.owner.query(
      'SELECT change_reason, last_change_reason FROM app.selections WHERE question_id = $1',
      [q],
    );
    expect(stored.rows).toEqual([{ change_reason: null, last_change_reason: 'turned_out_wrong' }]);
  });

  it('stamps awards with the real time, not when a long transaction began', async () => {
    const asker = await member(),
      author = await member();
    const q = await question(asker);
    const a = await answer(q, author);
    const gap = await as(asker, async qq => {
      await qq.query('SELECT pg_sleep(1.1)');
      await qq.query('INSERT INTO app.selections (question_id, answer_id) VALUES ($1, $2)', [q, a]);
      return must(
        (
          await qq.query<{ gap: number }>(
            "SELECT extract(epoch FROM created_at - now())::float AS gap FROM app.points_ledger WHERE answer_id = $1 AND reason = 'selected'",
            [a],
          )
        ).rows[0],
      ).gap;
    });
    expect(gap).toBeGreaterThan(1);
  });
});

describe('two pick changes at once, in opposite directions', () => {
  it('both go through, without a deadlock', async () => {
    const asker = await member(),
      alice = await member(),
      bob = await member();
    const q1 = await question(asker),
      q2 = await question(asker);
    const [a1, b1] = [await answer(q1, alice), await answer(q1, bob)];
    const [a2, b2] = [await answer(q2, alice), await answer(q2, bob)];
    await select(asker, q1, a1);
    await select(asker, q2, b2);
    for (let round = 0; round < 2; round++) {
      const [from1, to1] = round === 0 ? [a1, b1] : [b1, a1];
      const [from2, to2] = round === 0 ? [b2, a2] : [a2, b2];
      expect(from1 && from2).toBeTruthy();
      await Promise.all([change(asker, q1, to1), change(asker, q2, to2)]);
    }
    expect([await points(alice), await points(bob)]).toEqual([5, 5]);
  });
});

describe('verdicts', () => {
  it('"turned out wrong" marks the old pick wrong, even sent straight to the database', async () => {
    const asker = await member(),
      a1 = await member(),
      a2 = await member();
    const q = await question(asker);
    const [x, y] = [await answer(q, a1), await answer(q, a2)];
    await select(asker, q, x);
    await change(asker, q, y, 'turned_out_wrong');
    const { rows } = await t.owner.query('SELECT correct FROM app.verdicts WHERE answer_id = $1', [x]);
    expect(rows).toEqual([{ correct: false }]);
  });

  it('only the asker rates, only the current pick, and the time is the database’s', async () => {
    const asker = await member(),
      a1 = await member(),
      a2 = await member();
    const q = await question(asker);
    const [x, y] = [await answer(q, a1), await answer(q, a2)];
    const rate = (who: string, answerId: string, correct: boolean) =>
      as(who, qq =>
        qq.query(
          'INSERT INTO app.verdicts (answer_id, correct) VALUES ($1, $2) ON CONFLICT (answer_id) DO UPDATE SET correct = EXCLUDED.correct',
          [answerId, correct],
        ),
      );
    await select(asker, q, x);
    await expect(rate(a1, x, true)).rejects.toMatchObject({ code: '42501' });
    await expect(rate(asker, y, true)).rejects.toMatchObject({ code: '42501' });
    await rate(asker, x, true);
    await expect(
      as(asker, qq => qq.query("INSERT INTO app.verdicts (answer_id, correct, at) VALUES ($1, true, 'infinity')", [y])),
    ).rejects.toMatchObject({ code: '42501' });
    const { rows } = await t.owner.query<{ recent: boolean }>(
      "SELECT at > now() - interval '1 minute' AS recent FROM app.verdicts WHERE answer_id = $1",
      [x],
    );
    expect(rows).toEqual([{ recent: true }]);
  });
});

describe('deleting an account', () => {
  it('keeps the points others earned from the deleted asker, with no link back', async () => {
    const asker = await member(),
      author = await member();
    const q = await question(asker);
    const a = await answer(q, author);
    await select(asker, q, a);
    await markHelpful(asker, a);
    await as(asker, qq => qq.query('DELETE FROM app.profiles WHERE id = $1', [asker]));
    expect(await points(author)).toBe(7);
    const { rows } = await t.owner.query(
      'SELECT giver_id, question_id, answer_id FROM app.points_ledger WHERE recipient_id = $1',
      [author],
    );
    expect(rows).toEqual([
      { giver_id: null, question_id: null, answer_id: null },
      { giver_id: null, question_id: null, answer_id: null },
    ]);
  });
});
