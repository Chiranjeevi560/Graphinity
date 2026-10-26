// What a learned search ranking learns from (ADR 0015 part 6): the searches
// recorded under "improve search for everyone" (migration 0022), each with the
// results shown, what the ranking knew about each at that moment, where each
// was shown and ranked, and what was opened and read. Read in a system
// transaction: only the training job reads everyone's.
import { createHash } from 'node:crypto';
import type { Database } from '../db.ts';
import { underCollusionReview } from '../collusion.ts';
import { rankingFeatures } from './features.ts';

/** A read this long marks a clearly useful result (label 2); any other open, label 1. */
export const LONG_READ_MS = 30_000;
/** At most this many of the newest searches are read: bounds a run's memory. */
export const MAX_SEARCHES = 100_000;

export interface TrainingSearch {
  /** Who searched, hashed: for splitting by person and resampling people, never to identify them. */
  user: string;
  swap: number | null;
  results: Array<{ features: number[]; position: number; ranked: number; label: number }>;
}

export interface SearchTrainingData {
  searches: TrainingSearch[];
  fingerprint: string;
}

export const labelOf = (opened: boolean, dwellMs: number | null) =>
  !opened ? 0 : (dwellMs ?? 0) >= LONG_READ_MS ? 2 : 1;

export async function loadSearchTraining(db: Pick<Database, 'asSystem'>): Promise<SearchTrainingData> {
  return db.asSystem(async q => {
    const { rows } = await q.query<{
      id: string;
      user_id: string;
      swap: number | null;
      position: number;
      ranked_position: number | null;
      word_rank: number | null;
      meaning_rank: number | null;
      similarity: number | null;
      every_word: boolean;
      answer_count: number;
      answer_age_days: number | null;
      opened: boolean;
      dwell_ms: number | null;
    }>(
      `WITH recent AS (
         SELECT id, user_id, swap FROM app.searches
         WHERE experiment IS NULL AND NOT ${underCollusionReview('user_id')}
         ORDER BY id DESC LIMIT ${String(MAX_SEARCHES)}
       )
       SELECT s.id::text AS id, s.user_id::text AS user_id, s.swap, r.position, r.ranked_position, r.word_rank,
              r.meaning_rank, r.similarity, r.every_word, r.answer_count, r.answer_age_days,
              o.search_id IS NOT NULL AS opened, o.dwell_ms
       FROM recent s
       JOIN app.search_results r ON r.search_id = s.id
       LEFT JOIN app.search_opens o ON o.search_id = r.search_id AND o.position = r.position
       ORDER BY s.id, r.position`,
    );
    const bySearch = new Map<string, TrainingSearch>();
    const hash = createHash('sha256');
    for (const row of rows) {
      let s = bySearch.get(row.id);
      if (!s) {
        s = { user: createHash('sha256').update(row.user_id).digest('hex').slice(0, 16), swap: row.swap, results: [] };
        bySearch.set(row.id, s);
        hash.update(`${row.id};`);
      }
      s.results.push({
        features: rankingFeatures({
          wordRank: row.word_rank,
          meaningRank: row.meaning_rank,
          similarity: row.similarity,
          everyWord: row.every_word,
          answerCount: row.answer_count,
          answerAgeDays: row.answer_age_days,
        }),
        position: row.position,
        ranked: row.ranked_position ?? row.position,
        label: labelOf(row.opened, row.dwell_ms),
      });
      if (row.opened) hash.update(`${row.id}:${String(row.position)}:${String(row.dwell_ms ?? '')};`);
    }
    return { searches: [...bySearch.values()], fingerprint: hash.digest('hex') };
  });
}
