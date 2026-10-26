// Serving the learned search ranking (ADR 0015 part 6): the production model
// reorders the engine's fused candidates; while another version waits for
// online comparison, a share of recorded searches interleave the two
// (team-draft interleaving, Radlinski, Kurup & Joachims 2008), and judge.ts
// decides from what people open. Without a production model, the engine's own
// fused order serves, and is what a first candidate is compared with.
import { scoreOne, type LambdaMartModel } from '../ml/lambdamart.ts';
import type { Found } from './engine.ts';
import { rankingFeatures } from './features.ts';

/** The fused order the engine serves without a model: what part 2 shipped. */
export const BASELINE_RANKER = 'rrf-equal-v1';
/** Share of recorded searches that interleave while a comparison runs. */
export const INTERLEAVE_SHARE = 0.5;
export const SEARCH_RANKER = 'search-ranker';

export interface ServedRanker {
  /** What logs and experiments call it: `rrf-equal-v1` or `lambdamart:v<version>`. */
  id: string;
  model: LambdaMartModel | null;
}

export interface Rankers {
  production: ServedRanker;
  /** A waiting candidate, or a recently retired version being kept honest (rollback), or null. */
  challenger: ServedRanker | null;
}

export const NO_RANKERS: Rankers = { production: { id: BASELINE_RANKER, model: null }, challenger: null };

const now = Date.now;

/** Days since an answer, as logged (search/log.ts) and as the model was trained on. */
function featuresOf(f: Found, at: number): number[] {
  return rankingFeatures({
    wordRank: f.wordRank,
    meaningRank: f.meaningRank,
    similarity: f.similarity,
    everyWord: f.everyWord,
    answerCount: f.answerCount,
    answerAgeDays: f.lastAnsweredAt ? Math.max(0, (at - f.lastAnsweredAt.getTime()) / 86_400_000) : null,
  });
}

/** The candidates in a ranker's order; the engine's fused order when it has no model. */
export function ordered(ranker: ServedRanker, found: readonly Found[], at = now()): Found[] {
  if (!ranker.model) return [...found];
  const model = ranker.model;
  return found
    .map((f, i) => ({ f, i, s: scoreOne(model, featuresOf(f, at)) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map(x => x.f);
}

/**
 * Team-draft interleaving of two orders: the team with fewer picks picks
 * next (a coin decides when even), taking its highest result not yet shown.
 * Each shown result is credited to the team that picked it.
 */
export function teamDraft(
  a: readonly Found[],
  b: readonly Found[],
  k: number,
  random: () => number,
): Array<{ found: Found; team: 'a' | 'b' }> {
  const out: Array<{ found: Found; team: 'a' | 'b' }> = [];
  const used = new Set<string>();
  let ia = 0;
  let ib = 0;
  let picksA = 0;
  let picksB = 0;
  const next = (list: readonly Found[], from: number): number => {
    let i = from;
    while (i < list.length && used.has(list[i]?.id ?? '')) i++;
    return i;
  };
  while (out.length < k) {
    ia = next(a, ia);
    ib = next(b, ib);
    if (ia >= a.length && ib >= b.length) break;
    const aTurn = ib >= b.length || (ia < a.length && (picksA < picksB || (picksA === picksB && random() < 0.5)));
    const pick = aTurn ? a[ia] : b[ib];
    if (!pick) break;
    used.add(pick.id);
    out.push({ found: pick, team: aTurn ? 'a' : 'b' });
    if (aTurn) picksA++;
    else picksB++;
  }
  return out;
}

/** The experiment's name in logs: control/challenger. */
export const experimentOf = (r: Rankers) => (r.challenger ? `${r.production.id}/${r.challenger.id}` : null);
