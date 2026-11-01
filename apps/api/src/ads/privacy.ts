// Private advertiser reporting (docs/adr/0022-advertising-platform.md part 8):
// the numbers a business may see about its campaigns, with noise that hides
// whether any one person is in them. Pure.
//
// - Each person's contribution to a cell (one campaign, one complete UTC day,
//   one breakdown value) is clipped: at most 20 impressions, 3 clicks and 1
//   conversion. A viewer Graphinity doesn't track has no identity to clip by;
//   each of their impressions counts as its own.
// - Each released number gets Laplace noise of scale Δ·days/ε: one person can be in
//   every day of a report, so its days share the charge rather than each having it.
// - Every read costs and draws fresh noise (a per-read value in the seed). Reusing noise
//   would let a business subtract two reads and see exactly who withdrew between them.
// - A cell is shown only with a noised count past 25 people plus a margin for its noise, and 50
//   impressions after noise. Hidden cells aren't
//   counted: an exact count would say whether anyone at all saw the ad.
// - A business has 2.0 of ε each UTC day and 12.0 in any 30 days.
import { createHmac } from 'node:crypto';

export const CLIP = { impressions: 20, clicks: 3, conversions: 1 } as const;
export type Metric = keyof typeof CLIP;
export const METRICS: readonly Metric[] = ['impressions', 'clicks', 'conversions'];
/** ε for the noised count of people that decides a cell's floor. Larger: only the threshold depends on it. */
export const EPSILON_FLOOR = 0.4;
/** ε for each released metric of a cell. */
export const EPSILON_PER_METRIC = 0.2;
/** A business's daily budget (charter §3.3: ε_max = 2.0; δ stays 0, Laplace is pure ε-DP). */
export const EPSILON_DAILY = 2.0;
export const MIN_PEOPLE = 25;
export const MIN_IMPRESSIONS = 50;

export type Breakdown = 'day' | 'country' | 'placement' | 'audience';
export const BREAKDOWNS: readonly Breakdown[] = ['day', 'country', 'placement', 'audience'];

/**
 * How many cells of one campaign-day a single person can appear in, under a breakdown: one
 * day and one country each; both placements; any of the campaign's targeted audiences.
 */
export function cellsPerPerson(breakdown: Breakdown, audiences: number): number {
  if (breakdown === 'placement') return 2;
  if (breakdown === 'audience') return Math.max(1, audiences);
  return 1;
}

/** What releasing one breakdown of a campaign's days costs, in ε (to the ledger's 3 decimals). */
export const releaseCost = (breakdown: Breakdown, audiences: number) =>
  Math.round((METRICS.length * EPSILON_PER_METRIC + EPSILON_FLOOR) * cellsPerPerson(breakdown, audiences) * 1000) /
  1000;

/** A uniform number in (0, 1) from a cell's key: 53 bits of HMAC-SHA256. */
export function cellUniform(secret: Buffer, key: string): number {
  const h = createHmac('sha256', secret).update(key).digest();
  // 53 bits: 21 from the first word, 32 from the second.
  const hi = h.readUInt32BE(0) >>> 11;
  const lo = h.readUInt32BE(4);
  return (hi * 2 ** 32 + lo + 0.5) / 2 ** 53;
}

/** Laplace(0, scale) by the inverse CDF, from a uniform u in (0, 1). */
export function laplace(scale: number, u: number): number {
  const d = u - 0.5;
  return -scale * Math.sign(d) * Math.log(1 - 2 * Math.abs(d));
}

/** A count with its cell's noise: never negative, a whole number. */
export function noisyCount(count: number, metric: Metric, secret: Buffer, cellKey: string, days = 1): number {
  const scale = (CLIP[metric] * days) / EPSILON_PER_METRIC;
  return Math.max(0, Math.round(count + laplace(scale, cellUniform(secret, `${cellKey}\u0000${metric}`))));
}

export interface TrueCell {
  /** The breakdown value: a date (YYYY-MM-DD), a country, a placement or an audience id. */
  value: string;
  day: string;
  people: number;
  impressions: number;
  clicks: number;
  conversions: number;
}

export interface ShownCell {
  value: string;
  day: string;
  impressions: number;
  clicks: number;
  conversions: number;
}

/** The canonical key of a cell: what its noise is seeded by. */
export const cellKey = (campaign: string, breakdown: Breakdown, day: string, value: string) =>
  ['v1', campaign, breakdown, day, value].join('\u0000');

/** Chance a cell far below the floor gets past it on noise alone. */
export const FLOOR_DELTA = 1e-6;
/**
 * The noised count a floor must clear: the floor plus a margin that grows with the noise. Without it, noise wide enough
 * for a long report would let a one-person cell through, and an empty cell never exists, so its row proves someone was there.
 */
export const noisyFloor = (scale: number) => MIN_PEOPLE + scale * Math.log(1 / (2 * FLOOR_DELTA));

/** Noised cells that clear the floors. `read` is new for every read, `days` is how many the report covers. */
export function privateCells(
  campaign: string,
  breakdown: Breakdown,
  cells: readonly TrueCell[],
  secret: Buffer,
  read: string,
  days: number,
): ShownCell[] {
  const shown: ShownCell[] = [];
  for (const c of cells) {
    const key = `${cellKey(campaign, breakdown, c.day, c.value)}\u0000${read}`;
    const impressions = noisyCount(c.impressions, 'impressions', secret, key, days);
    const scale = days / EPSILON_FLOOR;
    const people = c.people + laplace(scale, cellUniform(secret, `${key}\u0000people`));
    if (people < noisyFloor(scale) || impressions < MIN_IMPRESSIONS) continue;
    shown.push({
      value: c.value,
      day: c.day,
      impressions,
      clicks: noisyCount(c.clicks, 'clicks', secret, key, days),
      conversions: noisyCount(c.conversions, 'conversions', secret, key, days),
    });
  }
  return shown;
}
