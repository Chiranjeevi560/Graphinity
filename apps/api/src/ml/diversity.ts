// Keeping a result list from saying one thing ten times (master charter §5.1). MMR (Carbonell & Goldstein 1998) picks
// by relevance minus likeness to what's already picked. DPP greedy MAP (Chen, Zhang & Zhou 2018) picks what most grows
// the determinant of a relevance-weighted similarity matrix, so it weighs a pick against everything chosen together
// rather than only its nearest neighbour. Which one serves is benchmark-diversity's to say (ADR 0032).
import { at } from './num.ts';

export interface Candidate {
  relevance: number;
  vector: ArrayLike<number>;
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += at(a, i) * at(b, i);
  return sum;
};

/** Indexes in picked order. `lambda` 1 is pure relevance; 0 is pure variety. Vectors are unit length. */
export function mmr(items: readonly Candidate[], k: number, lambda: number): number[] {
  const picked: number[] = [];
  // The highest likeness to anything picked so far: updated per pick, so this is O(kn), not O(k²n).
  const nearest = new Float64Array(items.length).fill(-Infinity);
  const left = new Set(items.keys());
  while (picked.length < k && left.size) {
    let best = -1;
    let bestScore = -Infinity;
    for (const i of left) {
      const like = picked.length ? at(nearest, i) : 0;
      const s = lambda * (items[i]?.relevance ?? 0) - (1 - lambda) * like;
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    }
    const chosen = items[best];
    if (!chosen) break;
    picked.push(best);
    left.delete(best);
    for (const i of left) nearest[i] = Math.max(at(nearest, i), dot(items[i]?.vector ?? [], chosen.vector));
  }
  return picked;
}

/**
 * Greedy MAP for a DPP with kernel L = diag(q)·S·diag(q), q = exp(theta·relevance), S = max(cosine, 0) nudged onto the
 * diagonal so it stays positive definite. Each pick extends a Cholesky factor per candidate: O(k²n) in all.
 */
export function dppGreedy(items: readonly Candidate[], k: number, theta: number): number[] {
  const n = items.length;
  const q = items.map(c => Math.exp(theta * c.relevance));
  const gain = q.map(x => x * x * (1 + 1e-6));
  const factors: Float64Array[] = [];
  const picked: number[] = [];
  const left = new Set(items.keys());
  while (picked.length < k && left.size) {
    let best = -1;
    let bestGain = 0;
    for (const i of left)
      if (at(gain, i) > bestGain) {
        bestGain = at(gain, i);
        best = i;
      }
    // Nothing left adds anything: the rest repeat what's picked.
    if (best < 0 || bestGain <= 1e-12) break;
    const row = new Float64Array(n);
    const root = Math.sqrt(bestGain);
    const chosen = items[best]?.vector ?? [];
    for (const i of left) {
      let l = at(q, i) * at(q, best) * Math.max(dot(items[i]?.vector ?? [], chosen), 0);
      for (const f of factors) l -= at(f, i) * at(f, best);
      const v = l / root;
      row[i] = v;
      gain[i] = at(gain, i) - v * v;
    }
    factors.push(row);
    picked.push(best);
    left.delete(best);
  }
  return picked;
}
