// The daily pass over episodic memory: strong repeated episodes become lasting topic affinities, faded ones are
// forgotten. People who withdrew consent have nothing here: their rows went with the choice (migration 0044).
import type { Database } from '../db.ts';
import { sweepEpisodes } from './memory.ts';

const BATCH = 50_000;

/** A transaction per person: a consent row stays locked only while that one person's memory is being written. */
export async function sweepMemory(db: Pick<Database, 'asSystem'>, now: number): Promise<number> {
  const rows = await db.asSystem(
    async q =>
      (
        await q.query<{ user_id: string; key: string; strength: number; reviews: number; seen_at: Date }>(
          `SELECT user_id, key, strength, reviews, seen_at FROM app.memory_entries
           WHERE tier = 'episodic' ORDER BY seen_at LIMIT $1`,
          [BATCH],
        )
      ).rows,
  );
  const byPerson = new Map<string, typeof rows>();
  for (const r of rows) byPerson.set(r.user_id, [...(byPerson.get(r.user_id) ?? []), r]);
  let changed = 0;
  for (const [person, list] of byPerson) {
    const { keep, consolidate } = sweepEpisodes(
      list.map(r => ({ key: r.key, at: r.seen_at.getTime(), strength: r.strength, reviews: r.reviews })),
      now,
    );
    const kept = new Set(keep.map(e => e.key));
    const forgotten = list.map(r => r.key).filter(k => !kept.has(k));
    changed += await db.asSystem(async q => {
      const allowed = await q.query<{ ok: boolean }>('SELECT app.memory_allowed_locked($1) AS ok', [person]);
      if (!allowed.rows[0]?.ok) return 0;
      let n = 0;
      if (forgotten.length)
        n +=
          (
            await q.query(`DELETE FROM app.memory_entries WHERE user_id = $1 AND tier = 'episodic' AND key = ANY($2)`, [
              person,
              forgotten,
            ])
          ).rowCount ?? 0;
      for (const key of consolidate)
        n +=
          // This runs hourly: a topic counts once a day, or its count would mean nothing.
          (
            await q.query(
              `INSERT INTO app.memory_entries (user_id, tier, key) VALUES ($1, 'semantic', $2)
               ON CONFLICT (user_id, tier, key) DO UPDATE SET reviews = app.memory_entries.reviews + 1, seen_at = now()
               WHERE app.memory_entries.seen_at < now() - interval '20 hours'`,
              [person, key],
            )
          ).rowCount ?? 0;
      return n;
    });
  }
  return changed;
}
