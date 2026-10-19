// Before a question is asked: has it been asked already? (docs/SPEC.md
// §11.1, §12.1). Two rankings are fused, one by meaning (embeddings) and one
// by words (full text), so exact codes like "BOE-II" and synonyms like
// "duty" and "import tax" are both found. Pure: the SQL feeds it.

/** Spec §12.1: RRF with k = 60, meaning weighted 0.65 and words 0.35. */
export const RRF_K = 60;
export const W_MEANING = 0.65;
export const W_WORDS = 0.35;
/** Spec §11.1: at or above this, it is the same question. */
export const DUPLICATE_AT = 0.88;
/** Spec §11.1: at or above this, it is related enough to show. */
export const RELATED_AT = 0.72;
/** Spec §11.1: a duplicate counts only with an answer this recent. */
export const FRESH_DAYS = 180;

/** Reciprocal Rank Fusion of two best-first lists of ids. */
export function fuse(byMeaning: readonly string[], byWords: readonly string[]): string[] {
  const score = new Map<string, number>();
  byMeaning.forEach((id, i) => { score.set(id, (score.get(id) ?? 0) + W_MEANING / (RRF_K + i + 1)); });
  byWords.forEach((id, i) => { score.set(id, (score.get(id) ?? 0) + W_WORDS / (RRF_K + i + 1)); });
  return [...score.entries()].sort((a, b) => b[1] - a[1] || Number(b[0]) - Number(a[0])).map(([id]) => id);
}

export type Verdict = 'duplicate' | 'related' | 'clear';

export interface Candidate {
  /** Cosine similarity by meaning; null when meaning wasn't available. */
  similarity: number | null;
  /** When it last got an answer anyone can see, if ever. */
  lastAnsweredAt: Date | null;
  /** It holds every word typed so far (the last one may be half-typed). */
  everyWord: boolean;
}

/**
 * Spec §11.1. "duplicate" only when the closest in meaning is at least
 * 0.88 and has a visible answer from the last 180 days (an unanswered or
 * stale question is no reason to stop someone asking). "related" from 0.72,
 * or when it holds every word typed: half-typed words and exact codes
 * ("BOE-II") mean little to the model but are what the person is after.
 * Without meaning (embeddings unavailable), word matches are only ever
 * "related": words alone are too weak to stop anyone asking.
 */
export function verdict(candidates: readonly Candidate[], now: Date, meaningAvailable: boolean): Verdict {
  if (!meaningAvailable) return candidates.length > 0 ? 'related' : 'clear';
  if (candidates.some(c => isDuplicate(c, now))) return 'duplicate';
  if (candidates.some(c => (c.similarity ?? 0) >= RELATED_AT || c.everyWord)) return 'related';
  return 'clear';
}

function isDuplicate(c: Candidate, now: Date): boolean {
  return (c.similarity ?? 0) >= DUPLICATE_AT && c.lastAnsweredAt !== null && now.getTime() - c.lastAnsweredAt.getTime() <= FRESH_DAYS * 86_400_000;
}

/**
 * The few to show, from the whole fused pool: a recent duplicate first (the
 * screen offers the first one to read instead), then any holding every word
 * typed, then the rest in fused order. Otherwise many questions close in
 * meaning can push the one the person is typing out of a short list.
 */
export function shortlist<T extends Candidate>(fused: readonly T[], now: Date, count: number): T[] {
  const tier = (c: T) => (isDuplicate(c, now) ? 0 : c.everyWord ? 1 : 2);
  return fused.map((c, i) => ({ c, i, t: tier(c) })).sort((a, b) => a.t - b.t || a.i - b.i).slice(0, count).map(x => x.c);
}
