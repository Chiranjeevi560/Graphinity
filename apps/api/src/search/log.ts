// What learning a better search ranking needs (ADR 0015 part 3; migration
// 0022), recorded only while the person has "improve search for everyone"
// (search_improvement) on. The database enforces that too: each insert locks
// the person's consent row and is refused when it is off, and turning it off
// deletes everything recorded under it.
import type { Database } from '../db.ts';
import type { Found } from './engine.ts';

const DAY_MS = 86_400_000;

export interface Shown {
  /** Where it was shown, 1-based. */
  position: number;
  /** Where the ranker put it, before any swap (the same when nothing was swapped). */
  rankedPosition: number;
  /** In an interleaved search, which ranker contributed it. */
  team?: 'a' | 'b';
  found: Found;
}

/**
 * When the person turned "improve search for everyone" on, if it is on: read
 * before searching, and required unchanged when recording, so a search made
 * before turning it off and on again is never recorded under the new "on"
 * ("nothing from before"). Null: off, so nothing will be recorded.
 */
export async function improvementSince(db: Pick<Database, 'withUser'>, userId: string): Promise<string | null> {
  return db.withUser(userId, async q => {
    // As text, to the microsecond: a JavaScript Date would round it and never match.
    const { rows } = await q.query<{ at: string }>(
      `SELECT updated_at::text AS at FROM app.user_consent_settings
       WHERE user_id = $1 AND category = 'search_improvement' AND enabled`,
      [userId],
    );
    return rows[0]?.at ?? null;
  });
}

/**
 * Records a search and the results shown, in one transaction. Returns its
 * public id, or null when nothing is recorded: the choice is off (the usual
 * case), was turned off or changed since the search began, or was turned off a
 * moment ago (the database refuses).
 */
export async function recordSearch(
  db: Pick<Database, 'withUser'>,
  input: {
    userId: string;
    query: string;
    field: string | null;
    meaningModel: string | null;
    shown: readonly Shown[];
    now: Date;
    /** From improvementSince, read before the search began. */
    since: string;
    /** The swapped neighbours' upper position, when this search measures position bias. */
    swap: number | null;
    /** The ranking that ordered the results (rankers.ts), so learning knows what it saw. */
    ranker: string;
    /** control/challenger when the results were interleaved. */
    experiment: string | null;
  },
): Promise<string | null> {
  try {
    return await db.withUser(input.userId, async q => {
      // The consent version written here is replaced by the one the person accepted (trigger).
      const { rows } = await q.query<{ id: string; public_id: string }>(
        `INSERT INTO app.searches (user_id, consent_version, query, field, ranker, meaning_model, swap, experiment)
         SELECT $1, s.policy_version, $2, $3, $4, $5, $7, $8
         FROM app.user_consent_settings s
         WHERE s.user_id = $1 AND s.category = 'search_improvement' AND s.enabled AND s.updated_at = $6::timestamptz
         RETURNING id::text AS id, public_id::text AS public_id`,
        [
          input.userId,
          input.query,
          input.field,
          input.ranker,
          input.meaningModel,
          input.since,
          input.swap,
          input.experiment,
        ],
      );
      const row = rows[0];
      if (!row) return null;
      const id = row.id;
      if (input.shown.length === 0) return row.public_id;
      const f = (s: Shown) => s.found;
      await q.query(
        `INSERT INTO app.search_results
           (search_id, position, ranked_position, team, question_id, word_rank, meaning_rank, similarity, every_word,
            answer_count, answer_age_days)
         SELECT $1, x.position, x.ranked, x.team, x.question_id, x.word_rank, x.meaning_rank, x.similarity,
                x.every_word, x.answer_count, x.age
         FROM unnest($2::smallint[], $10::smallint[], $11::text[], $3::bigint[], $4::smallint[], $5::smallint[],
                     $6::real[], $7::boolean[], $8::int[], $9::real[])
           AS x(position, ranked, team, question_id, word_rank, meaning_rank, similarity, every_word, answer_count, age)`,
        [
          id,
          input.shown.map(s => s.position),
          input.shown.map(s => f(s).id),
          input.shown.map(s => f(s).wordRank),
          input.shown.map(s => f(s).meaningRank),
          input.shown.map(s => f(s).similarity),
          input.shown.map(s => f(s).everyWord),
          input.shown.map(s => f(s).answerCount),
          input.shown.map(s => {
            const at = f(s).lastAnsweredAt;
            return at ? Math.max(0, (input.now.getTime() - at.getTime()) / DAY_MS) : null;
          }),
          input.shown.map(s => s.rankedPosition),
          input.shown.map(s => s.team ?? null),
        ],
      );
      return row.public_id;
    });
  } catch (err) {
    // Turned off between the check and the write: nothing is recorded, as asked.
    if ((err as { code?: string }).code === '42501') return null;
    throw err;
  }
}

/**
 * Records that a result was opened, and, later, how long it was read. Only
 * by the person who searched, only while the choice is on; the longest time
 * reported is kept. Returns false when there is nothing to record against.
 */
export async function recordOpen(
  db: Pick<Database, 'withUser'>,
  /** searchId: the public id given to the client. */
  input: { userId: string; searchId: string; position: number; dwellMs: number | null },
): Promise<boolean> {
  try {
    return await db.withUser(input.userId, async q => {
      const { rowCount } = await q.query(
        `INSERT INTO app.search_opens (search_id, position, dwell_ms)
         SELECT r.search_id, r.position, $3
         FROM app.search_results r JOIN app.searches s ON s.id = r.search_id
         WHERE s.public_id = $1 AND r.position = $2 AND s.user_id = app.current_user_id()
         ON CONFLICT (search_id, position) DO UPDATE
           SET dwell_ms = greatest(app.search_opens.dwell_ms, excluded.dwell_ms)`,
        [input.searchId, input.position, input.dwellMs],
      );
      return (rowCount ?? 0) > 0;
    });
  } catch (err) {
    if ((err as { code?: string }).code === '42501') return false;
    throw err;
  }
}

/** Removes searches past their 365 days. */
export async function purgeExpiredSearches(db: Pick<Database, 'query'>): Promise<number> {
  const { rows } = await db.query<{ removed: string | number }>('SELECT app.purge_expired_searches() AS removed');
  const count = Number(rows[0]?.removed ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid search cleanup count');
  return count;
}
