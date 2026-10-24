import { RRF_K } from './precheck.ts';

export interface RecommendationRanks {
  field: number | null;
  search: number | null;
  reading: number | null;
  recent: number;
}

export interface RankedRecommendation<T> {
  item: T;
  score: number;
  reason: string;
}

const EXPLANATIONS = {
  search: 'Related to your recent Graphinity searches',
  reading: 'Similar to a question you opened',
  field: 'In one of your selected topics',
  recent: 'Recently asked in Graphinity',
} as const;

/** Standard reciprocal-rank fusion. Each active retrieval source contributes one rank. */
export function reciprocalRankScore(ranks: RecommendationRanks): number {
  return reciprocal(ranks.field) + reciprocal(ranks.search) + reciprocal(ranks.reading) + reciprocal(ranks.recent);
}

/** Sorts bounded candidate rows, adds a source-level explanation, and returns at most `limit`. */
export function rankRecommendations<T extends { id: string; ranks: RecommendationRanks }>(
  candidates: readonly T[],
  limit: number,
): RankedRecommendation<T>[] {
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError('limit must be a non-negative integer');
  return candidates
    .map(item => {
      const score = reciprocalRankScore(item.ranks);
      const contributions = [
        { source: 'search', value: reciprocal(item.ranks.search) },
        { source: 'reading', value: reciprocal(item.ranks.reading) },
        { source: 'field', value: reciprocal(item.ranks.field) },
        { source: 'recent', value: reciprocal(item.ranks.recent) },
      ] as const;
      const strongest = contributions.reduce((best, next) => (next.value > best.value ? next : best));
      const reason = EXPLANATIONS[strongest.source];
      return { item, score, reason };
    })
    .sort((a, b) => b.score - a.score || compareId(b.item.id, a.item.id))
    .slice(0, limit);
}

function reciprocal(rank: number | null): number {
  if (rank === null) return 0;
  if (!Number.isInteger(rank) || rank < 1) throw new RangeError('source ranks must be positive integers');
  return 1 / (RRF_K + rank);
}

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
