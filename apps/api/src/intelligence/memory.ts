// Three kinds of memory (master charter §10.3), all consent-gated in the database:
// episodic (what happened this visit, fading by Ebbinghaus R(t) = e^(−t/S)), semantic
// (lasting topic affinities, consolidated from strong episodes) and procedural
// (preferences such as units and depth). Pure rules here; storage in migration 0044.

export interface Episode {
  key: string;
  /** Ms since epoch. */
  at: number;
  strength: number;
  /** Times reinforced; each stretches how long it lasts. */
  reviews: number;
}

export const BASE_STABILITY_MS = 6 * 3_600_000;

export const stability = (reviews: number) => BASE_STABILITY_MS * 2 ** Math.min(10, reviews);
export const retention = (e: Episode, now: number) =>
  e.strength * Math.exp(-Math.max(0, now - e.at) / stability(e.reviews));

export const FORGET_BELOW = 0.05;
export const CONSOLIDATE_REVIEWS = 3;

/** What's remembered still, what's now lasting, and what's forgotten. */
export function sweepEpisodes(episodes: readonly Episode[], now: number) {
  const keep: Episode[] = [];
  const consolidate: string[] = [];
  let forgotten = 0;
  for (const e of episodes) {
    if (e.reviews >= CONSOLIDATE_REVIEWS) consolidate.push(e.key);
    if (retention(e, now) < FORGET_BELOW) forgotten += 1;
    else keep.push(e);
  }
  return { keep, consolidate, forgotten };
}

const PREFERENCES: Readonly<Record<string, ReadonlySet<string>>> = {
  depth: new Set(['brief', 'detailed']),
  currency: new Set(['INR', 'USD', 'EUR', 'GBP']),
  units: new Set(['metric', 'imperial']),
  cadence: new Set(['instant', 'daily', 'weekly']),
};

export const validPreference = (name: string, value: string) => PREFERENCES[name]?.has(value) === true;
