// Graphinity's own model pipeline against a real database: what it may learn
// from, the registry's guarantees, and a real training run on a worker thread.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCorpus } from '../src/ml/corpus.ts';
import { ownEmbedderFromArtifact } from '../src/ml/own-embedder.ts';
import { loadServing } from '../src/ml/registry.ts';
import { deserializeModel, serializeModel, trainTextEmbedding } from '../src/ml/text-embedding.ts';
import type { TrainingResult, WorkerInput } from '../src/ml/train-embedding.ts';
import { deserializeSpelling, serializeSpelling, speller, trainSpelling } from '../src/ml/spelling.ts';
import type { SpellingResult } from '../src/ml/train-spelling.ts';
import {
  runOnWorker,
  runSpellingOnWorker,
  SPELLING,
  TEXT_EMBEDDING,
  trainSpellingJob,
  trainTextEmbeddingJob,
} from '../src/ml/training.ts';
import { createTestDatabase, type TestDatabase } from './helpers/database.ts';

let t: TestDatabase;
let consenting: string;
let declining: string;
let names = 0;

async function person(consents: boolean): Promise<string> {
  const id = randomUUID();
  names += 1;
  // A profile needs its topics in the same transaction (the database checks at commit).
  await t.owner.query('BEGIN');
  await t.owner.query(
    `INSERT INTO app.profiles (id, handle, country, adult_confirmed_at, created_at)
     VALUES ($1, $2, 'IN', now() - interval '60 days', now() - interval '60 days')`,
    [id, `ml.person${String(names)}`],
  );
  await t.owner.query(`INSERT INTO app.profile_fields (profile_id, field) VALUES ($1, 'imports-customs')`, [id]);
  await t.owner.query('COMMIT');
  // The database stamps created_at itself; age the account past the new-account limits.
  await t.owner.query("UPDATE app.profiles SET created_at = now() - interval '60 days' WHERE id = $1", [id]);
  await t.owner.query(
    `INSERT INTO app.user_consent_settings (user_id, category, enabled, policy_version) VALUES ($1, 'model_training', $2, 1)`,
    [id, consents],
  );
  return id;
}

async function ask(asker: string, title: string, body: string): Promise<string> {
  const { rows } = await t.owner.query<{ id: string }>(
    `INSERT INTO app.questions (asker_id, field, title, body) VALUES ($1, 'imports-customs', $2, $3) RETURNING id::text`,
    [asker, title, body],
  );
  return rows[0]?.id ?? '';
}

beforeAll(async () => {
  t = await createTestDatabase();
  consenting = await person(true);
  declining = await person(false);
});
afterAll(async () => {
  await t.close();
});

const fakeResult = (promote: boolean, artifact: Uint8Array | null): TrainingResult => ({
  decision: { promote, reason: promote ? 'better' : 'not better', difference: null },
  params: { dims: 8, window: 5, minCount: 2, maxVocab: 20_000, seed: 1 },
  dataset: { trainingDocuments: 3, heldOutQuestions: 1, vocabulary: 5 },
  metrics: { mrr: 0.5, recallAt10: 0.5, queries: 30, trainMs: 1 },
  baseline: { kind: 'bm25', version: null, mrr: 0.4, recallAt10: 0.4 },
  artifact,
  reference: { profile: {}, centroid: [] },
});
const smallModel = () =>
  new Uint8Array(
    serializeModel(
      trainTextEmbedding(['customs duty on a watch', 'import tax on a watch', 'customs duty on a phone'], { dims: 4 }),
    ),
  );

describe('what the models may learn from', () => {
  it('takes only the posts of people who turned training on, and nothing hidden', async () => {
    const yes = await ask(consenting, 'Customs duty on a watch at Chennai?', 'Shipping a used watch from Geneva.');
    const no = await ask(declining, 'Work visa for a chef in Dubai?', '');
    const hidden = await ask(consenting, 'Cheap watches, visit my shop now?', '');
    await t.owner.query(`INSERT INTO app.decisions (question_id, decision) VALUES ($1, 'remove')`, [hidden]);
    const corpus = await loadCorpus(t.database);
    const ids = corpus.questions.map(q => q.id);
    expect(ids).toContain(yes);
    expect(ids).not.toContain(no);
    expect(ids).not.toContain(hidden);
    expect(corpus.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('forgets a person’s posts once they turn training off', async () => {
    const q = await ask(consenting, 'Import tax for a camera into Delhi?', '');
    expect((await loadCorpus(t.database)).questions.map(x => x.id)).toContain(q);
    await t.owner.query(
      `UPDATE app.user_consent_settings SET enabled = false WHERE user_id = $1 AND category = 'model_training'`,
      [consenting],
    );
    expect((await loadCorpus(t.database)).questions.map(x => x.id)).not.toContain(q);
    await t.owner.query(
      `UPDATE app.user_consent_settings SET enabled = true WHERE user_id = $1 AND category = 'model_training'`,
      [consenting],
    );
  });
});

describe('the training job and the registry', () => {
  it('skips when there is too little to learn from', async () => {
    expect(await trainTextEmbeddingJob(t.database)).toMatchObject({ status: 'skipped', reason: /needed/ });
  });

  it('serves a promoted version, records a rejected one without weights, and skips unchanged data', async () => {
    const first = await trainTextEmbeddingJob(t.database, {
      minDocuments: 1,
      run: () => Promise.resolve(fakeResult(true, smallModel())),
    });
    expect(first).toMatchObject({ status: 'promoted', version: 1 });
    const serving = await loadServing(t.database, TEXT_EMBEDDING);
    expect(serving?.version).toBe(1);
    const embedder = ownEmbedderFromArtifact(serving?.artifact ?? Buffer.alloc(0), 1);
    expect(embedder.model).toBe('graphinity:ppmi-svd-sif:v1');
    // Served at the model's own size, unpadded (migration 0021).
    expect(embedder.dims).toBe(deserializeModel(serving?.artifact ?? Buffer.alloc(0)).dims);
    expect((await embedder.embed(['customs duty']))[0]).toHaveLength(embedder.dims);

    // The same data again: no run at all.
    expect(
      await trainTextEmbeddingJob(t.database, {
        minDocuments: 1,
        run: () => Promise.reject(new Error('should not run')),
      }),
    ).toEqual({
      status: 'skipped',
      reason: 'nothing new since the last run',
    });

    await ask(consenting, 'Customs duty on perfume at Mumbai?', '');
    const rejected = await trainTextEmbeddingJob(t.database, {
      minDocuments: 1,
      run: () => Promise.resolve(fakeResult(false, null)),
    });
    expect(rejected).toMatchObject({ status: 'rejected', version: 2 });
    const rows = (
      await t.owner.query(
        'SELECT version, status, artifact IS NOT NULL AS has_weights FROM app.ml_models ORDER BY version',
      )
    ).rows;
    expect(rows).toEqual([
      { version: 1, status: 'production', has_weights: true },
      { version: 2, status: 'rejected', has_weights: false },
    ]);
  });

  it('retires the serving version when another is promoted: never two serving', async () => {
    await ask(consenting, 'Customs duty on a bicycle at Singapore?', '');
    await trainTextEmbeddingJob(t.database, {
      minDocuments: 1,
      run: () => Promise.resolve(fakeResult(true, smallModel())),
    });
    const { rows } = await t.owner.query(
      "SELECT version, status FROM app.ml_models WHERE status IN ('production', 'retired') ORDER BY version",
    );
    expect(rows).toEqual([
      { version: 1, status: 'retired' },
      { version: 3, status: 'production' },
    ]);
    await expect(
      t.owner.query(
        `INSERT INTO app.ml_models (name, version, algorithm, status, artifact, artifact_sha256, promoted_at)
         VALUES ('text-embedding', 99, 'ppmi-svd-sif', 'production', '\\x00', repeat('a', 64), now())`,
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('refuses to serve weights that no longer match their hash', async () => {
    // Damage below SQL (a disk, a restore): no update may replace weights (migration 0023), so it's simulated past that rule.
    await t.owner.query('ALTER TABLE app.ml_models DISABLE TRIGGER ml_models_weights_fixed');
    await t.owner.query("UPDATE app.ml_models SET artifact = artifact || '\\x00'::bytea WHERE status = 'production'");
    await t.owner.query('ALTER TABLE app.ml_models ENABLE TRIGGER ml_models_weights_fixed');
    await expect(loadServing(t.database, TEXT_EMBEDDING)).rejects.toThrow(/integrity check/);
  });

  it('is out of reach of every request: only the server’s own jobs see it', async () => {
    const asPerson = await t.database.withUser(consenting, q =>
      q.query('SELECT count(*)::int AS n FROM app.ml_models'),
    );
    expect(asPerson.rows).toEqual([{ n: 0 }]);
    await expect(
      t.database.withUser(consenting, q => q.query(`UPDATE app.ml_models SET status = 'retired'`)),
    ).resolves.toMatchObject({ rowCount: 0 });
  });
});

describe('a real training run on a worker thread', () => {
  it(
    'trains, evaluates against word matching, and returns a decision with its evidence',
    { timeout: 120_000 },
    async () => {
      const goods = ['watch', 'camera', 'laptop', 'phone', 'perfume', 'bicycle', 'tablet', 'drone'];
      const places = ['dubai', 'chennai', 'delhi', 'singapore', 'mumbai', 'london'];
      const questions: WorkerInput['questions'] = [];
      let id = 0;
      for (const g of goods)
        for (const p of places) {
          id += 1;
          questions.push({
            id: String(id),
            title: `customs duty on a ${g} at ${p}`,
            body: `what import tax did you pay when your ${g} arrived at ${p} airport by courier`,
          });
        }
      const result = await runOnWorker({ questions, answers: [], serving: null });
      expect(result.baseline.kind).toBe('bm25');
      expect(result.metrics.queries).toBeGreaterThan(0);
      expect(result.metrics.mrr).toBeGreaterThan(0);
      expect(result.dataset.heldOutQuestions + result.dataset.trainingDocuments).toBe(questions.length);
      expect(typeof result.decision.promote).toBe('boolean');
      expect(result.artifact === null).toBe(!result.decision.promote);
    },
  );
});

describe('the spelling job', () => {
  const scores = {
    typos: 120,
    newWords: 10,
    changed: 100,
    right: 95,
    precision: 0.95,
    precisionLower: 0.89,
    recall: 0.8,
  };
  const result = (promote: boolean): SpellingResult => ({
    decision: { promote, reason: promote ? 'fixes 80.0% of test typos' : 'only 12 test typos; 100 needed' },
    params: { lambda: 4, mu: 5, minCount: 2, keep: -1000, seed: 1 },
    dataset: { trainingDocuments: 3, heldOutDocuments: 1, vocabulary: 4, tuneWords: 100, testWords: 130 },
    metrics: { ...scores, tuneRecall: 0.8, trainMs: 1 },
    baseline: { kind: 'none', version: null, scores: null },
    artifact: promote
      ? new Uint8Array(
          serializeSpelling(
            trainSpelling(['customs duty on a watch', 'customs duty on a phone'], {
              lambda: 4,
              mu: 5,
              minCount: 2,
              keep: -1000,
            }),
          ),
        )
      : null,
  });

  it('is versioned apart from the text model, and serves a promoted version', async () => {
    const rejected = await trainSpellingJob(t.database, { minDocuments: 1, run: () => Promise.resolve(result(false)) });
    expect(rejected).toMatchObject({ status: 'rejected', version: 1 });
    await ask(consenting, 'Customs duty on a drone at Delhi?', '');
    const promoted = await trainSpellingJob(t.database, { minDocuments: 1, run: () => Promise.resolve(result(true)) });
    expect(promoted).toMatchObject({ status: 'promoted', version: 2 });
    const serving = await loadServing(t.database, SPELLING);
    expect(serving?.version).toBe(2);
    expect(speller(deserializeSpelling(serving?.artifact ?? Buffer.alloc(0))).correct('cusotms', null)).toBe('customs');
    const { rows } = await t.owner.query<{ name: string; status: string; metrics: { recall: number } }>(
      "SELECT name, status, metrics FROM app.ml_models WHERE name = 'spelling' ORDER BY version",
    );
    expect(rows.map(r => r.status)).toEqual(['rejected', 'production']);
    expect(rows[1]?.metrics.recall).toBe(0.8);
    // The text model's serving version is untouched by it.
    expect(
      (
        await t.owner.query(
          "SELECT count(*)::int AS n FROM app.ml_models WHERE name = 'text-embedding' AND status = 'production'",
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
  });

  it('runs for real on a worker thread', { timeout: 120_000 }, async () => {
    const goods = ['watch', 'camera', 'laptop', 'phone', 'perfume', 'bicycle', 'tablet', 'drone'];
    const questions = goods.flatMap((g, i) =>
      ['dubai', 'chennai', 'delhi', 'singapore', 'mumbai', 'london'].map((p, j) => ({
        id: String(i * 6 + j + 1),
        title: `customs duty on a ${g} at ${p}`,
        body: `what import tax did you pay when your ${g} arrived at ${p} airport by courier`,
      })),
    );
    const outcome = await runSpellingOnWorker({ questions, answers: [], serving: null });
    expect(outcome.dataset.trainingDocuments + outcome.dataset.heldOutDocuments).toBe(questions.length);
    expect(outcome.metrics.typos).toBeGreaterThan(0);
    expect(outcome.artifact === null).toBe(!outcome.decision.promote);
  });
});
