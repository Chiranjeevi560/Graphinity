// What search records to learn from (ADR 0015 part 3; migration 0022): only
// under "improve search for everyone", only the searcher's own, deleted the
// moment it is turned off, even mid-write, and nothing for visitors.
import { beforeAll, describe, expect, it } from 'vitest';
import type { Embedder } from '../src/embeddings.ts';
import { improvementSince, purgeExpiredSearches, RANKER, recordSearch } from '../src/search/log.ts';
import { startApp, type TestApp } from './helpers/app.ts';
import { must } from './helpers/must.ts';

const meaning: Embedder = {
  model: 'graphinity:test:v1',
  dims: 128,
  embed: texts =>
    Promise.resolve(
      texts.map(t => {
        const v = new Array<number>(128).fill(0);
        v[/duty|tax/i.test(t) ? 0 : 1] = 1;
        return v;
      }),
    ),
};

let h: TestApp;
let names = 0;
let duty = '';

beforeAll(async () => {
  h = await startApp(() => Date.now(), { embedder: meaning });
  const asker = await member();
  const res = await h.call('POST', '/questions', asker.token, {
    title: 'How much customs duty on a camera lens at Chennai?',
    field: 'imports-customs',
  });
  duty = must(res.json<{ question: { id: string } }>().question.id);
  return h.close;
});

async function member(allow?: boolean) {
  const p = await h.person();
  names += 1;
  expect(
    (
      await h.call('POST', '/me/profile', p.token, {
        handle: `log.${String(names)}`,
        country: 'IN',
        fields: ['imports-customs'],
        adult: true,
      })
    ).statusCode,
  ).toBe(201);
  if (allow !== undefined) await choose(p.token, allow);
  return p;
}

async function choose(token: string, enabled: boolean) {
  expect(
    (await h.call('PUT', '/me/consents', token, { choices: [{ category: 'search_improvement', enabled }] })).statusCode,
  ).toBe(200);
}

const search = async (token: string | undefined, query = 'customs duty camera') => {
  const res = await h.call('POST', '/search', token, { query });
  expect(res.statusCode).toBe(200);
  return res.json<{ results: Array<{ id: string }>; searchId?: string }>();
};

/** The internal id behind a public one, as the owner sees it. */
const internal = async (publicId: string) =>
  must(
    (await h.t.owner.query<{ id: string }>('SELECT id::text AS id FROM app.searches WHERE public_id = $1', [publicId]))
      .rows[0],
  ).id;

const recorded = async (userId: string) =>
  (
    await h.t.owner.query<{ searches: number; results: number; opens: number }>(
      `SELECT (SELECT count(*) FROM app.searches WHERE user_id = $1)::int AS searches,
              (SELECT count(*) FROM app.search_results r JOIN app.searches s ON s.id = r.search_id WHERE s.user_id = $1)::int AS results,
              (SELECT count(*) FROM app.search_opens o JOIN app.searches s ON s.id = o.search_id WHERE s.user_id = $1)::int AS opens`,
      [userId],
    )
  ).rows[0];

const open = (token: string, searchId: string, position: number, dwellMs?: number) =>
  h.call('PUT', `/searches/${searchId}/opens/${String(position)}`, token, dwellMs === undefined ? {} : { dwellMs });

/** Resolves once another session is waiting on a lock: the race is really on. */
async function untilSomeoneWaitsOnALock() {
  for (let i = 0; i < 200; i++) {
    const { rows } = await h.t.owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if (must(rows[0]).n > 0) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('no session ever waited on the lock');
}

/** A held transaction: `hold` resolves once its work is done, `release` lets it commit. */
function held() {
  let release!: () => void;
  const released = new Promise<void>(resolve => {
    release = resolve;
  });
  let ready!: () => void;
  const hold = new Promise<void>(resolve => {
    ready = resolve;
  });
  return { release, released, hold, ready };
}

const directInsert = (as: string, forUser: string) =>
  h.t.database.withUser(as, q =>
    q.query(
      `INSERT INTO app.searches (user_id, consent_version, query, ranker) VALUES ($1, 1, 'customs duty', 'test')`,
      [forUser],
    ),
  );

describe('recording searches', () => {
  it('records nothing without the choice, and nothing for visitors', async () => {
    const off = await member(false);
    const undecided = await member();
    expect((await search(off.token)).searchId).toBeUndefined();
    expect((await search(undecided.token)).searchId).toBeUndefined();
    expect((await search(undefined)).searchId).toBeUndefined();
    expect(await recorded(off.id)).toEqual({ searches: 0, results: 0, opens: 0 });
    expect(await recorded(undecided.id)).toEqual({ searches: 0, results: 0, opens: 0 });
    expect((await h.t.owner.query('SELECT count(*)::int AS n FROM app.searches')).rows[0]).toEqual({ n: 0 });
  });

  it('records a search, what was shown with what the ranking knew, and what was opened and read', async () => {
    const p = await member(true);
    const res = await search(p.token);
    const publicId = must(res.searchId);
    // Random, so it says nothing about how many others searched in between.
    expect(publicId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const id = await internal(publicId);
    expect(res.results[0]?.id).toBe(duty);
    const { rows } = await h.t.owner.query(
      `SELECT s.query, s.field, s.ranker, s.meaning_model, s.consent_version,
              r.position, r.question_id::text AS question, r.word_rank, r.meaning_rank, r.every_word, r.answer_count,
              r.answer_age_days, round(r.similarity::numeric, 2)::float8 AS similarity
       FROM app.searches s JOIN app.search_results r ON r.search_id = s.id WHERE s.id = $1 ORDER BY r.position`,
      [id],
    );
    expect(rows[0]).toEqual({
      query: 'customs duty camera',
      field: null,
      ranker: RANKER,
      meaning_model: meaning.model,
      consent_version: 1,
      position: 1,
      question: duty,
      word_rank: 1,
      meaning_rank: 1,
      every_word: true,
      answer_count: 0,
      answer_age_days: null,
      similarity: 1,
    });
    expect((await open(p.token, publicId, 1)).statusCode).toBe(204);
    expect((await open(p.token, publicId, 1, 42_000)).statusCode).toBe(204);
    // A shorter time reported later (a second, briefer visit) keeps the longest.
    expect((await open(p.token, publicId, 1, 3_000)).statusCode).toBe(204);
    expect((await h.t.owner.query('SELECT dwell_ms FROM app.search_opens WHERE search_id = $1', [id])).rows).toEqual([
      { dwell_ms: 42_000 },
    ]);
  });

  it('never records drafts typed while asking', async () => {
    const p = await member(true);
    await h.call('POST', '/questions/precheck', p.token, { title: 'How much customs duty on a camera lens' });
    expect(await recorded(p.id)).toEqual({ searches: 0, results: 0, opens: 0 });
  });

  it('never records a search begun before the choice was turned off and on again', async () => {
    const p = await member(true);
    const since = must(await improvementSince(h.t.database, p.id));
    await choose(p.token, false);
    await choose(p.token, true);
    const stale = await recordSearch(h.t.database, {
      userId: p.id,
      since,
      query: 'customs duty camera',
      field: null,
      meaningModel: null,
      shown: [],
      now: new Date(),
    });
    expect(stale).toBeNull();
    expect(await recorded(p.id)).toEqual({ searches: 0, results: 0, opens: 0 });
  });

  it('accepts opens only from the searcher, only for what was shown', async () => {
    const searcher = await member(true);
    const other = await member(true);
    const id = must((await search(searcher.token)).searchId);
    expect((await open(other.token, id, 1)).statusCode).toBe(404);
    expect((await open(searcher.token, id, 20)).statusCode).toBe(404);
    expect((await open(searcher.token, '00000000-0000-4000-8000-000000000000', 1)).statusCode).toBe(404);
    expect((await h.call('PUT', `/searches/${id}/opens/1`, undefined, {})).statusCode).toBe(401);
    expect((await h.call('PUT', `/searches/${id}/opens/21`, searcher.token, {})).statusCode).toBe(400);
    expect((await h.call('PUT', '/searches/12/opens/1', searcher.token, {})).statusCode).toBe(400);
    expect((await h.call('PUT', `/searches/${id}/opens/1`, searcher.token, { dwellMs: -1 })).statusCode).toBe(400);
    expect((await h.call('PUT', `/searches/${id}/opens/1`, searcher.token, { extra: 1 })).statusCode).toBe(400);
    expect(await recorded(other.id)).toEqual({ searches: 0, results: 0, opens: 0 });
    expect((await recorded(searcher.id))?.opens).toBe(0);
  });

  it('takes its dates and consent version from the database, whatever the writer sends', async () => {
    const p = await member(true);
    const id = await internal(must((await search(p.token)).searchId));
    const { rows } = await h.t.owner.query<{ fresh: boolean; year: boolean; version: number }>(
      `SELECT created_at BETWEEN now() - interval '1 minute' AND now() + interval '1 minute' AS fresh,
              expires_at = created_at + interval '365 days' AS year, consent_version AS version
       FROM app.searches WHERE id = $1`,
      [id],
    );
    expect(rows).toEqual([{ fresh: true, year: true, version: 1 }]);
    // The API role can't set them at all.
    for (const column of ['created_at', 'expires_at', 'public_id'])
      await expect(
        h.t.database.withUser(p.id, q =>
          q.query(
            `INSERT INTO app.searches (user_id, consent_version, query, ranker, ${column})
             VALUES ($1, 1, 'customs', 'test', ${column === 'public_id' ? 'gen_random_uuid()' : "'2100-01-01'"})`,
            [p.id],
          ),
        ),
        column,
      ).rejects.toMatchObject({ code: '42501' });
    // The trigger sets them even for a writer who could (the owner, past every grant).
    await h.t.owner.query(
      `INSERT INTO app.searches (user_id, consent_version, query, ranker, created_at, expires_at)
       VALUES ($1, 1, 'customs', 'owner', '2100-01-01', '2100-06-01')`,
      [p.id],
    );
    expect(
      (
        await h.t.owner.query(
          "SELECT created_at BETWEEN now() - interval '1 minute' AND now() + interval '1 minute' AS fresh FROM app.searches WHERE user_id = $1 AND ranker = 'owner'",
          [p.id],
        )
      ).rows,
    ).toEqual([{ fresh: true }]);
    // A version the person never accepted is replaced by the one they did.
    await h.t.database.withUser(p.id, q =>
      q.query(`INSERT INTO app.searches (user_id, consent_version, query, ranker) VALUES ($1, 99, 'customs', 'test')`, [
        p.id,
      ]),
    );
    expect(
      (await h.t.owner.query("SELECT consent_version FROM app.searches WHERE user_id = $1 AND ranker = 'test'", [p.id]))
        .rows,
    ).toEqual([{ consent_version: 1 }]);
  });
});

describe('turning it off', () => {
  it('deletes everything recorded under it at once, and records nothing after', async () => {
    const p = await member(true);
    const id = must((await search(p.token)).searchId);
    await open(p.token, id, 1, 5_000);
    expect(await recorded(p.id)).toEqual({ searches: 1, results: 1, opens: 1 });
    await choose(p.token, false);
    expect(await recorded(p.id)).toEqual({ searches: 0, results: 0, opens: 0 });
    expect((await search(p.token)).searchId).toBeUndefined();
    expect((await open(p.token, id, 1)).statusCode).toBe(404);
    // Turned back on: only what comes after, never what came before.
    await choose(p.token, true);
    expect(await recorded(p.id)).toEqual({ searches: 0, results: 0, opens: 0 });
  });

  it('deletes them however the consent row stops saying yes, and no request can move one', async () => {
    const p = await member(true);
    must((await search(p.token)).searchId);
    // No request may move a consent row to another purpose or person.
    await expect(
      h.t.database.withUser(p.id, q =>
        q.query(
          "UPDATE app.user_consent_settings SET category = 'search_history' WHERE user_id = $1 AND category = 'search_improvement'",
          [p.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // The owner deleting the row deletes the searches too.
    await h.t.owner.query(
      "DELETE FROM app.user_consent_settings WHERE user_id = $1 AND category = 'search_improvement'",
      [p.id],
    );
    expect(await recorded(p.id)).toEqual({ searches: 0, results: 0, opens: 0 });
  });

  it('leaves nothing behind when it is turned off during a write', async () => {
    const p = await member(true);
    const w = held();
    // The write locks the consent row, then holds before committing.
    const write = h.t.database.withUser(p.id, async q => {
      await q.query(
        `INSERT INTO app.searches (user_id, consent_version, query, ranker) VALUES ($1, 1, 'customs duty', 'test')`,
        [p.id],
      );
      w.ready();
      await w.released;
    });
    await w.hold;
    const revoke = h.t.database.withUser(p.id, q =>
      q.query(
        "UPDATE app.user_consent_settings SET enabled = false WHERE user_id = $1 AND category = 'search_improvement'",
        [p.id],
      ),
    );
    // Only once the revoke is waiting on the write's lock does the write commit.
    await untilSomeoneWaitsOnALock();
    w.release();
    await Promise.all([write, revoke]);
    expect(await recorded(p.id)).toEqual({ searches: 0, results: 0, opens: 0 });
  });

  it('refuses a write that arrives while it is being turned off', async () => {
    const p = await member(true);
    const r = held();
    const revoke = h.t.database.withUser(p.id, async q => {
      await q.query(
        "UPDATE app.user_consent_settings SET enabled = false WHERE user_id = $1 AND category = 'search_improvement'",
        [p.id],
      );
      r.ready();
      await r.released;
    });
    await r.hold;
    const write = directInsert(p.id, p.id);
    // The write's policy check still sees the choice on; its lock waits for the revoke, then sees it off.
    await untilSomeoneWaitsOnALock();
    r.release();
    await revoke;
    await expect(write).rejects.toMatchObject({ code: '42501' });
    expect(await recorded(p.id)).toEqual({ searches: 0, results: 0, opens: 0 });
  });
});

describe('what is recorded, protected', () => {
  it('can’t be written, read, changed or removed for someone else, even directly', async () => {
    const on = await member(true);
    const off = await member(false);
    const other = await member(true);
    await expect(directInsert(on.id, off.id)).rejects.toMatchObject({ code: '42501' });
    await expect(directInsert(off.id, off.id)).rejects.toMatchObject({ code: '42501' });
    const publicId = must((await search(on.token)).searchId);
    const id = await internal(publicId);
    await open(on.token, publicId, 1, 1_000);
    const as = (userId: string, sql: string, params: unknown[]) =>
      h.t.database.withUser(userId, q => q.query(sql, params));
    await expect(
      as(
        other.id,
        'INSERT INTO app.search_results (search_id, position, question_id, every_word, answer_count) VALUES ($1, 2, $2, false, 0)',
        [id, duty],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      as(other.id, 'INSERT INTO app.search_opens (search_id, position) VALUES ($1, 1)', [id]),
    ).rejects.toMatchObject({ code: '42501' });
    for (const table of ['searches', 'search_results', 'search_opens']) {
      const key = table === 'searches' ? 'id' : 'search_id';
      expect((await as(other.id, `SELECT * FROM app.${table} WHERE ${key} = $1`, [id])).rows, table).toEqual([]);
      expect((await as(other.id, `DELETE FROM app.${table} WHERE ${key} = $1`, [id])).rowCount, table).toBe(0);
    }
    expect((await as(other.id, 'UPDATE app.search_opens SET dwell_ms = 1 WHERE search_id = $1', [id])).rowCount).toBe(
      0,
    );
    expect(await recorded(on.id)).toEqual({ searches: 1, results: 1, opens: 1 });
  });

  it('refuses by its policies alone, with the consent trigger switched off', async () => {
    // Each database rule is tested on its own: the trigger (above, mid-write) and these policies.
    const on = await member(true);
    const alsoOn = await member(true);
    const off = await member(false);
    const id = await internal(must((await search(on.token)).searchId));
    await h.t.owner.query('ALTER TABLE app.searches DISABLE TRIGGER searches_require_consent');
    await h.t.owner.query('ALTER TABLE app.search_opens DISABLE TRIGGER search_opens_require_consent');
    try {
      await expect(directInsert(off.id, off.id)).rejects.toMatchObject({ code: '42501' });
      await expect(directInsert(on.id, alsoOn.id)).rejects.toMatchObject({ code: '42501' });
      await expect(
        h.t.database.withUser(alsoOn.id, q =>
          q.query('INSERT INTO app.search_opens (search_id, position) VALUES ($1, 1)', [id]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await h.t.owner.query('ALTER TABLE app.searches ENABLE TRIGGER searches_require_consent');
      await h.t.owner.query('ALTER TABLE app.search_opens ENABLE TRIGGER search_opens_require_consent');
    }
    expect(await recorded(alsoOn.id)).toEqual({ searches: 0, results: 0, opens: 0 });
  });

  it('is in the person’s export, expires after 365 days, and goes with the account', async () => {
    const p = await member(true);
    const publicId = must((await search(p.token)).searchId);
    await open(p.token, publicId, 1, 7_000);
    const exported = (await h.call('GET', '/me/data-export', p.token)).json<{
      searchImprovement: { searches: Array<{ id: string; query: string; shown: Array<{ dwellMs: number | null }> }> };
    }>();
    expect(exported.searchImprovement.searches).toHaveLength(1);
    expect(exported.searchImprovement.searches[0]).toMatchObject({
      id: publicId,
      query: 'customs duty camera',
      shown: [{ position: 1, questionId: duty, dwellMs: 7_000 }],
    });
    // Kept no longer than 365 days, by the database too.
    await expect(
      h.t.owner.query("UPDATE app.searches SET expires_at = created_at + interval '400 days' WHERE public_id = $1", [
        publicId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    // A year on, the hourly job removes it.
    await h.t.owner.query(
      "UPDATE app.searches SET created_at = now() - interval '366 days', expires_at = now() - interval '1 day' WHERE public_id = $1",
      [publicId],
    );
    expect(await purgeExpiredSearches(h.t.database)).toBe(1);
    expect(await recorded(p.id)).toEqual({ searches: 0, results: 0, opens: 0 });
    // Deleting the account deletes the searches.
    must((await search(p.token)).searchId);
    await h.t.owner.query('DELETE FROM app.profiles WHERE id = $1', [p.id]);
    expect(await recorded(p.id)).toEqual({ searches: 0, results: 0, opens: 0 });
  });
});
