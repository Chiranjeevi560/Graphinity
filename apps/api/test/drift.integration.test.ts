// Drift monitoring on a real database (ADR 0018, migration 0026): the
// serving routing model's training profile against the inputs it was served
// in the last week, one row per feature, nothing for models with nothing to
// compare, and only the server's own jobs can see any of it.
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { profilesOf } from '../src/ml/drift.ts';
import { monitorDrift, RETENTION_DAYS } from '../src/ml/drift-monitor.ts';
import { gaussian, seededRandom } from '../src/ml/linalg.ts';
import { FACTOR_ORDER } from '../src/routing-score.ts';
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
