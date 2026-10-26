// Measuring position bias from people's own behaviour (ADR 0015 part 6).
// People click higher results more whatever their relevance, so clicks can
// only teach a ranking once each position's chance of being looked at is
// known. On a small share of recorded searches, two neighbours among the
// top five swap places (RandPair: Wang et al. 2018; Joachims et al. 2017).
// Under the position-based model, click rate = examination(position) x
// attractiveness(result), so comparing the same two results in both orders
// gives the ratio of examination between neighbouring positions, and the
// results' own relevance cancels out.

/** Share of recorded searches that swap one neighbouring pair: disclosed in the privacy page and ADR. */
export const SWAP_SHARE = 0.1;
/** Swaps happen among the top five, where clicks are plentiful enough to measure. */
export const SWAP_DEPTH = 5;
/** Clicks each count needs before a ratio is trusted. */
export const MIN_CLICKS = 30;
/** Inverse propensities are clipped here, bounding any one click's weight (Joachims et al. 2017). */
export const MAX_WEIGHT = 10;

/** Which neighbouring pair (k, k + 1) to swap, 1-based, or null for no swap. */
export function chooseSwap(random: () => number, shown: number): number | null {
  if (shown < 2 || random() >= SWAP_SHARE) return null;
  return 1 + Math.floor(random() * (Math.min(SWAP_DEPTH, shown) - 1));
}

/** The results as shown: `k` and `k + 1` exchanged when a swap was chosen. */
export function applySwap<T>(items: readonly T[], k: number | null): T[] {
  const out = [...items];
  if (k === null || k < 1 || k >= out.length) return out;
  const a = out[k - 1];
  const b = out[k];
  if (a === undefined || b === undefined) return out;
  out[k - 1] = b;
  out[k] = a;
  return out;
}

/** One logged search: for each result, where the ranker put it, where it was shown, whether it was opened. */
export interface LoggedSearch {
  /** The swapped pair's upper position, or null when nothing was swapped. */
  swap: number | null;
  results: ReadonlyArray<{ ranked: number; shown: number; clicked: boolean }>;
}

export interface Propensities {
  /** Examination chance at positions 1..20, position 1 = 1. */
  theta: number[];
  /** The fitted exponent of theta_k = k^-eta used past the measured positions. */
  eta: number;
  /** Clicks behind each measured ratio, for the model registry. */
  evidence: Array<{ pair: number; clicks: number }>;
}

/**
 * Examination by position from swapped and unswapped searches, or null when
 * there aren't yet enough clicks to measure every neighbouring pair: a model
 * then isn't trained, rather than trained on a guessed correction.
 */
export function estimatePropensities(searches: readonly LoggedSearch[], positions = 20): Propensities | null {
  const ratios: number[] = [];
  const evidence: Propensities['evidence'] = [];
  for (let k = 1; k < SWAP_DEPTH; k++) {
    // Unswapped: ranked k at k, ranked k + 1 at k + 1. Swapped at k: the other way round.
    let topStays = 0;
    let lowerStays = 0;
    let topMovesDown = 0;
    let lowerMovesUp = 0;
    for (const s of searches) {
      if (s.swap !== null && s.swap !== k) continue;
      for (const r of s.results) {
        if (!r.clicked) continue;
        if (s.swap === null) {
          if (r.ranked === k) topStays++;
          else if (r.ranked === k + 1) lowerStays++;
        } else if (r.ranked === k) topMovesDown++;
        else if (r.ranked === k + 1) lowerMovesUp++;
      }
    }
    const counts = [topStays, lowerStays, topMovesDown, lowerMovesUp];
    evidence.push({ pair: k, clicks: counts.reduce((a, b) => a + b, 0) });
    if (counts.some(c => c < MIN_CLICKS)) return null;
    // theta(k+1)/theta(k) from each result in both places; the geometric mean of the two,
    // in which the share of searches swapped and the results' attractiveness cancel.
    ratios.push(Math.sqrt((topMovesDown * lowerStays) / (topStays * lowerMovesUp)));
  }
  const measured = [1];
  for (const r of ratios) measured.push(Math.min(1, (measured.at(-1) ?? 1) * r));
  // theta_k = k^-eta through the measured points (least squares on logs, through theta_1 = 1).
  let num = 0;
  let den = 0;
  measured.forEach((t, i) => {
    const lk = Math.log(i + 1);
    num += -Math.log(Math.max(t, 1e-6)) * lk;
    den += lk * lk;
  });
  const eta = den > 0 ? Math.max(0, num / den) : 0;
  const theta = Array.from({ length: positions }, (_, i) =>
    i < measured.length ? (measured[i] ?? 1) : (i + 1) ** -eta,
  );
  return { theta, eta, evidence };
}

/** The weight of a click at a shown position: the inverse of its examination chance, clipped. */
export function clickWeight(p: Propensities, shownPosition: number): number {
  const t = p.theta[shownPosition - 1] ?? shownPosition ** -p.eta;
  return Math.min(MAX_WEIGHT, 1 / Math.max(t, 1 / MAX_WEIGHT));
}
