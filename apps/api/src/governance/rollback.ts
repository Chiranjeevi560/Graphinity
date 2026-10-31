// The auto-rollback governor (four rings of exposure). A release moves from staff to 1%,
// 10% and 100% only while its error rate and latency hold against the baseline;
// otherwise it's rolled back. Pure and deterministic; deciding from numbers means
// nobody has to be awake.

export const RINGS = [
  { name: 'staff', traffic: 0, minRequests: 50 },
  { name: 'canary', traffic: 0.01, minRequests: 500 },
  { name: 'early', traffic: 0.1, minRequests: 5_000 },
  { name: 'general', traffic: 1, minRequests: 0 },
] as const;

export interface RingHealth {
  requests: number;
  errors: number;
  p95Ms: number;
}

export type Decision = 'hold' | 'advance' | 'rollback';

/** Rolls back on a clear error excess (one-sided z ≥ 3.3 over baseline plus 0.1%) or p95 over 1.5×. */
export function decideRing(ring: number, health: RingHealth, baseline: { errorRate: number; p95Ms: number }): Decision {
  if (health.requests === 0) return 'hold';
  const limit = baseline.errorRate + 0.001;
  const rate = health.errors / health.requests;
  const se = Math.sqrt(Math.max(limit * (1 - limit), 1e-9) / health.requests);
  if ((rate - limit) / se >= 3.3) return 'rollback';
  const min = RINGS[ring]?.minRequests ?? 0;
  if (health.requests >= Math.max(30, min) && health.p95Ms > baseline.p95Ms * 1.5) return 'rollback';
  if (ring >= RINGS.length - 1 || health.requests < min) return 'hold';
  return 'advance';
}
