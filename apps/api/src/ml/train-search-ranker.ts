// One training run of the learned search ranking (ADR 0015 part 6), as a pure
// function of its input so it is tested directly and runs on a worker thread.
//
// 1. Position bias is measured from the logged swaps (interventions.ts). Too
//    few clicks to measure it: no model is trained, rather than one trained on
//    a guessed correction.
// 2. One person in five is held out, by a hash of who they are, so a model is
//    judged on people it never learned from.
// 3. LambdaMART learns from the rest, each click weighted by the inverse of
//    its position's examination (clipped).
// 4. On the held-out searches, the results shown are reordered by the
//    candidate and by the baseline (the serving model, or the order logged),
//    and scored by inverse-propensity-weighted NDCG@10: under the position
//    model, an unbiased estimate of how well each orders by true relevance
//    (Joachims et al. 2017; Agarwal et al. 2019).
// 5. It passes only on a gain at least MIN_GAIN whose 99% paired bootstrap
//    interval over people excludes zero. Passing makes it a candidate, not the
//    serving model: online comparison decides that (judge.ts).
import { createHash } from 'node:crypto';
import { pairedDifference, type Judged } from '../search/metrics.ts';
import { clickWeight, estimatePropensities, type Propensities } from '../search/interventions.ts';
import type { TrainingSearch } from '../search/ranker-data.ts';
import {
  deserializeLambdaMart,
  LAMBDAMART_DEFAULTS,
  scoreOne,
  serializeLambdaMart,
  trainLambdaMart,
  type LambdaMartModel,
} from './lambdamart.ts';

export const SEARCH_RANKER_ALGORITHM = 'lambdamart-ips';
/** Held-out searches with a click, and the people behind them, needed before the gate decides. */
export const MIN_HELDOUT_SEARCHES = 200;
export const MIN_HELDOUT_PEOPLE = 30;
/** The least gain in IPS-NDCG@10 worth putting in front of people. */
export const MIN_GAIN = 0.01;
export const LEVEL = 0.99;

/** The gate: a gain at least MIN_GAIN, with the interval's low end above zero. */
export const passesGate = (d: { mean: number; low: number }) => d.low > 0 && d.mean >= MIN_GAIN;

export const isHeldOutPerson = (user: string) =>
  createHash('sha256').update(`search:${user}`).digest().readUInt8(0) % 5 === 0;

export interface SearchRankerInput {
  searches: TrainingSearch[];
  /** The serving learned model, if any: the bar to clear. Otherwise the logged order is. */
  serving: { version: number; artifact: Uint8Array } | null;
  options?: { trees?: number; maxDepth?: number; learningRate?: number };
}

export interface SearchRankerResult {
  decision: { promote: boolean; reason: string; difference: { mean: number; low: number; high: number } | null };
  params: Record<string, unknown>;
  dataset: { trainingSearches: number; heldOutSearches: number; heldOutPeople: number };
  metrics: { candidate: number | null; trainMs: number };
  baseline: { kind: 'model' | 'logged'; version: number | null; score: number | null };
  artifact: Uint8Array | null;
}

/** IPS-weighted NDCG@10 of reordering one search's shown results by `scores`. */
export function ipsNdcg(search: TrainingSearch, scores: readonly number[], p: Propensities): number {
  const gains = search.results.map(r => (r.label > 0 ? (2 ** r.label - 1) * clickWeight(p, r.position) : 0));
  const order = scores.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s || a.i - b.i);
  const dcg = (g: number[]) => g.slice(0, 10).reduce((sum, x, k) => sum + x / Math.log2(k + 2), 0);
  const ideal = dcg([...gains].sort((a, b) => b - a));
  return ideal > 0 ? dcg(order.map(o => gains[o.i] ?? 0)) / ideal : 0;
}

export function trainSearchRankerAndEvaluate(input: SearchRankerInput): SearchRankerResult {
  const params = { ...LAMBDAMART_DEFAULTS, ...input.options };
  const empty = { trainingSearches: 0, heldOutSearches: 0, heldOutPeople: 0 };
  const propensities = estimatePropensities(
    input.searches.map(s => ({
      swap: s.swap,
      results: s.results.map(r => ({ ranked: r.ranked, shown: r.position, clicked: r.label > 0 })),
    })),
  );
  if (!propensities)
    return refuse('not enough clicks yet to measure position bias from the swapped searches', empty, params);
  const withClick = (s: TrainingSearch) => s.results.some(r => r.label > 0);
  const train = input.searches.filter(s => !isHeldOutPerson(s.user));
  const heldOut = input.searches.filter(s => isHeldOutPerson(s.user) && withClick(s));
  const dataset = {
    trainingSearches: train.length,
    heldOutSearches: heldOut.length,
    heldOutPeople: new Set(heldOut.map(s => s.user)).size,
  };
  const all = { ...params, propensities: propensities.theta, eta: propensities.eta };
  if (dataset.heldOutSearches < MIN_HELDOUT_SEARCHES || dataset.heldOutPeople < MIN_HELDOUT_PEOPLE)
    return refuse(
      `${String(dataset.heldOutSearches)} held-out searches with a click from ${String(dataset.heldOutPeople)} people; ` +
        `${String(MIN_HELDOUT_SEARCHES)} from ${String(MIN_HELDOUT_PEOPLE)} needed`,
      dataset,
      all,
    );

  const started = performance.now();
  const model = trainLambdaMart(
    train.map(s => ({
      features: s.results.map(r => r.features),
      labels: s.results.map(r => r.label),
      weights: s.results.map(r => (r.label > 0 ? clickWeight(propensities, r.position) : 1)),
    })),
    params,
  );
  const trainMs = Math.round(performance.now() - started);

  const servingModel: LambdaMartModel | null = input.serving
    ? deserializeLambdaMart(Buffer.from(input.serving.artifact))
    : null;
  const judged = (score: (s: TrainingSearch) => number[]): Judged[] =>
    heldOut.map(s => {
      const value = ipsNdcg(s, score(s), propensities);
      return { user: s.user, relevance: [value], totalRelevant: 1 };
    });
  const candidate = judged(s => s.results.map(r => scoreOne(model, r.features)));
  // The logged order: the ranker's own positions, before any swap.
  const baseline = judged(s =>
    servingModel ? s.results.map(r => scoreOne(servingModel, r.features)) : s.results.map(r => -r.ranked),
  );
  const value = (q: Judged) => q.relevance[0] ?? 0;
  const mean = (qs: Judged[]) => qs.reduce((sum, q) => sum + value(q), 0) / qs.length;
  const difference = pairedDifference(candidate, baseline, value, { level: LEVEL });
  const promote = passesGate(difference);
  return {
    decision: {
      promote,
      reason: promote
        ? `IPS-NDCG@10 up ${difference.mean.toFixed(4)} (99% ${difference.low.toFixed(4)} to ${difference.high.toFixed(4)}) on ${String(dataset.heldOutPeople)} held-out people: a candidate for online comparison`
        : `IPS-NDCG@10 change ${difference.mean.toFixed(4)} (99% ${difference.low.toFixed(4)} to ${difference.high.toFixed(4)}): not a clear gain of ${String(MIN_GAIN)}`,
      difference: { mean: difference.mean, low: difference.low, high: difference.high },
    },
    params: all,
    dataset,
    metrics: { candidate: mean(candidate), trainMs },
    baseline: {
      kind: servingModel ? 'model' : 'logged',
      version: input.serving?.version ?? null,
      score: mean(baseline),
    },
    artifact: promote ? new Uint8Array(serializeLambdaMart(model)) : null,
  };

  function refuse(reason: string, data: SearchRankerResult['dataset'], p: Record<string, unknown>): SearchRankerResult {
    return {
      decision: { promote: false, reason, difference: null },
      params: p,
      dataset: data,
      metrics: { candidate: null, trainMs: 0 },
      baseline: { kind: input.serving ? 'model' : 'logged', version: input.serving?.version ?? null, score: null },
      artifact: null,
    };
  }
}
