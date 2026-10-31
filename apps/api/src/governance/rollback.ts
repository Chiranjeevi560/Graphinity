// The rollout governor (docs/adr/0028-rollout-governor.md): four rings of exposure, and a rule that
// turns a switch off when requests go bad. Deciding from numbers means nobody has to be awake.
import { murmur3 } from '../experiments/murmur.ts';

/** Percent of people in each ring. */
export const RINGS = [1, 5, 25, 100] as const;
export const MAX_ERROR_RATE = 0.01;
export const MAX_P95_MS = 500;
/** Fewer requests in five minutes than this can't show a slowdown. */
export const MIN_REQUESTS_FOR_LATENCY = 30;

/** Whether a person falls inside a ring: the same answer each time, independent between switches. */
export function inRing(flag: string, unit: string, ring: number): boolean {
  return murmur3(`${unit}:rollout:${flag}`) % 100 < (RINGS[ring] ?? 100);
}

export interface Health {
  requests: number;
  errors: number;
  p95Ms: number | null;
}

/**
 * One-sided z ≥ 3.3 over the error limit, so a handful of errors at night
 * doesn't turn anything off (a plain rate would trip on 1 error in 50 requests).
 */
export function shouldTrip(h: Health): boolean {
  if (h.requests === 0) return false;
  const se = Math.sqrt((MAX_ERROR_RATE * (1 - MAX_ERROR_RATE)) / h.requests);
  if ((h.errors / h.requests - MAX_ERROR_RATE) / se >= 3.3) return true;
  return h.requests >= MIN_REQUESTS_FOR_LATENCY && h.p95Ms !== null && h.p95Ms > MAX_P95_MS;
}
