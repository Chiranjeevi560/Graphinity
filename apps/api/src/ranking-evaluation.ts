/** Offline ranking and policy evaluation. This module never reads user data or performs I/O. */

export interface LabeledCandidate {
  id: string;
  relevance: number;
  score: number;
}

export interface RankingQuery {
  candidates: readonly LabeledCandidate[];
}

export interface RankingMetrics {
  queryCount: number;
  ndcgAtK: number | null;
  meanReciprocalRank: number | null;
  precisionAtK: number | null;
  recallAtK: number | null;
}

/**
 * Macro-averaged metrics for a fixed, deterministic top-k ranking.
 * Queries without any positive relevance are omitted from NDCG/MRR/recall;
 * precision still includes every query so empty results remain visible.
 * Ties use candidate id, making repeated evaluations reproducible.
 */
export function evaluateRanking(queries: readonly RankingQuery[], k: number): RankingMetrics {
  if (!Number.isInteger(k) || k < 1) throw new RangeError('k must be a positive integer');
  const sums = { ndcg: 0, reciprocalRank: 0, precision: 0, recall: 0 };
  let judgedQueries = 0;

  for (const query of queries) {
    validateRankingQuery(query);
    const ranked = [...query.candidates].sort((a, b) => b.score - a.score || compareId(a.id, b.id));
    const top = ranked.slice(0, k);
    const relevantCount = query.candidates.filter(candidate => candidate.relevance > 0).length;
    const hits = top.filter(candidate => candidate.relevance > 0).length;
    sums.precision += hits / k;

    if (relevantCount === 0) continue;
    judgedQueries += 1;
    const firstRelevant = top.findIndex(candidate => candidate.relevance > 0);
    sums.reciprocalRank += firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1);
    sums.recall += hits / relevantCount;
    const dcg = discountedGain(top);
    const ideal = [...query.candidates].sort((a, b) => b.relevance - a.relevance || compareId(a.id, b.id)).slice(0, k);
    const idcg = discountedGain(ideal);
    sums.ndcg += idcg === 0 ? 0 : dcg / idcg;
  }

  return {
    queryCount: queries.length,
    ndcgAtK: judgedQueries ? sums.ndcg / judgedQueries : null,
    meanReciprocalRank: judgedQueries ? sums.reciprocalRank / judgedQueries : null,
    precisionAtK: queries.length ? sums.precision / queries.length : null,
    recallAtK: judgedQueries ? sums.recall / judgedQueries : null,
  };
}

export interface LoggedAction {
  /** Probability of the observed action under the policy that generated the log. */
  loggingProbability: number;
  /** Probability that the candidate policy would choose the observed action. */
  targetProbability: number;
  /** Bounded observed outcome, for example whether the answer was selected. */
  reward: number;
}

export interface CounterfactualMetrics {
  actionCount: number;
  inversePropensityEstimate: number | null;
  selfNormalizedEstimate: number | null;
  effectiveSampleSize: number;
  maximumImportanceWeight: number;
}

/**
 * Inverse-propensity and self-normalized estimates for logged stochastic policies.
 * Positivity and bounded rewards are checked because violating either makes the
 * estimate undefined or misleading. Weights are deliberately not clipped.
 */
export function evaluateCounterfactual(actions: readonly LoggedAction[]): CounterfactualMetrics {
  let weightedReward = 0;
  let weightTotal = 0;
  let squaredWeightTotal = 0;
  let maximumImportanceWeight = 0;

  for (const [index, action] of actions.entries()) {
    if (
      !Number.isFinite(action.loggingProbability) ||
      action.loggingProbability <= 0 ||
      action.loggingProbability > 1
    ) {
      throw new RangeError(`actions[${index}].loggingProbability must be in (0, 1]`);
    }
    if (!Number.isFinite(action.targetProbability) || action.targetProbability < 0 || action.targetProbability > 1) {
      throw new RangeError(`actions[${index}].targetProbability must be in [0, 1]`);
    }
    if (!Number.isFinite(action.reward) || action.reward < 0 || action.reward > 1) {
      throw new RangeError(`actions[${index}].reward must be in [0, 1]`);
    }
    const weight = action.targetProbability / action.loggingProbability;
    weightedReward += weight * action.reward;
    weightTotal += weight;
    squaredWeightTotal += weight * weight;
    maximumImportanceWeight = Math.max(maximumImportanceWeight, weight);
  }

  return {
    actionCount: actions.length,
    inversePropensityEstimate: actions.length ? weightedReward / actions.length : null,
    selfNormalizedEstimate: weightTotal ? weightedReward / weightTotal : null,
    effectiveSampleSize: squaredWeightTotal ? (weightTotal * weightTotal) / squaredWeightTotal : 0,
    maximumImportanceWeight,
  };
}

function discountedGain(candidates: readonly LabeledCandidate[]): number {
  return candidates.reduce((sum, candidate, index) => {
    const gain = 2 ** candidate.relevance - 1;
    return sum + gain / Math.log2(index + 2);
  }, 0);
}

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function validateRankingQuery(query: RankingQuery): void {
  const ids = new Set<string>();
  for (const [index, candidate] of query.candidates.entries()) {
    if (!candidate.id || ids.has(candidate.id)) throw new TypeError(`candidate ids must be non-empty and unique`);
    ids.add(candidate.id);
    if (!Number.isFinite(candidate.score)) throw new RangeError(`candidates[${index}].score must be finite`);
    if (!Number.isInteger(candidate.relevance) || candidate.relevance < 0 || candidate.relevance > 4) {
      throw new RangeError(`candidates[${index}].relevance must be an integer from 0 to 4`);
    }
  }
}
