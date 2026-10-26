// Drift monitoring on a real database (ADR 0018, migration 0026): the
// serving routing model's training profile against the inputs it was served
// in the last week, one row per feature, nothing for models with nothing to
// compare, and only the server's own jobs can see any of it.
import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { profilesOf } from '../src/ml/drift.ts';
import { centroidOf, EMBEDDING_SIGNALS, embeddingSignals } from '../src/ml/embedding-drift.ts';
import { serializeModel, trainTextEmbedding } from '../src/ml/text-embedding.ts';
import { monitorDrift, RETENTION_DAYS } from '../src/ml/drift-monitor.ts';
import { gaussian, seededRandom } from '../src/ml/linalg.ts';
import { FACTOR_ORDER } from '../src/routing-score.ts';
import { FEATURE_NAMES, rankingFeatures } from '../src/search/features.ts';
import { createTestDatabase, type TestDatabase } from './helpers/database.ts';
import { must } from './helpers/must.ts';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
  return () => t.close();
});

/** Factor vectors in [0, 1]; `proximity` (the first factor) moved up by `shift`. */
function vectors(n: number, seed: number, shift = 0): number[][] {
  const g = gaussian(seededRandom(seed));
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  return Array.from({ length: n }, () => FACTOR_ORDER.map((_, j) => clamp(0.5 + 0.15 * g() + (j === 0 ? shift : 0))));
}

let version = 0;
async function serve(profile: object | null) {
  version += 1;
  const artifact = Buffer.from(`routing ${String(version)}`);
  await t.owner.query(
    "UPDATE app.ml_models SET status = 'retired', retired_at = now() WHERE name = 'routing' AND status = 'production'",
  );
  await t.owner.query(
    `INSERT INTO app.ml_models (name, version, algorithm, dataset, status, artifact, artifact_sha256, promoted_at)
     VALUES ('routing', $1, 'test-routing', $2, 'production', $3, $4, now())`,
    [
      version,
      JSON.stringify({ fingerprint: `f${String(version)}`, ...(profile ? { profile } : {}) }),
      artifact,
      createHash('sha256').update(artifact).digest('hex'),
    ],
  );
}

/** Served routes as recorded, straight into route_factors (keys checked off: no routes needed). */
async function served(rows: number[][], options: { explore?: boolean; daysAgo?: number } = {}) {
  await t.owner.query("SET session_replication_role = 'replica'");
  try {
    let q = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);
    for (const factors of rows)
      await t.owner.query(
        `INSERT INTO app.route_factors (question_id, profile_id, factors_version, factors, explore, wave, recorded_at)
         VALUES ($1, gen_random_uuid(), 1, $2, $3, 1, now() - make_interval(days => $4))`,
        [q++, factors, options.explore ?? false, options.daysAgo ?? 1],
      );
  } finally {
    await t.owner.query("SET session_replication_role = 'origin'");
  }
}

const routing = async () => must((await monitorDrift(t.database)).find(m => m.model === 'routing'));

describe('the drift monitor', () => {
  it('measures nothing while nothing serves, or when the serving version has no profile', async () => {
    expect(await routing()).toEqual({ model: 'routing', skipped: 'nothing serving', features: [], drifted: false });
    await serve(null);
    expect(await routing()).toMatchObject({ skipped: 'no training profile', version, drifted: false });
    expect((await t.owner.query('SELECT 1 FROM app.ml_drift')).rowCount).toBe(0);
  });

  it('finds no drift when the served inputs look like the training data, and records every feature', async () => {
    await serve(profilesOf(vectors(5000, 1), FACTOR_ORDER));
    await served(vectors(400, 2));
    const report = await routing();
    expect(report.drifted).toBe(false);
    expect(report.features.map(f => f.feature)).toEqual([...FACTOR_ORDER].sort());
    expect(report.features.every(f => f.n === 400)).toBe(true);
    const { rows } = await t.owner.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM app.ml_drift WHERE model = $1 AND version = $2',
      [`routing`, version],
    );
    expect(rows[0]?.n).toBe(FACTOR_ORDER.length);
  });

  it('flags exactly the factor that moved, reading only the last week of exploit routes', async () => {
    await t.owner.query('DELETE FROM app.route_factors');
    await serve(profilesOf(vectors(5000, 3), FACTOR_ORDER));
    await served(vectors(400, 4, 0.15));
    // Neither old routes nor newcomer places count: both far off, both left out.
    await served(vectors(400, 5, -0.4), { daysAgo: 8 });
    await served(vectors(400, 6, -0.4), { explore: true });
    const report = await routing();
    expect(report.drifted).toBe(true);
    expect(report.features.filter(f => f.drifted).map(f => f.feature)).toEqual(['proximity']);
    expect(must(report.features.find(f => f.feature === 'proximity')).n).toBe(400);
  });

  it('gives no verdict on too few recent routes', async () => {
    await t.owner.query('DELETE FROM app.route_factors');
    await served(vectors(50, 7, 0.4));
    const report = await routing();
    expect(report.drifted).toBe(false);
    expect(report.features.every(f => f.n === 50 && !f.drifted)).toBe(true);
  });

  it('forgets measurements after the retention period', async () => {
    await t.owner.query(
      `INSERT INTO app.ml_drift (model, version, feature, psi, ks, p, n, drifted, measured_at)
       VALUES ('routing', 1, 'proximity', 0, 0, 1, 0, false, now() - make_interval(days => $1))`,
      [RETENTION_DAYS + 1],
    );
    await monitorDrift(t.database);
    const { rows } = await t.owner.query(
      'SELECT 1 FROM app.ml_drift WHERE measured_at < now() - make_interval(days => $1)',
      [RETENTION_DAYS],
    );
    expect(rows).toEqual([]);
  });

  it('is visible to the server’s own jobs only', async () => {
    const seen = await t.database.withUser(null, async q => (await q.query('SELECT 1 FROM app.ml_drift')).rowCount);
    expect(seen).toBe(0);
    await expect(
      t.database.withUser(null, q =>
        q.query(
          "INSERT INTO app.ml_drift (model, version, feature, psi, ks, p, n, drifted) VALUES ('routing', 1, 'x', 0, 0, 1, 0, false)",
        ),
      ),
    ).rejects.toThrow();
    expect((await t.database.asSystem(async q => q.query('SELECT 1 FROM app.ml_drift'))).rowCount).toBeGreaterThan(0);
  });
});

describe('the text model', () => {
  const KNOWN = ['customs', 'duty', 'watch', 'phone', 'airport', 'border', 'import', 'tax', 'camera', 'laptop'];
  const NEW = ['solar', 'subsidy', 'roof', 'school', 'admission', 'fees', 'hospital', 'scan', 'queue', 'grant'];
  const sentence = (words: readonly string[], seed: number) => {
    const r = seededRandom(seed);
    return Array.from({ length: 8 }, () => words[Math.floor(r() * words.length)] ?? 'duty').join(' ');
  };
  let people = 0;
  async function person(consents: boolean): Promise<string> {
    const id = randomUUID();
    people += 1;
    await t.owner.query('BEGIN');
    await t.owner.query(
      `INSERT INTO app.profiles (id, handle, country, adult_confirmed_at) VALUES ($1, $2, 'IN', now())`,
      [id, `drift.person${String(people)}`],
    );
    await t.owner.query("INSERT INTO app.profile_fields (profile_id, field) VALUES ($1, 'imports-customs')", [id]);
    await t.owner.query('COMMIT');
    await t.owner.query("UPDATE app.profiles SET created_at = now() - interval '60 days' WHERE id = $1", [id]);
    await t.owner.query(
      "INSERT INTO app.user_consent_settings (user_id, category, enabled, policy_version) VALUES ($1, 'model_training', $2, 1)",
      [id, consents],
    );
    return id;
  }
  async function asked(asker: string, words: readonly string[], n: number, seed: number) {
    for (let i = 0; i < n; i++)
      await t.owner.query(
        "INSERT INTO app.questions (asker_id, field, title, body) VALUES ($1, 'imports-customs', $2, '')",
        [asker, sentence(words, seed + i)],
      );
  }
  const text = async () => must((await monitorDrift(t.database)).find(m => m.model === 'text-embedding'));

  it('flags new questions full of words the serving model never learned, from consenting askers only', async () => {
    const model = trainTextEmbedding(
      Array.from({ length: 300 }, (_, i) => sentence(KNOWN, i)),
      { dims: 8, minCount: 1 },
    );
    const centroid = centroidOf(
      model,
      Array.from({ length: 300 }, (_, i) => sentence(KNOWN, i)),
    );
    const heldOut = embeddingSignals(
      model,
      Array.from({ length: 400 }, (_, i) => sentence(KNOWN, 10_000 + i)),
      centroid,
    );
    const profile = profilesOf(
      heldOut.coverage.map((_, i) => EMBEDDING_SIGNALS.map(name => heldOut[name][i] ?? 0)),
      EMBEDDING_SIGNALS,
    );
    const artifact = serializeModel(model);
    await t.owner.query(
      `INSERT INTO app.ml_models (name, version, algorithm, dataset, status, artifact, artifact_sha256, promoted_at)
       VALUES ('text-embedding', 1, 'ppmi-svd-sif', $1, 'production', $2, $3, now())`,
      [
        JSON.stringify({ fingerprint: 'drift', profile, centroid }),
        artifact,
        createHash('sha256').update(artifact).digest('hex'),
      ],
    );
    const [yes, no] = [await person(true), await person(false)];
    // Questions from before the last week are never read, however different.
    await asked(yes, NEW, 250, 35_000);
    await t.owner.query("UPDATE app.questions SET created_at = now() - interval '8 days' WHERE asker_id = $1", [yes]);
    await asked(yes, KNOWN, 250, 20_000);
    // Nor those of someone who doesn't allow learning from what they write.
    await asked(no, NEW, 250, 30_000);
    const same = await text();
    expect(same.drifted).toBe(false);
    expect(same.features.map(f => [f.feature, f.n])).toEqual([
      ['centroid_similarity', 250],
      ['coverage', 250],
    ]);
    await asked(yes, NEW, 250, 40_000);
    const moved = await text();
    expect(moved.drifted).toBe(true);
    expect(moved.features.find(f => f.feature === 'coverage')).toMatchObject({ drifted: true, n: 500 });
  });

  it('refuses to read weights that fail their integrity check, and still measures the other models', async () => {
    // The registry refuses to replace weights; damage is what this checks, so go around that rule.
    await t.owner.query("SET session_replication_role = 'replica'");
    await t.owner.query(
      "UPDATE app.ml_models SET artifact_sha256 = repeat('0', 64) WHERE name = 'text-embedding' AND version = 1",
    );
    await t.owner.query("SET session_replication_role = 'origin'");
    const report = await monitorDrift(t.database);
    expect(report.find(m => m.model === 'text-embedding')).toMatchObject({
      skipped: 'failed',
      errorKind: 'Error',
      drifted: false,
    });
    // The other models are still measured.
    expect(report.find(m => m.model === 'routing')?.skipped).not.toBe('failed');
  });
});

describe('the search ranking', () => {
  it('reads the features of non-interleaved searches from the last week, as served', async () => {
    const asker = randomUUID();
    await t.owner.query('BEGIN');
    await t.owner.query(
      "INSERT INTO app.profiles (id, handle, country, adult_confirmed_at) VALUES ($1, 'drift.searcher', 'IN', now())",
      [asker],
    );
    await t.owner.query("INSERT INTO app.profile_fields (profile_id, field) VALUES ($1, 'imports-customs')", [asker]);
    await t.owner.query('COMMIT');
    const question = must(
      (
        await t.owner.query<{ id: string }>(
          "INSERT INTO app.questions (asker_id, field, title) VALUES ($1, 'imports-customs', 'Customs duty on a drone at Goa?') RETURNING id::text",
          [asker],
        )
      ).rows[0],
    ).id;
    // Trained on results found by words only, ranked high, never answered.
    const trainedOn = Array.from({ length: 2000 }, (_, i) =>
      rankingFeatures({
        wordRank: 1 + (i % 10),
        meaningRank: null,
        similarity: null,
        everyWord: i % 2 === 0,
        answerCount: 0,
        answerAgeDays: null,
      }),
    );
    const artifact = Buffer.from('ranker');
    await t.owner.query(
      `INSERT INTO app.ml_models (name, version, algorithm, dataset, status, artifact, artifact_sha256, promoted_at)
       VALUES ('search-ranker', 1, 'lambdamart-ips', $1, 'production', $2, $3, now())`,
      [
        JSON.stringify({ fingerprint: 's', profile: profilesOf(trainedOn, FEATURE_NAMES) }),
        artifact,
        createHash('sha256').update(artifact).digest('hex'),
      ],
    );
    const searches = async (n: number, meaning: boolean, options: { experiment?: string; daysAgo?: number } = {}) => {
      await t.owner.query("SET session_replication_role = 'replica'");
      try {
        for (let i = 0; i < n; i++) {
          const id = must(
            (
              await t.owner.query<{ id: string }>(
                `INSERT INTO app.searches (user_id, consent_version, query, ranker, experiment, created_at, expires_at)
                 VALUES ($1, 1, 'customs duty', 'x', $2, now() - make_interval(days => $3),
                         now() - make_interval(days => $3) + interval '365 days') RETURNING id::text`,
                [asker, options.experiment ?? null, options.daysAgo ?? 1],
              )
            ).rows[0],
          ).id;
          await t.owner.query(
            `INSERT INTO app.search_results (search_id, position, ranked_position, question_id, word_rank, meaning_rank, similarity, every_word, answer_count)
             VALUES ($1, 1, 1, $2, $3, $4, $5, $6, 0)`,
            [id, question, 1 + (i % 10), meaning ? 1 + (i % 5) : null, meaning ? 0.6 : null, i % 2 === 0],
          );
        }
      } finally {
        await t.owner.query("SET session_replication_role = 'origin'");
      }
    };
    const ranker = async () => must((await monitorDrift(t.database)).find(m => m.model === 'search-ranker'));
    await searches(300, false);
    // Interleaved and older searches are left out, however different.
    await searches(300, true, { experiment: 'a/b' });
    await searches(300, true, { daysAgo: 9 });
    const same = await ranker();
    expect(same.drifted).toBe(false);
    expect(same.features.every(f => f.n === 300)).toBe(true);
    // Now meaning finds most results: the ranking sees inputs it never trained on.
    await searches(300, true);
    const moved = await ranker();
    expect(moved.drifted).toBe(true);
    expect(moved.features.filter(f => f.drifted).map(f => f.feature)).toContain('found_by_meaning');
  });
});
