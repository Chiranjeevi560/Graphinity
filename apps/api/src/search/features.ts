// The features a learned search ranking reads (ADR 0015 part 6), from what
// is logged with each shown result (app.search_results) and what the engine
// knows when it serves. One function for both, so a model is served exactly
// the features it was trained on.

export interface RankingInputs {
  /** Place in the word ranking (1 first), or null. */
  wordRank: number | null;
  meaningRank: number | null;
  /** Cosine similarity by meaning, or null. */
  similarity: number | null;
  everyWord: boolean;
  answerCount: number;
  /** Days since its last answer, or null if never answered. */
  answerAgeDays: number | null;
}

export const FEATURE_NAMES = [
  'word_reciprocal_rank',
  'meaning_reciprocal_rank',
  'similarity',
  'found_by_meaning',
  'found_by_words',
  'every_word',
  'log_answers',
  'answer_freshness',
] as const;

/** RRF's own transform of a rank (k = 60), so a linear model can express fusion too. */
const reciprocal = (rank: number | null) => (rank === null ? 0 : 1 / (60 + rank));

export function rankingFeatures(x: RankingInputs): number[] {
  return [
    reciprocal(x.wordRank),
    reciprocal(x.meaningRank),
    x.similarity ?? 0,
    x.meaningRank === null ? 0 : 1,
    x.wordRank === null ? 0 : 1,
    x.everyWord ? 1 : 0,
    Math.log1p(Math.max(0, x.answerCount)),
    // 1 for an answer today, 0.5 after a month, 0 if never answered.
    x.answerAgeDays === null ? 0 : 1 / (1 + x.answerAgeDays / 30),
  ];
}
