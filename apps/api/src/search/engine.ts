// One retrieval engine for both places people search (ADR 0015, owner
// decision 1): the Ask screen's "has this been asked?" check and the Search
// screen. Two rankings, by words (Postgres full text, with Graphinity's own
// spelling corrections) and by meaning (Graphinity's own embedding), fused by
// reciprocal rank (spec §12.1). Each stage is timed, so a slow one shows in
// the response's Server-Timing header instead of being guessed at.
import type { Database, Queryable } from '../db.ts';
import { vectorLiteral, type Embedder } from '../embeddings.ts';
import type { Speller } from '../ml/spelling.ts';
import { fuse } from '../precheck.ts';
import { prefixQuery } from '../text.ts';
import { tokenize } from '../ml/text-embedding.ts';

export interface Found {
  id: string;
  title: string;
  field: string;
  answerCount: number;
  lastAnsweredAt: Date | null;
  /** Cosine similarity by meaning; null when this one wasn't found by meaning. */
  similarity: number | null;
  /** Its place in the word ranking (1 is first), or null. */
  wordRank: number | null;
  /** Its place in the meaning ranking, or null. */
  meaningRank: number | null;
  /** It holds every word typed (as typed, or as corrected). */
  everyWord: boolean;
}

export interface Timings {
  embed: number;
  words: number;
  meaning: number;
  fetch: number;
}

export interface Retrieval {
  /** Best first, by fused rank. Only what the reader may see (row-level security). */
  found: Found[];
  /** Words the spelling model also searched for, in the order typed. */
  corrections: Array<{ from: string; to: string }>;
  /** Whether meaning took part: false when no model serves, it failed, or it is switched off. */
  meaningUsed: boolean;
  /** The model that gave meaning, when it took part. */
  meaningModel: string | null;
  timings: Timings;
}

export interface SearchEngine {
  /** `text` is searched by words; `meaningText` (default `text`) is what meaning is computed from. */
  retrieve(input: {
    text: string;
    meaningText?: string;
    field: string | null;
    pool: number;
    /** Still being typed (the Ask check): the last word may be unfinished. */
    typing?: boolean;
  }): Promise<Retrieval>;
}

const since = (start: number) => Math.round((performance.now() - start) * 10) / 10;

export function createSearchEngine({
  db,
  embedder,
  speller,
}: {
  db: Pick<Database, 'withUser'>;
  embedder: Embedder | null;
  speller: Pick<Speller, 'correctDraft'> | null;
}): SearchEngine {
  /** An embedding, or null when there's no embedder or it failed: words still work. */
  async function embed(text: string): Promise<number[] | null> {
    if (!embedder) return null;
    try {
      return (await embedder.embed([text]))[0] ?? null;
    } catch {
      return null;
    }
  }

  /**
   * BM25 by words (app.word_search, migration 0020), with the spelling
   * model's corrections also searched. While someone types, the last word may
   * be unfinished: it also matches the words it could become.
   */
  async function byWords(
    q: Queryable,
    text: string,
    also: readonly string[],
    typing: boolean,
    field: string | null,
    pool: number,
  ) {
    const words = tokenize(text);
    const prefix = typing && /[\p{L}\p{M}\p{N}]$/u.test(text) ? (words.at(-1) ?? null) : null;
    return (
      await q.query<{ id: string }>('SELECT id::text AS id FROM app.word_search($1, $2, $3, $4, $5)', [
        text,
        also,
        prefix,
        field,
        pool,
      ])
    ).rows;
  }

  /** The tsquery for "holds every word": as typed, and as corrected. */
  function everyWordQueries(
    text: string,
    corrections: Retrieval['corrections'],
    typing: boolean,
  ): [string | null, string | null] {
    // The same rule as the ranking: only a word still being typed matches as a beginning.
    const prefix = typing ? 'last' : 'none';
    const fixed = new Map(corrections.map(c => [c.from, c.to]));
    const corrected = tokenize(text)
      .map(w => fixed.get(w) ?? w)
      .join(' ');
    return [
      prefixQuery(text, 'all', [], prefix),
      // A corrected word is complete by definition: the speller skips the one being typed.
      corrections.length
        ? prefixQuery(/[\p{L}\p{M}\p{N}]$/u.test(text) ? corrected : `${corrected} `, 'all', [], prefix)
        : null,
    ];
  }

  return {
    async retrieve({ text, meaningText = text, field, pool, typing = false }) {
      const timings: Timings = { embed: 0, words: 0, meaning: 0, fetch: 0 };
      let start = performance.now();
      // Outside the transaction: a database connection is never held while the model runs.
      const vector = await embed(meaningText);
      timings.embed = since(start);
      const corrections = speller?.correctDraft(text) ?? [];
      const found = await db.withUser(null, async q => {
        start = performance.now();
        const meaning =
          vector && embedder
            ? (
                await q.query<{ id: string; similarity: number }>(
                  'SELECT id::text AS id, similarity FROM app.nearest_questions($1, $2, $3, $4)',
                  [vectorLiteral(vector), embedder.model, field, pool],
                )
              ).rows
            : [];
        timings.meaning = since(start);
        start = performance.now();
        const words = await byWords(
          q,
          text,
          corrections.map(c => c.to),
          typing,
          field,
          pool,
        );
        timings.words = since(start);
        const ids = fuse(
          meaning.map(r => r.id),
          words.map(r => r.id),
        );
        start = performance.now();
        const [every, everyCorrected] = everyWordQueries(text, corrections, typing);
        // Row-level security leaves out anything the reader may not see.
        const details = ids.length
          ? (
              await q.query<{
                id: string;
                title: string;
                field: string;
                answer_count: number;
                last_answered_at: Date | null;
                every_word: boolean;
              }>(
                `SELECT q.id::text AS id, q.title, q.field,
                        (SELECT count(*) FROM app.answers a WHERE a.question_id = q.id)::int AS answer_count,
                        (SELECT max(a.created_at) FROM app.answers a WHERE a.question_id = q.id) AS last_answered_at,
                        coalesce(q.search @@ to_tsquery('english', $2::text), false)
                          OR coalesce(q.search @@ to_tsquery('english', $3::text), false) AS every_word
                 FROM app.questions q WHERE q.id = ANY($1::bigint[])`,
                [ids, every, everyCorrected],
              )
            ).rows
          : [];
        timings.fetch = since(start);
        const meaningAt = new Map(meaning.map((r, i) => [r.id, { rank: i + 1, similarity: r.similarity }]));
        const wordAt = new Map(words.map((r, i) => [r.id, i + 1]));
        const byId = new Map(details.map(d => [d.id, d]));
        return ids.flatMap((id): Found[] => {
          const d = byId.get(id);
          if (!d) return [];
          const m = meaningAt.get(id);
          const w = wordAt.get(id);
          return [
            {
              id,
              title: d.title,
              field: d.field,
              answerCount: d.answer_count,
              lastAnsweredAt: d.last_answered_at,
              similarity: m?.similarity ?? null,
              wordRank: w ?? null,
              meaningRank: m?.rank ?? null,
              everyWord: d.every_word,
            },
          ];
        });
      });
      return {
        found,
        corrections,
        meaningUsed: vector !== null,
        meaningModel: vector !== null && embedder ? embedder.model : null,
        timings,
      };
    },
  };
}

/** Server-Timing (W3C): stage durations only, never anything about the query or the person. */
export function serverTiming(t: Timings): string {
  return Object.entries(t)
    .map(([name, ms]) => `${name};dur=${String(ms)}`)
    .join(', ');
}
