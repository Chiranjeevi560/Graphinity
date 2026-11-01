// The four stages of the charter's search cascade (§5.1), as pure steps the route runs in order: candidates from the
// engine, a cheap pre-rank that may nudge topics people pass through next, the learned ranker, and diversity last.
// Each stage records what it did, so a result can say how it got there.
import { dppGreedy, type Candidate } from '../ml/diversity.ts';
import type { Found } from './engine.ts';

export const PRE_RANK_KEEP = 100;
/** A topic people pass through next can lift a result, but only a few places: this is a hint, not relevance. */
export const NEXT_TOPIC_WEIGHT = 0.003;
/** RRF's constant, as the engine fuses with. */
const RRF_K = 60;
/** How strongly relevance counts against variety, from benchmark-ranking-evaluated (ADR 0032). */
export const DIVERSITY_THETA = 1;

/** Keeps the best `keep` of the engine's fused order, lifted slightly where the session is heading. */
export function preRank(
  found: readonly Found[],
  nextTopics: ReadonlyMap<string, number>,
  keep = PRE_RANK_KEEP,
): Found[] {
  return found
    .map((f, i) => ({ f, i, s: 1 / (RRF_K + i + 1) + NEXT_TOPIC_WEIGHT * (nextTopics.get(f.field) ?? 0) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, keep)
    .map(x => x.f);
}

const unit = (v: readonly number[]): number[] => {
  const norm = Math.hypot(...v);
  return norm ? v.map(x => x / norm) : [];
};

/**
 * The last stage. Earlier rank is what relevance means here: a ranker's scores aren't comparable between rankers.
 * A result with no vector counts as unlike everything, so a missing vector never hides it.
 */
export function diversify(
  ranked: readonly Found[],
  vectors: ReadonlyMap<string, readonly number[]>,
  k: number,
): Found[] {
  const items: Candidate[] = ranked.map((f, i) => ({
    relevance: 1 / Math.log2(i + 2),
    vector: unit(vectors.get(f.id) ?? []),
  }));
  const picked = dppGreedy(items, k, DIVERSITY_THETA).flatMap(i => {
    const f = ranked[i];
    return f ? [f] : [];
  });
  // DPP stops when what's left only repeats what's picked. A short list still shows the rest, last.
  if (picked.length >= k) return picked;
  const used = new Set(picked);
  return [...picked, ...ranked.filter(f => !used.has(f))].slice(0, k);
}
