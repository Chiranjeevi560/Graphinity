// Fills in embeddings a question is missing: asked before a model served, or
// embedded by an older model (after a new one is promoted, ADR 0010). Every
// visible question is embedded, on Graphinity's own server (migration 0019).
// Bounded per run so a re-embedding after a model change spreads over minutes
// instead of one long transaction.
import type { Database } from './db.ts';
import { vectorLiteral, type Embedder } from './embeddings.ts';
import { questionText } from './routes/questions.ts';

/**
 * Questions embedded per run (one run a minute with routing). The own model
 * embeds a text in microseconds; the cost is the 500 row updates, a fraction
 * of a second. 50,000 questions re-embed in under two hours.
 */
export const BACKFILL_BATCH = 500;

/** Returns how many questions got their embedding. Throws only if the database does. */
export async function embedMissing(db: Database, embedder: Embedder): Promise<number> {
  const todo = await db.asSystem(
    async q =>
      (
        await q.query<{ id: string; title: string; body: string }>(
          `SELECT q.id::text AS id, q.title, q.body FROM app.questions q
     WHERE q.embedding IS NULL OR q.embedding_model IS DISTINCT FROM $1
     ORDER BY q.id DESC LIMIT ${String(BACKFILL_BATCH)}`,
          [embedder.model],
        )
      ).rows,
  );
  if (todo.length === 0) return 0;
  let vectors: number[][];
  try {
    vectors = await embedder.embed(todo.map(t => questionText(t.title, t.body)));
  } catch {
    // The embedder failed (no model serving yet): try again next run.
    return 0;
  }
  await db.asSystem(async q => {
    for (const [i, t] of todo.entries()) {
      const v = vectors[i];
      if (v)
        await q.query('UPDATE app.questions SET embedding = $2, embedding_model = $3 WHERE id = $1', [
          t.id,
          vectorLiteral(v),
          embedder.model,
        ]);
    }
  });
  return todo.length;
}
