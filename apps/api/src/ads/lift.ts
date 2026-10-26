// Incrementality (docs/adr/0022-advertising-platform.md part 6b): what a
// campaign truly adds, from a randomized holdout. A small random share of
// the people a campaign would reach are held out (its ads not shown to them,
// "ghost ads": Johnson, Lewis & Nubbemeyer 2017), and the two groups'
// conversion rates are compared. Randomization makes the groups alike in
// everything else, intent included, which no model of observed paths can
// guarantee (benchmark: every such model over-credits retargeting).
// Pure: counts in, lift and its 95% interval out.

export interface LiftCounts {
  exposedPeople: number;
  exposedConversions: number;
  holdoutPeople: number;
  holdoutConversions: number;
}

export interface Lift {
  /** Conversion-rate difference, exposed minus held out. */
  absolute: number;
  low: number;
  high: number;
  /** Conversions the campaign caused among the exposed: absolute x exposed people. */
  incremental: number;
  /** Whether the interval excludes zero. */
  significant: boolean;
}

/** Two-proportion difference with a normal-approximation 95% interval; null without enough of both groups. */
export function lift(c: LiftCounts, minPerGroup = 100): Lift | null {
  if (c.exposedPeople < minPerGroup || c.holdoutPeople < minPerGroup) return null;
  const p1 = c.exposedConversions / c.exposedPeople;
  const p0 = c.holdoutConversions / c.holdoutPeople;
  const se = Math.sqrt((p1 * (1 - p1)) / c.exposedPeople + (p0 * (1 - p0)) / c.holdoutPeople);
  const absolute = p1 - p0;
  const low = absolute - 1.96 * se;
  const high = absolute + 1.96 * se;
  return { absolute, low, high, incremental: absolute * c.exposedPeople, significant: low > 0 || high < 0 };
}

/**
 * Whether this person is held out of this campaign: a stable hash of both,
 * below `share`, so the same person is always in the same group for a
 * campaign, and groups don't follow anything about them.
 */
export function heldOut(hash32: number, share: number): boolean {
  return hash32 / 0x1_0000_0000 < share;
}
