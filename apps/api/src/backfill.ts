// Fills in embeddings a question is missing: asked before a model served, or
// embedded by an older model (after a new one is promoted, ADR 0010). Every
// visible question is embedded, on Graphinity's own server (migration 0019),
// into app.question_embeddings at the model's own size (migration 0021).
// Bounded per run so a re-embedding after a model change spreads over minutes
// instead of one long transaction.
import type { Database } from './db.ts';
import { vectorLiteral, type Embedder } from './embeddings.ts';
import { questionText } from './routes/questions.ts';

/**
 * Questions embedded per run (one run a minute with routing). The own model
 * embeds a text in microseconds; the cost is one insert of 500 rows, a
 * fraction of a second. 50,000 questions re-embed in under two hours.
 */
export const BACKFILL_BATCH = 500;
/** Vectors from other models removed per run: search reads only the serving model's. */
export const PRUNE_BATCH = 5000;

/** Returns how many questions got their embedding. Throws only if the database does. */
export async function embedMissing(db: Database, embedder: Embedder): Promise<number> {
  const model = embedder.model;
  const todo = await db.asSystem(
    async q =>
      (
        await q.query<{ id: string; title: string; body: string }>(
          `SELECT q.id::text AS id, q.title, q.body FROM app.questions q
           WHERE NOT EXISTS (SELECT 1 FROM app.question_embeddings e WHERE e.question_id = q.id AND e.model = $1)
           ORDER BY q.id DESC LIMIT ${String(BACKFILL_BATCH)}`,
          [model],
        )
      ).rows,
  );
  if (todo.length === 0) {
    await pruneOtherModels(db, model);
    return 0;
  }
  let vectors: number[][];
  try {
    vectors = await embedder.embed(todo.map(t => questionText(t.title, t.body)));
  } catch {
    // The embedder failed (no model serving yet): try again next run.
    return 0;
  }
  const rows = todo.flatMap((t, i) => {
    const v = vectors[i];
    return v ? [{ id: t.id, v: vectorLiteral(v) }] : [];
  });
  return db.asSystem(async q => {
    const { rows: stored } = await q.query<{ n: number }>(
      'SELECT app.store_question_embeddings($1::bigint[], $2, $3::text[]) AS n',
      [rows.map(r => r.id), model, rows.map(r => r.v)],
    );
    return stored[0]?.n ?? 0;
  });
}

/** Once every question has the serving model's vector, older models' vectors go, a batch at a time. */
async function pruneOtherModels(db: Database, model: string): Promise<void> {
  await db.asSystem(async q => {
    await q.query(
      `DELETE FROM app.question_embeddings e
       WHERE (e.question_id, e.model) IN (
         SELECT question_id, model FROM app.question_embeddings WHERE model <> $1 LIMIT ${String(PRUNE_BATCH)})`,
      [model],
    );
  });
}
