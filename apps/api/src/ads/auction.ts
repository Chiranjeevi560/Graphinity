// The ad auction (docs/adr/0022-advertising-platform.md part 4): pure and
// deterministic. Candidates are ranked by expected value per impression,
// bid x predicted click rate (eCPM / 1000), and the top `slots` win. Each
// winner pays per click the generalized second price (Edelman, Ostrovsky &
// Schwarz 2007; Varian 2007): the least that would still have kept its
// place, i.e. the next ad's value divided by its own click rate, plus one
// micro-unit, never above its own bid and never below the reserve. Ties
// break by campaign id, so the same inputs always give the same result.
//
// Predicted click rates come from each campaign's history shrunk toward a
// prior (empirical Bayes with a Beta prior): a new campaign isn't judged on
// two impressions. A learned model replaces the prior's role in part 5.

export interface Candidate {
  campaignId: string;
  creativeId: string;
  /** The most it pays for a click, in micro-units. */
  maxCpcMicros: number;
  /** Predicted probability of a click on this impression. */
  ctr: number;
}

export interface Win {
  campaignId: string;
  creativeId: string;
  /** What a click on this impression costs, in micro-units. */
  priceMicros: number;
  /** Expected value per impression, in micro-units. */
  value: number;
  ctr: number;
}

export interface AuctionRules {
  slots: number;
  /** The least a click can cost, in micro-units. */
  reserveMicros: number;
}

const value = (c: Candidate) => c.maxCpcMicros * c.ctr;

/** Higher value first; then a higher bid; then campaign id, for determinism. */
function compare(a: Candidate, b: Candidate): number {
  return (
    value(b) - value(a) ||
    b.maxCpcMicros - a.maxCpcMicros ||
    (a.campaignId < b.campaignId ? -1 : a.campaignId > b.campaignId ? 1 : 0)
  );
}

export function runAuction(candidates: readonly Candidate[], rules: AuctionRules): Win[] {
  // Below the reserve, or with no chance of a click: not in the auction at all.
  const eligible = candidates
    .filter(c => c.maxCpcMicros >= rules.reserveMicros && c.ctr > 0 && Number.isFinite(c.ctr))
    .sort(compare);
  // One ad per campaign: its best creative.
  const seen = new Set<string>();
  const ranked = eligible.filter(c => !seen.has(c.campaignId) && seen.add(c.campaignId));
  const wins: Win[] = [];
  for (let i = 0; i < Math.min(rules.slots, ranked.length); i++) {
    const c = ranked[i];
    if (!c) break;
    const next = ranked[i + 1];
    // The price at which this ad's value would equal the next one's, plus one unit.
    const second = next ? Math.floor(value(next) / c.ctr) + 1 : rules.reserveMicros;
    wins.push({
      campaignId: c.campaignId,
      creativeId: c.creativeId,
      priceMicros: Math.min(c.maxCpcMicros, Math.max(rules.reserveMicros, second)),
      value: value(c),
      ctr: c.ctr,
    });
  }
  return wins;
}

/**
 * A campaign's click rate, shrunk toward the placement's prior: the mean of
 * Beta(prior * strength + clicks, (1 - prior) * strength + impressions - clicks).
 * strength is how many impressions the prior is worth.
 */
export function shrunkCtr(clicks: number, impressions: number, prior: number, strength: number): number {
  const c = Math.max(0, Math.min(clicks, impressions));
  return (prior * strength + c) / (strength + Math.max(0, impressions));
}

/**
 * Budget pacing: whether a campaign may take part now, so its day's budget
 * lasts the day instead of going in the first hour. Spend may run ahead of
 * the day's elapsed share by `slack` (so a quiet morning doesn't starve it);
 * beyond that it sits out until time catches up. Never past the budget.
 */
export function paced(spentMicros: number, dailyBudgetMicros: number, dayFraction: number, slack = 0.1): boolean {
  if (spentMicros >= dailyBudgetMicros) return false;
  // Whole micro-units: in floating point 0.05 + 0.1 is just over 0.15, which let spend at the limit through.
  const allowed = Math.floor(Math.min(1, Math.max(0, dayFraction) + slack) * dailyBudgetMicros + 1e-6);
  return spentMicros < allowed;
}
