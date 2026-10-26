// The model registry (app.ml_models, migration 0015): every trained version
// of every model, with what it was trained on and how it scored. Only the
// server's own jobs use it (row-level security admits system transactions
// only). Promoting retires the serving version in the same transaction, under
// one lock per model name, so there is never zero or two serving versions.
import { createHash } from 'node:crypto';
import type { Database, Queryable } from '../db.ts';

export interface ModelRecord {
  name: string;
  algorithm: string;
  params: Record<string, unknown>;
  dataset: { fingerprint: string } & Record<string, unknown>;
  metrics: Record<string, unknown>;
  baseline: Record<string, unknown>;
  reason: string;
}

export interface Serving {
  id: string;
  version: number;
  artifact: Buffer;
  dataset: { fingerprint?: string };
}

const lockFor = (q: Queryable, name: string) => q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ml:${name}`]);

async function nextVersion(q: Queryable, name: string): Promise<number> {
  const { rows } = await q.query<{ v: number }>(
    'SELECT coalesce(max(version), 0) + 1 AS v FROM app.ml_models WHERE name = $1',
    [name],
  );
  return rows[0]?.v ?? 1;
}

/** The serving version's weights, or null when none serves yet. */
export async function loadServing(db: Pick<Database, 'asSystem'>, name: string): Promise<Serving | null> {
  return db.asSystem(async q => {
    const { rows } = await q.query<{
      id: string;
      version: number;
      artifact: Buffer;
      artifact_sha256: string;
      dataset: Serving['dataset'];
    }>(
      `SELECT id::text AS id, version, artifact, artifact_sha256, dataset FROM app.ml_models
       WHERE name = $1 AND status = 'production'`,
      [name],
    );
    const row = rows[0];
    if (!row) return null;
    // A damaged artifact must never serve: check it against the hash stored with it.
    if (createHash('sha256').update(row.artifact).digest('hex') !== row.artifact_sha256)
      throw new Error(`model ${name} v${String(row.version)} failed its integrity check`);
    return { id: row.id, version: row.version, artifact: row.artifact, dataset: row.dataset };
  });
}

/** The newest version's dataset fingerprint, served or not: to skip retraining on the same data. */
export async function latestFingerprint(db: Pick<Database, 'asSystem'>, name: string): Promise<string | null> {
  return db.asSystem(async q => {
    const { rows } = await q.query<{ fp: string | null }>(
      `SELECT dataset ->> 'fingerprint' AS fp FROM app.ml_models WHERE name = $1 ORDER BY version DESC LIMIT 1`,
      [name],
    );
    return rows[0]?.fp ?? null;
  });
}

/** When this model's latest rejected version was recorded (ms), or null: later gates judge only newer data. */
export async function lastRejectedAt(db: Pick<Database, 'asSystem'>, name: string): Promise<number | null> {
  return db.asSystem(async q => {
    // Only a rejection that measured a difference counts: one refused before measuring
    // (too few askers, say) judged no questions, so it must not narrow the next window.
    // A retirement counts too (automatic demotion, or the owner's own), from when it happened:
    // the next candidate is judged only on questions asked after it, so the same model can't
    // simply return.
    const { rows } = await q.query<{ at: number | null }>(
      `SELECT (extract(epoch FROM max(CASE WHEN status = 'retired' THEN retired_at ELSE created_at END)) * 1000)::float8 AS at
       FROM app.ml_models
       WHERE name = $1 AND (
         (status = 'rejected' AND jsonb_typeof(metrics -> 'difference') = 'object')
         OR status = 'retired')`,
      [name],
    );
    return rows[0]?.at ?? null;
  });
}

/** Takes a serving version out of service (automatic demotion), recording why. Inside the caller's transaction. */
export async function retireServing(q: Queryable, name: string, version: number, reason: string): Promise<void> {
  await lockFor(q, name);
  await q.query(
    `UPDATE app.ml_models SET status = 'retired', retired_at = now(), reason = left($3, 500)
     WHERE name = $1 AND version = $2 AND status = 'production'`,
    [name, version, reason],
  );
}

/** Records a version that didn't pass its gate. Its weights aren't kept: they'd never serve. */
export async function recordRejected(db: Pick<Database, 'asSystem'>, record: ModelRecord): Promise<number> {
  return db.asSystem(async q => {
    await lockFor(q, record.name);
    const version = await nextVersion(q, record.name);
    await q.query(
      `INSERT INTO app.ml_models (name, version, algorithm, params, dataset, metrics, baseline, status, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'rejected', $8)`,
      [
        record.name,
        version,
        record.algorithm,
        record.params,
        record.dataset,
        record.metrics,
        record.baseline,
        record.reason,
      ],
    );
    return version;
  });
}

/** Records a version that passed, makes it the serving one, and retires the previous. */
export async function recordPromoted(
  db: Pick<Database, 'asSystem'>,
  record: ModelRecord,
  artifact: Buffer,
): Promise<number> {
  const sha = createHash('sha256').update(artifact).digest('hex');
  return db.asSystem(async q => {
    await lockFor(q, record.name);
    const version = await nextVersion(q, record.name);
    await q.query(
      `UPDATE app.ml_models SET status = 'retired', retired_at = now() WHERE name = $1 AND status = 'production'`,
      [record.name],
    );
    await q.query(
      `INSERT INTO app.ml_models
         (name, version, algorithm, params, dataset, metrics, baseline, status, reason, artifact, artifact_sha256, promoted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'production', $8, $9, $10, now())`,
      [
        record.name,
        version,
        record.algorithm,
        record.params,
        record.dataset,
        record.metrics,
        record.baseline,
        record.reason,
        artifact,
        sha,
      ],
    );
    return version;
  });
}

/**
 * Records a version that passed its offline gate as the one candidate waiting
 * for online comparison (ADR 0015 part 6): any earlier candidate is rejected
 * as superseded, its weights dropped. The serving version is untouched.
 */
export async function recordCandidate(
  db: Pick<Database, 'asSystem'>,
  record: ModelRecord,
  artifact: Buffer,
): Promise<number> {
  const sha = createHash('sha256').update(artifact).digest('hex');
  return db.asSystem(async q => {
    await lockFor(q, record.name);
    await q.query(
      `UPDATE app.ml_models SET status = 'rejected', artifact = NULL, artifact_sha256 = NULL,
              reason = 'superseded by a newer candidate'
       WHERE name = $1 AND status = 'candidate'`,
      [record.name],
    );
    const version = await nextVersion(q, record.name);
    await q.query(
      `INSERT INTO app.ml_models
         (name, version, algorithm, params, dataset, metrics, baseline, status, reason, artifact, artifact_sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'candidate', $8, $9, $10)`,
      [
        record.name,
        version,
        record.algorithm,
        record.params,
        record.dataset,
        record.metrics,
        record.baseline,
        record.reason,
        artifact,
        sha,
      ],
    );
    return version;
  });
}

export interface StoredVersion {
  version: number;
  status: 'candidate' | 'production' | 'retired';
  artifact: Buffer;
  params: Record<string, unknown>;
  retiredAt: Date | null;
  createdAt: Date;
}

/**
 * The versions online comparison needs: the serving one, the waiting
 * candidate, and the most recently retired one if it was retired within
 * `retiredWithinDays` (the one an automatic rollback would restore). Each
 * artifact is checked against its hash.
 */
export async function loadComparable(
  db: Pick<Database, 'asSystem'>,
  name: string,
  retiredWithinDays: number,
): Promise<{ production: StoredVersion | null; candidate: StoredVersion | null; retired: StoredVersion | null }> {
  return db.asSystem(async q => {
    const { rows } = await q.query<{
      version: number;
      status: StoredVersion['status'];
      artifact: Buffer;
      artifact_sha256: string;
      params: Record<string, unknown>;
      retired_at: Date | null;
      created_at: Date;
    }>(
      `(SELECT version, status, artifact, artifact_sha256, params, retired_at, created_at FROM app.ml_models
        WHERE name = $1 AND status IN ('production', 'candidate'))
       UNION ALL
       (SELECT version, status, artifact, artifact_sha256, params, retired_at, created_at FROM app.ml_models
        WHERE name = $1 AND status = 'retired' AND artifact IS NOT NULL
          AND retired_at > now() - make_interval(days => $2)
        ORDER BY retired_at DESC LIMIT 1)`,
      [name, retiredWithinDays],
    );
    const out: { production: StoredVersion | null; candidate: StoredVersion | null; retired: StoredVersion | null } = {
      production: null,
      candidate: null,
      retired: null,
    };
    for (const r of rows) {
      if (createHash('sha256').update(r.artifact).digest('hex') !== r.artifact_sha256)
        throw new Error(`model ${name} v${String(r.version)} failed its integrity check`);
      out[r.status] = {
        version: r.version,
        status: r.status,
        artifact: r.artifact,
        params: r.params,
        retiredAt: r.retired_at,
        createdAt: r.created_at,
      };
    }
    return out;
  });
}

/** Online comparison's verdicts, each with its evidence, under the model's lock. */
export async function settleComparison(
  db: Pick<Database, 'asSystem'>,
  name: string,
  verdict:
    | { kind: 'promote'; version: number; evidence: Record<string, unknown> }
    | { kind: 'reject'; version: number; evidence: Record<string, unknown> }
    | { kind: 'restore'; version: number; evidence: Record<string, unknown> },
): Promise<void> {
  await db.asSystem(async q => {
    await lockFor(q, name);
    const reason = JSON.stringify(verdict.evidence).slice(0, 500);
    if (verdict.kind === 'reject') {
      await q.query(
        `UPDATE app.ml_models SET status = 'rejected', artifact = NULL, artifact_sha256 = NULL, reason = $3,
                metrics = metrics || jsonb_build_object('online', $4::jsonb)
         WHERE name = $1 AND version = $2 AND status = 'candidate'`,
        [name, verdict.version, `lost online: ${reason}`, JSON.stringify(verdict.evidence)],
      );
      return;
    }
    // Promote a candidate, or restore a retired version (an automatic rollback): either way,
    // the current serving version retires and the other serves.
    const from = verdict.kind === 'promote' ? 'candidate' : 'retired';
    const { rowCount } = await q.query(`SELECT 1 FROM app.ml_models WHERE name = $1 AND version = $2 AND status = $3`, [
      name,
      verdict.version,
      from,
    ]);
    if (!rowCount) return;
    await q.query(
      `UPDATE app.ml_models SET status = 'retired', retired_at = now(),
              reason = left($2 || reason, 500)
       WHERE name = $1 AND status = 'production'`,
      [name, verdict.kind === 'restore' ? 'rolled back: ' : 'replaced online: '],
    );
    await q.query(
      `UPDATE app.ml_models SET status = 'production', promoted_at = now(), retired_at = NULL, reason = $3,
              metrics = metrics || jsonb_build_object('online', $4::jsonb)
       WHERE name = $1 AND version = $2`,
      [
        name,
        verdict.version,
        `${verdict.kind === 'restore' ? 'restored' : 'won'} online: ${reason}`,
        JSON.stringify(verdict.evidence),
      ],
    );
  });
}
