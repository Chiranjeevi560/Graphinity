// The daily drift monitor (docs/adr/0018-drift-monitoring.md): for each
// serving tabular model, compare the last WINDOW_DAYS of the inputs it was
// served with the profile recorded when it was trained (src/ml/drift.ts),
// store one row per feature in app.ml_drift, and say whether anything drifted
// so the caller can retrain at once instead of waiting for the next daily
// run. Run as the system. Reads the same populations training does: exploit
// routes; searches that weren't interleaved, by people not under collusion
// review.
import { underCollusionReview } from '../collusion.ts';
import type { Database, Queryable } from '../db.ts';
import { FACTOR_ORDER, FACTORS_VERSION } from '../routing-score.ts';
import { FEATURE_NAMES, rankingFeatures } from '../search/features.ts';
import { SEARCH_RANKER } from '../search/rankers.ts';
import { columnsOf, featureDrift, type FeatureDrift, type Profile } from './drift.ts';
import { ROUTING } from './training.ts';

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

interface Watched {
  name: string;
  names: readonly string[];
  recent: (q: Queryable) => Promise<number[][]>;
}

const WATCHED: readonly Watched[] = [
  {
    name: ROUTING,
    names: FACTOR_ORDER,
    recent: async q =>
      (
        await q.query<{ factors: number[] }>(
          `SELECT factors FROM app.route_factors
           WHERE factors_version = $1 AND NOT explore AND recorded_at > now() - make_interval(days => $2)
           ORDER BY recorded_at DESC LIMIT $3`,
          [FACTORS_VERSION, WINDOW_DAYS, MAX_ROWS],
        )
      ).rows.map(r => r.factors),
  },
  {
    name: SEARCH_RANKER,
    names: FEATURE_NAMES,
    recent: async q =>
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
  },
];

async function measure(q: Queryable, watched: Watched): Promise<ModelDrift> {
  const serving = (
    await q.query<{ version: number; profile: Record<string, Profile> | null }>(
      `SELECT version, dataset -> 'profile' AS profile FROM app.ml_models WHERE name = $1 AND status = 'production'`,
      [watched.name],
    )
  ).rows[0];
  if (!serving) return { model: watched.name, skipped: 'nothing serving', features: [], drifted: false };
  if (!serving.profile)
    return {
      model: watched.name,
      skipped: 'no training profile',
      version: serving.version,
      features: [],
      drifted: false,
    };
  const features = featureDrift(serving.profile, columnsOf(await watched.recent(q), watched.names));
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
