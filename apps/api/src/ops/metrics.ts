// Request metrics (docs/adr/0020-observability.md): per route pattern and
// method, how many requests, how many failed on our side (5xx), and how long
// they took, kept as a fixed-bucket latency histogram so minutes and routes
// merge by adding. Nothing about who asked or what: the route pattern only,
// never the URL. Recording is O(log buckets) with no allocation after a
// route's first request; a flush hands over the minute's counts and starts
// afresh.

import { valueAt } from '../ml/linalg.ts';

/**
 * Upper bounds in ms: 1 ms times powers of the square root of 2, up to 15 s
 * (29 bounds); the last bucket is everything above. Measured against 1-2-5
 * and finer layouts (scripts/benchmark-ops.mjs, ADR 0020): half the
 * percentile error of 1-2-5 at about twice its size, where finer steps cost
 * storage the free database can't spare for little more.
 */
export const BUCKETS_MS: readonly number[] = (() => {
  const out: number[] = [];
  for (let x = 1; x < 15_000; x *= Math.SQRT2) out.push(Math.round(x * 1000) / 1000);
  out.push(15_000);
  return out;
})();

export interface RouteMinute {
  route: string;
  method: string;
  requests: number;
  /** Status 500 and above: our failures. */
  errors: number;
  /** Requests over the latency threshold (LATENCY_SLO_MS). */
  slow: number;
  totalMs: number;
  /** BUCKETS_MS.length + 1 counts: request i lands in the first bucket whose bound is >= its time. */
  buckets: number[];
}

export const LATENCY_SLO_MS = 500;

export function bucketOf(ms: number): number {
  let lo = 0;
  let hi = BUCKETS_MS.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    // mid < BUCKETS_MS.length, so the read is inside the bounds.
    if (ms <= valueAt(BUCKETS_MS, mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * The q-quantile of a histogram, interpolated linearly within its bucket
 * (as Prometheus' histogram_quantile does). The open last bucket reports its
 * lower bound: "at least 15 s". Null for an empty histogram.
 */
export function quantileOf(buckets: readonly number[], q: number): number | null {
  const total = buckets.reduce((s, c) => s + c, 0);
  if (total === 0) return null;
  const target = q * total;
  let seen = 0;
  for (let i = 0; i < buckets.length; i++) {
    const c = valueAt(buckets, i);
    if (seen + c >= target && c > 0) {
      const lower = valueAt(BUCKETS_MS, i - 1);
      const upper = BUCKETS_MS[i];
      if (upper === undefined) return lower;
      return lower + (upper - lower) * ((target - seen) / c);
    }
    seen += c;
  }
  return BUCKETS_MS[BUCKETS_MS.length - 1] ?? null;
}

/** Adds histograms of equal length. */
export function mergeBuckets(into: number[], from: readonly number[]): number[] {
  for (let i = 0; i < from.length; i++) into[i] = valueAt(into, i) + valueAt(from, i);
  return into;
}

export interface MetricsRecorder {
  record(route: string, method: string, status: number, ms: number): void;
  /** This minute's counts, then empty. */
  flush(): RouteMinute[];
}

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const ROUTE_PATTERN = /^(\/[A-Za-z0-9:_*.-]*)+$/;

/**
 * Route patterns and methods as the database accepts them (migration 0027):
 * anything else would make the whole minute's save fail, so it is counted
 * as 'unmatched' / 'OTHER' instead.
 */
export const normalRoute = (route: string) => (route.length <= 200 && ROUTE_PATTERN.test(route) ? route : 'unmatched');
export const normalMethod = (method: string) => (METHODS.has(method) ? method : 'OTHER');

export function createRecorder(): MetricsRecorder {
  let current = new Map<string, RouteMinute>();
  return {
    record(rawRoute, rawMethod, status, ms) {
      const route = normalRoute(rawRoute);
      const method = normalMethod(rawMethod);
      const key = `${method} ${route}`;
      let m = current.get(key);
      if (!m) {
        m = {
          route,
          method,
          requests: 0,
          errors: 0,
          slow: 0,
          totalMs: 0,
          buckets: new Array<number>(BUCKETS_MS.length + 1).fill(0),
        };
        current.set(key, m);
      }
      m.requests++;
      if (status >= 500) m.errors++;
      if (ms > LATENCY_SLO_MS) m.slow++;
      m.totalMs += ms;
      const b = bucketOf(ms);
      m.buckets[b] = valueAt(m.buckets, b) + 1;
    },
    flush() {
      const out = [...current.values()];
      current = new Map();
      return out;
    },
  };
}
