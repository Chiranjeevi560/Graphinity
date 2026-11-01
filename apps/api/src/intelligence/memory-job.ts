// The daily pass over episodic memory: strong repeated episodes become lasting topic affinities, faded ones are
// forgotten. People who withdrew consent have nothing here: their rows went with the choice (migration 0044).
import type { Database } from '../db.ts';
import { sweepEpisodes } from './memory.ts';

const BATCH = 50_000;

export async function sweepMemory(db: Pick<Database, 'asSystem'>, now: number): Promise<number> {
  return db.asSystem(async q => {
    const { rows } = await q.query<{ user_id: string; key: string; strength: number; reviews: number; seen_at: Date }>(
      `SELECT user_id, key, strength, reviews, seen_at FROM app.memory_entries
       WHERE tier = 'episodic' ORDER BY seen_at LIMIT $1`,
      [BATCH],
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
      if (forgotten.length)
        changed +=
          (
            await q.query(`DELETE FROM app.memory_entries WHERE user_id = $1 AND tier = 'episodic' AND key = ANY($2)`, [
              person,
              forgotten,
            ])
          ).rowCount ?? 0;
      for (const key of consolidate) {
        changed += 1;
        await q.query(
          `INSERT INTO app.memory_entries (user_id, tier, key) VALUES ($1, 'semantic', $2)
           ON CONFLICT (user_id, tier, key) DO UPDATE SET reviews = app.memory_entries.reviews + 1, seen_at = now()`,
          [person, key],
        );
      }
    }
    return changed;
  });
}
