// Learned click prediction for ads (docs/adr/0022-advertising-platform.md part 5):
// FTRL-Proximal (src/ml/ftrl.ts) over each impression's campaign, ad,
// placement, page topic and hour, with the campaign-by-topic and
// campaign-by-placement crosses a per-campaign average can't see.
// Trained daily while advertising is on, judged on the newest impressions
// it never saw, and promoted only when it measurably predicts clicks better
// than what serves now (shrunk per-campaign averages until a model serves).
import { createHash } from 'node:crypto';
import type { Database } from '../db.ts';
import {
  createFtrl,
  deserializeServing,
  learn,
  logLoss,
  predict,
  predictServing,
  serializeServing,
  servingOf,
} from '../ml/ftrl.ts';
import { seededRandom } from '../ml/linalg.ts';
import { loadServing, recordPromoted, recordRejected } from '../ml/registry.ts';
import { PRIOR_CTR, PRIOR_STRENGTH } from './serve.ts';
import { shrunkCtr } from './auction.ts';
import { AD_CTR, ctrFeatures, type CtrContext } from './ctr-features.ts';

export { AD_CTR, ctrFeatures };

export const AD_CTR_ALGORITHM = 'ftrl-proximal-hashed';
export const MIN_IMPRESSIONS = 20_000;
export const MIN_CLICKS = 200;
export const WINDOW_DAYS = 30;
export const ALPHAS = [0.05, 0.2, 0.5] as const;

export interface ImpressionExample extends CtrContext {
  id: string;
  clicked: boolean;
}

/** Paired bootstrap (95%) of the per-impression log-loss difference, candidate minus baseline. */
export function lossDifference(
  candidate: readonly number[],
  baseline: readonly number[],
  clicks: readonly boolean[],
  seed = 1,
) {
  const loss = (p: number, y: boolean) => {
    const q = Math.min(1 - 1e-12, Math.max(1e-12, p));
    return y ? -Math.log(q) : -Math.log(1 - q);
  };
  const d = clicks.map((y, i) => loss(candidate[i] ?? 0, y) - loss(baseline[i] ?? 0, y));
  const r = seededRandom(seed);
  const means: number[] = [];
  for (let s = 0; s < 1000; s++) {
    let sum = 0;
    for (let i = 0; i < d.length; i++) sum += d[Math.floor(r() * d.length)] ?? 0;
    means.push(sum / Math.max(1, d.length));
  }
  means.sort((a, b) => a - b);
  return { mean: d.reduce((s, x) => s + x, 0) / Math.max(1, d.length), low: means[25] ?? 0, high: means[974] ?? 0 };
}

export interface CtrTrainingResult {
  promote: boolean;
  reason: string;
  alpha: number;
  candidateLogLoss: number;
  baselineLogLoss: number;
  difference: { mean: number; low: number; high: number };
  artifact: Buffer | null;
  counts: { train: number; validate: number; test: number; clicks: number };
}

/**
 * Pure: examples in time order -> a decision. 70% to learn, the next 10% to
 * choose the learning rate, the newest 20% to judge against `baseline`
 * (each test impression's prediction from what serves now).
 */
export function trainCtr(
  examples: readonly ImpressionExample[],
  baseline: (e: ImpressionExample) => number,
): CtrTrainingResult {
  const a = Math.floor(examples.length * 0.7);
  const b = Math.floor(examples.length * 0.8);
  const train = examples.slice(0, a);
  const validate = examples.slice(a, b);
  const test = examples.slice(b);
  const counts = {
    train: train.length,
    validate: validate.length,
    test: test.length,
    clicks: examples.filter(e => e.clicked).length,
  };
  let best = { alpha: ALPHAS[0] as number, loss: Infinity };
  for (const alpha of ALPHAS) {
    const m = createFtrl({ alpha });
    for (const e of train) learn(m, ctrFeatures(e), e.clicked);
    const loss = logLoss(
      validate.map(e => predict(m, ctrFeatures(e))),
      validate.map(e => e.clicked),
    );
    if (loss < best.loss) best = { alpha, loss };
  }
  const model = createFtrl({ alpha: best.alpha });
  for (const e of [...train, ...validate]) learn(model, ctrFeatures(e), e.clicked);
  const candidate = test.map(e => predict(model, ctrFeatures(e)));
  const base = test.map(e => baseline(e));
  const clicks = test.map(e => e.clicked);
  const difference = lossDifference(candidate, base, clicks);
  const promote = difference.high < 0;
  return {
    promote,
    reason: promote
      ? `predicts clicks better: log loss ${difference.mean.toFixed(5)} [${difference.low.toFixed(5)}, ${difference.high.toFixed(5)}] per impression`
      : `not better than what serves: log loss difference ${difference.mean.toFixed(5)}, 95% interval up to ${difference.high.toFixed(5)}`,
    alpha: best.alpha,
    candidateLogLoss: logLoss(candidate, clicks),
    baselineLogLoss: logLoss(base, clicks),
    difference,
    artifact: promote ? serializeServing(servingOf(model)) : null,
    counts,
  };
}

export async function loadImpressionExamples(db: Pick<Database, 'asSystem'>): Promise<ImpressionExample[]> {
  return db.asSystem(
    async q =>
      (
        await q.query<ImpressionExample>(
          `SELECT id::text, campaign_id::text AS campaign, creative_id::text AS creative, placement, field,
                extract(hour FROM shown_at AT TIME ZONE 'UTC')::int AS hour, clicked_at IS NOT NULL AS clicked
         FROM app.ad_impressions WHERE shown_at > now() - make_interval(days => $1)
         ORDER BY shown_at, id`,
          [WINDOW_DAYS],
        )
      ).rows,
  );
}

export type CtrJobOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'promoted' | 'rejected'; version: number; result: CtrTrainingResult };

export async function trainAdCtrJob(db: Pick<Database, 'asSystem'>): Promise<CtrJobOutcome> {
  const examples = await loadImpressionExamples(db);
  const clicks = examples.filter(e => e.clicked).length;
  if (examples.length < MIN_IMPRESSIONS || clicks < MIN_CLICKS)
    return {
      status: 'skipped',
      reason: `${String(examples.length)} impressions and ${String(clicks)} clicks; ${String(MIN_IMPRESSIONS)} and ${String(MIN_CLICKS)} needed`,
    };
  const serving = await loadServing(db, AD_CTR);
  const servingModel = serving ? deserializeServing(serving.artifact) : null;
  // What serves without a model: each campaign's impressions before the judged part, shrunk.
  // Counted once, not rescanned per impression (that was quadratic in the window).
  const seen = new Map<string, { imp: number; clk: number }>();
  for (const e of examples.slice(0, Math.floor(examples.length * 0.8))) {
    const c = seen.get(e.campaign) ?? { imp: 0, clk: 0 };
    c.imp++;
    if (e.clicked) c.clk++;
    seen.set(e.campaign, c);
  }
  const result = trainCtr(examples, e => {
    if (servingModel) return predictServing(servingModel, ctrFeatures(e));
    const c = seen.get(e.campaign);
    return shrunkCtr(c?.clk ?? 0, c?.imp ?? 0, PRIOR_CTR, PRIOR_STRENGTH);
  });
  const record = {
    name: AD_CTR,
    algorithm: AD_CTR_ALGORITHM,
    params: { alpha: result.alpha, l1: 1, l2: 1, bits: 20 },
    dataset: {
      fingerprint: createHash('sha256')
        .update(`${examples[0]?.id ?? ''}:${examples.at(-1)?.id ?? ''}:${String(examples.length)}:${String(clicks)}`)
        .digest('hex'),
      ...result.counts,
    },
    metrics: { logLoss: result.candidateLogLoss, difference: result.difference },
    baseline: {
      kind: servingModel ? 'model' : 'shrunk',
      version: serving?.version ?? null,
      logLoss: result.baselineLogLoss,
    },
    reason: result.reason,
  };
  if (result.promote && result.artifact)
    return { status: 'promoted', version: await recordPromoted(db, record, result.artifact), result };
  return { status: 'rejected', version: await recordRejected(db, record), result };
}
