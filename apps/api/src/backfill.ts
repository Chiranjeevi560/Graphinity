// Fills in embeddings a question is missing: it was asked while Cloudflare
// was out of its free allowance or unreachable, or before embeddings
// existed, or with a different model. A few at a time, so a backlog never
// spends the day's allowance in one go.
import type { Database } from './db.ts';
import { vectorLiteral, type Embedder } from './embeddings.ts';
import { questionText } from './routes/questions.ts';

/** Questions embedded per run (one run a minute with routing). */
export const BACKFILL_BATCH = 20;

/** Returns how many questions got their embedding. Throws only if the database does. */
export async function embedMissing(db: Database, embedder: Embedder): Promise<number> {
  const todo = await db.asSystem(
    async q =>
      (
        await q.query<{ id: string; title: string; body: string }>(
          `SELECT q.id::text AS id, q.title, q.body FROM app.questions q
     JOIN app.user_consent_settings s ON s.user_id = q.asker_id
       AND s.category = 'ai_personalization' AND s.enabled
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
    // Out of today's allowance or offline: try again next run.
    return 0;
  }
  await db.asSystem(async q => {
    for (const [i, t] of todo.entries()) {
      const v = vectors[i];
      if (v)
        await q.query(
          `UPDATE app.questions SET embedding = $2, embedding_model = $3 WHERE id = $1
           AND EXISTS (SELECT 1 FROM app.user_consent_settings s
                       WHERE s.user_id = app.questions.asker_id
                         AND s.category = 'ai_personalization' AND s.enabled)`,
          [t.id, vectorLiteral(v), embedder.model],
        );
    }
  });
  return todo.length;
}
