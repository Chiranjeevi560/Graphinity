// The daily drift monitor (docs/adr/0018-drift-monitoring.md): for each
// serving model, compare the last WINDOW_DAYS of the inputs it was served
// with the profile recorded when it was trained (src/ml/drift.ts),
// store one row per feature in app.ml_drift, and say whether anything drifted
// so the caller can retrain at once instead of waiting for the next daily
// run. Run as the system. Reads the same populations training does: exploit
// routes; searches that weren't interleaved, by people not under collusion
// review; for the text model (ADR 0019), new questions whose askers allow
// learning from what they write.
import { underCollusionReview } from '../collusion.ts';
import type { Database, Queryable } from '../db.ts';
import { FACTOR_ORDER, FACTORS_VERSION } from '../routing-score.ts';
import { FEATURE_NAMES, rankingFeatures } from '../search/features.ts';
import { SEARCH_RANKER } from '../search/rankers.ts';
import { columnsOf, featureDrift, type FeatureDrift, type Profile } from './drift.ts';
import { embeddingSignals } from './embedding-drift.ts';
import { deserializeModel } from './text-embedding.ts';
import { ROUTING, TEXT_EMBEDDING } from './training.ts';

export const WINDOW_DAYS = 7;
/** At most this many recent rows are read per model: bounds a run's memory. */
export const MAX_ROWS = 100_000;
export const RETENTION_DAYS = 400;

export interface ModelDrift {
  model: string;
  /** Why nothing was measured, when nothing was. */
  skipped?: 'nothing serving' | 'no training profile';
  version?: number;
  features: FeatureDrift[];
  drifted: boolean;
}

interface ServingRow {
  version: number;
  dataset: { profile?: Record<string, Profile>; centroid?: number[] };
}

interface Watched {
  name: string;
  /** Recent inputs, one column per feature. */
  recent: (q: Queryable, serving: ServingRow) => Promise<Record<string, number[]>>;
}

/** Row-major inputs as named columns. */
const tabular = (names: readonly string[], rows: (q: Queryable) => Promise<number[][]>) => async (q: Queryable) =>
  columnsOf(await rows(q), names);

const WATCHED: readonly Watched[] = [
  {
    name: ROUTING,
    recent: tabular(FACTOR_ORDER, async q =>
      (
        await q.query<{ factors: number[] }>(
          `SELECT factors FROM app.route_factors
           WHERE factors_version = $1 AND NOT explore AND recorded_at > now() - make_interval(days => $2)
           ORDER BY recorded_at DESC LIMIT $3`,
          [FACTORS_VERSION, WINDOW_DAYS, MAX_ROWS],
        )
      ).rows.map(r => r.factors),
    ),
  },
  {
    name: SEARCH_RANKER,
    recent: tabular(FEATURE_NAMES, async q =>
      (
        await q.query<{
          word_rank: number | null;
          meaning_rank: number | null;
          similarity: number | null;
          every_word: boolean;
          answer_count: number;
          answer_age_days: number | null;
        }>(
          `SELECT r.word_rank, r.meaning_rank, r.similarity, r.every_word, r.answer_count, r.answer_age_days
           FROM app.searches s JOIN app.search_results r ON r.search_id = s.id
           WHERE s.experiment IS NULL AND s.created_at > now() - make_interval(days => $1)
             AND NOT ${underCollusionReview('s.user_id')}
           ORDER BY s.id DESC LIMIT $2`,
          [WINDOW_DAYS, MAX_ROWS],
        )
      ).rows.map(r =>
        rankingFeatures({
          wordRank: r.word_rank,
          meaningRank: r.meaning_rank,
          similarity: r.similarity,
          everyWord: r.every_word,
          answerCount: r.answer_count,
          answerAgeDays: r.answer_age_days,
        }),
      ),
    ),
  },
  {
    name: TEXT_EMBEDDING,
    recent: async (q, serving) => {
      // The serving weights, checked against their stored hash before use.
      const row = (
        await q.query<{ artifact: Buffer; ok: boolean }>(
          `SELECT artifact, encode(sha256(artifact), 'hex') = artifact_sha256 AS ok
           FROM app.ml_models WHERE name = $1 AND version = $2`,
          [TEXT_EMBEDDING, serving.version],
        )
      ).rows[0];
      if (!row?.ok) throw new Error(`model ${TEXT_EMBEDDING} v${String(serving.version)} failed its integrity check`);
      const texts = (
        await q.query<{ title: string; body: string }>(
          `SELECT q.title, q.body FROM app.questions q
           JOIN app.user_consent_settings s ON s.user_id = q.asker_id AND s.category = 'model_training' AND s.enabled
           WHERE q.created_at > now() - make_interval(days => $1) AND NOT app.is_question_hidden(q.id)
           ORDER BY q.id DESC LIMIT $2`,
          [WINDOW_DAYS, MAX_ROWS],
        )
      ).rows.map(r => (r.body ? `${r.title}\n${r.body}` : r.title));
      return embeddingSignals(deserializeModel(row.artifact), texts, serving.dataset.centroid ?? []);
    },
  },
];

async function measure(q: Queryable, watched: Watched): Promise<ModelDrift> {
  const serving = (
    await q.query<ServingRow>(
      `SELECT version, jsonb_build_object('profile', dataset -> 'profile', 'centroid', dataset -> 'centroid') AS dataset
       FROM app.ml_models WHERE name = $1 AND status = 'production'`,
      [watched.name],
    )
  ).rows[0];
  if (!serving) return { model: watched.name, skipped: 'nothing serving', features: [], drifted: false };
  const profile = serving.dataset.profile;
  if (!profile)
    return {
      model: watched.name,
      skipped: 'no training profile',
      version: serving.version,
      features: [],
      drifted: false,
    };
  const features = featureDrift(profile, await watched.recent(q, serving));
  for (const f of features)
    await q.query(
      `INSERT INTO app.ml_drift (model, version, feature, psi, ks, p, n, drifted) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [watched.name, serving.version, f.feature, f.psi, f.ks, f.p, f.n, f.drifted],
    );
  return { model: watched.name, version: serving.version, features, drifted: features.some(f => f.drifted) };
}

export async function monitorDrift(db: Pick<Database, 'asSystem'>): Promise<ModelDrift[]> {
  return db.asSystem(async q => {
    await q.query('DELETE FROM app.ml_drift WHERE measured_at < now() - make_interval(days => $1)', [RETENTION_DAYS]);
    const out: ModelDrift[] = [];
    for (const w of WATCHED) out.push(await measure(q, w));
    return out;
  });
}
