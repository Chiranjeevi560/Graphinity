// Seeds a scratch database for search benchmarks and load tests: synthetic
// questions (synthetic-questions.mjs), Graphinity's own text model trained as
// the daily job trains it, vectors and indexes as production builds them.
// Held-out questions (one in five) are stored by title only: their details
// are the queries, and their title the one right answer.
import { readFileSync } from 'node:fs';
import { vectorLiteral } from '../../apps/api/src/embeddings.ts';
import { isHeldOut } from '../../apps/api/src/ml/embedding-gate.ts';
import { ownEmbedderFromArtifact } from '../../apps/api/src/ml/own-embedder.ts';
import { serializeModel, trainTextEmbedding } from '../../apps/api/src/ml/text-embedding.ts';
import { createTestDatabase } from '../../apps/api/test/helpers/database.ts';
import { corpus } from './synthetic-questions.mjs';

process.env.TEST_DATABASE_ADMIN_URL ??= readFileSync(new URL('../../.local/test.env', import.meta.url), 'utf8')
  .split('\n')
  .find(l => l.startsWith('TEST_DATABASE_ADMIN_URL='))
  ?.slice('TEST_DATABASE_ADMIN_URL='.length);

export async function seedSearchDatabase(size) {
  const questions = corpus(size);
  const heldOut = questions.filter(q => isHeldOut(q.id));
  let t = performance.now();
  const model = trainTextEmbedding(questions.filter(q => !isHeldOut(q.id)).map(q => `${q.title}\n${q.body}`));
  const trainMs = Math.round(performance.now() - t);
  const embedder = ownEmbedderFromArtifact(serializeModel(model), 1);

  const db = await createTestDatabase();
  // Seeded directly, with triggers off for the bulk load only (new-account limits
  // would refuse 100k questions from one person); reads below run as the API does.
  const asker = '00000000-0000-4000-8000-000000000001';
  await db.owner.query("SET session_replication_role = 'replica'");
  await db.owner.query(
    "INSERT INTO app.profiles (id, handle, country, adult_confirmed_at, created_at) VALUES ($1, 'bench.asker', 'IN', now(), '2020-01-01')",
    [asker],
  );
  // Built once after the load, with the migration's parameters (0021): far
  // faster than maintaining it through 100,000 inserts, and the same index at the end.
  await db.owner.query('DROP INDEX app.question_embeddings_128');
  t = performance.now();
  const idOf = new Map();
  for (let start = 0; start < questions.length; start += 1000) {
    const batch = questions.slice(start, start + 1000);
    // Held-out questions by title only: their details are the queries.
    const bodies = batch.map(q => (isHeldOut(q.id) ? '' : q.body));
    const vectors = await embedder.embed(batch.map((q, i) => (bodies[i] ? `${q.title}\n${bodies[i]}` : q.title)));
    const { rows } = await db.owner.query(
      `WITH qs AS (
         INSERT INTO app.questions (asker_id, field, title, body)
         SELECT $1, 'imports-customs', t, b FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS x(t, b, n)
         ORDER BY n RETURNING id, title
       ), numbered AS (SELECT id, title, row_number() OVER (ORDER BY id) AS n FROM qs),
       stored AS (
         INSERT INTO app.question_embeddings (question_id, model, embedding)
         SELECT numbered.id, $5, v.v::extensions.halfvec
         FROM numbered JOIN unnest($4::text[]) WITH ORDINALITY AS v(v, n) ON v.n = numbered.n
       )
       SELECT id::text AS id, title FROM numbered`,
      [asker, batch.map(q => q.title), bodies, vectors.map(vectorLiteral), embedder.model],
    );
    for (const r of rows) idOf.set(r.title, r.id);
  }
  await db.owner.query("SET session_replication_role = 'origin'");
  await db.owner.query("SET maintenance_work_mem = '512MB'");
  await db.owner.query(
    `CREATE INDEX question_embeddings_128 ON app.question_embeddings
     USING hnsw ((embedding::extensions.halfvec(128)) extensions.halfvec_cosine_ops) WITH (m = 24, ef_construction = 200)
     WHERE extensions.vector_dims(embedding) = 128`,
  );
  // The bulk load skipped the triggers that keep word counts: recount, as the runbook says.
  await db.owner.query('SELECT app.rebuild_search_stats()');
  await db.owner.query('ANALYZE app.questions');
  await db.owner.query('ANALYZE app.question_embeddings');
  const loadMs = Math.round(performance.now() - t);
  return { db, embedder, questions, heldOut, idOf, trainMs, loadMs };
}
