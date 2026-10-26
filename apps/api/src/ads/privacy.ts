// Private advertiser reporting (docs/adr/0022-advertising-platform.md part 8):
// the numbers a business may see about its campaigns, with noise that hides
// whether any one person is in them. Pure.
//
// - Each person's contribution to a cell (one campaign, one complete UTC day,
//   one breakdown value) is clipped: at most 20 impressions, 3 clicks and 1
//   conversion. A viewer Graphinity doesn't track has no identity to clip by;
//   each of their impressions counts as its own.
// - Each released number gets Laplace noise of scale Δ/ε, drawn from a
//   generator seeded by HMAC-SHA256(secret, cell and metric): asking again
//   gives the same number, so averaging repeated answers removes nothing.
// - A cell is shown only with at least 25 different people behind it and at
//   least 50 impressions after noise; otherwise it is suppressed.
// - Releasing a breakdown of a campaign's day costs privacy budget once (the
//   days in one report are disjoint, so they compose in parallel); a business
//   has 2.0 of ε each UTC day.
import { createHmac } from 'node:crypto';

export const CLIP = { impressions: 20, clicks: 3, conversions: 1 } as const;
export type Metric = keyof typeof CLIP;
export const METRICS: readonly Metric[] = ['impressions', 'clicks', 'conversions'];
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
  Math.round(METRICS.length * EPSILON_PER_METRIC * cellsPerPerson(breakdown, audiences) * 1000) / 1000;

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
export function noisyCount(count: number, metric: Metric, secret: Buffer, cellKey: string): number {
  const scale = CLIP[metric] / EPSILON_PER_METRIC;
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

/** Noised cells that clear the floors; the rest are counted as suppressed, never shown. */
export function privateCells(
  campaign: string,
  breakdown: Breakdown,
  cells: readonly TrueCell[],
  secret: Buffer,
): { cells: ShownCell[]; suppressed: number } {
  const shown: ShownCell[] = [];
  let suppressed = 0;
  for (const c of cells) {
    const key = cellKey(campaign, breakdown, c.day, c.value);
    const impressions = noisyCount(c.impressions, 'impressions', secret, key);
    if (c.people < MIN_PEOPLE || impressions < MIN_IMPRESSIONS) {
      suppressed += 1;
      continue;
    }
    shown.push({
      value: c.value,
      day: c.day,
      impressions,
      clicks: noisyCount(c.clicks, 'clicks', secret, key),
      conversions: noisyCount(c.conversions, 'conversions', secret, key),
    });
  }
  return { cells: shown, suppressed };
}
