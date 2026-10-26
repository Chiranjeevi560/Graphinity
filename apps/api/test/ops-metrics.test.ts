import { describe, expect, it } from 'vitest';
import { gaussian, seededRandom } from '../src/ml/linalg.ts';
import { BUCKETS_MS, bucketOf, createRecorder, LATENCY_SLO_MS, mergeBuckets, quantileOf } from '../src/ops/metrics.ts';
import {
  budgetRemaining,
  BURN_RULES,
  burnRate,
  firingAlerts,
  MIN_REQUESTS,
  OBJECTIVES,
  type Window,
} from '../src/ops/slo.ts';

describe('latency histograms', () => {
  it('put a time in the first bucket whose bound covers it', () => {
    expect(bucketOf(0)).toBe(0);
    expect(bucketOf(1)).toBe(0);
    expect(bucketOf(1.01)).toBe(1);
    expect(BUCKETS_MS).toHaveLength(29);
    // Each bound about the square root of 2 above the last.
    for (let i = 1; i < BUCKETS_MS.length - 1; i++)
      expect((BUCKETS_MS[i] ?? 0) / (BUCKETS_MS[i - 1] ?? 1)).toBeCloseTo(Math.SQRT2, 2);
    expect(bucketOf(15_000)).toBe(BUCKETS_MS.length - 1);
    expect(bucketOf(15_001)).toBe(BUCKETS_MS.length);
  });

  it('estimate quantiles within their bucket, never outside it (1,000 random cases)', () => {
    const g = gaussian(seededRandom(3));
    for (let t = 0; t < 1000; t++) {
      const times = Array.from({ length: 200 }, () => Math.exp(4 + 1.2 * g()));
      const buckets = new Array<number>(BUCKETS_MS.length + 1).fill(0);
      for (const ms of times) buckets[bucketOf(ms)] = (buckets[bucketOf(ms)] ?? 0) + 1;
      const sorted = [...times].sort((a, b) => a - b);
      for (const q of [0.5, 0.95, 0.99]) {
        const exact = sorted[Math.ceil(q * sorted.length) - 1] ?? 0;
        const estimate = quantileOf(buckets, q) ?? -1;
        const b = bucketOf(exact);
        const lower = b === 0 ? 0 : (BUCKETS_MS[b - 1] ?? 0);
        const upper = BUCKETS_MS[b] ?? Infinity;
        // The estimate lands in the exact quantile's bucket (or reports the open bucket's lower bound).
        expect(estimate).toBeGreaterThanOrEqual(lower);
        expect(estimate).toBeLessThanOrEqual(upper === Infinity ? lower : upper);
      }
    }
  });

  it('interpolate exactly within a bucket and report nothing for no requests', () => {
    const buckets = new Array<number>(BUCKETS_MS.length + 1).fill(0);
    const i = bucketOf(80);
    const [lo, hi] = [BUCKETS_MS[i - 1] ?? 0, BUCKETS_MS[i] ?? 0];
    buckets[i] = 10; // all in (lo, hi]
    expect(quantileOf(buckets, 0.5)).toBeCloseTo((lo + hi) / 2, 9);
    expect(quantileOf(buckets, 1)).toBe(hi);
    expect(quantileOf(new Array<number>(BUCKETS_MS.length + 1).fill(0), 0.5)).toBeNull();
    const open = new Array<number>(BUCKETS_MS.length + 1).fill(0);
    open[BUCKETS_MS.length] = 3;
    expect(quantileOf(open, 0.99)).toBe(15_000);
  });

  it('merge by adding', () => {
    expect(mergeBuckets([1, 2], [3, 4])).toEqual([4, 6]);
    expect(mergeBuckets([], [3, 4])).toEqual([3, 4]);
  });
});

describe('the recorder', () => {
  it('counts per method and route, our failures and slow requests, and starts afresh on flush', () => {
    const r = createRecorder();
    r.record('/questions/:id', 'GET', 200, 12);
    r.record('/questions/:id', 'GET', 503, LATENCY_SLO_MS + 1);
    r.record('/questions/:id', 'GET', 404, LATENCY_SLO_MS);
    r.record('/questions/:id', 'POST', 201, 30);
    const rows = r.flush().sort((a, b) => a.method.localeCompare(b.method));
    expect(rows.map(x => [x.method, x.requests, x.errors, x.slow])).toEqual([
      ['GET', 3, 1, 1],
      ['POST', 1, 0, 0],
    ]);
    expect(rows[0]?.totalMs).toBe(12 + LATENCY_SLO_MS + 1 + LATENCY_SLO_MS);
    expect(rows[0]?.buckets.reduce((s, c) => s + c, 0)).toBe(3);
    expect(r.flush()).toEqual([]);
  });

  it('counts routes and methods the database wouldn’t accept as unmatched and other', () => {
    const r = createRecorder();
    r.record('/search?q=passport', 'BREW', 200, 1);
    r.record(`/${'a'.repeat(200)}`, 'GET', 200, 1);
    r.record('/questions/:id', 'GET', 200, 1);
    expect(r.flush().map(x => [x.method, x.route, x.requests])).toEqual([
      ['OTHER', 'unmatched', 1],
      ['GET', 'unmatched', 1],
      ['GET', '/questions/:id', 1],
    ]);
  });
});

describe('SLOs', () => {
  const availability = OBJECTIVES.find(o => o.name === 'availability')?.target ?? 0;

  it('burn at 1 when failing exactly at the budget, and 0 with no requests', () => {
    expect(burnRate({ requests: 1000, bad: 5 }, availability)).toBeCloseTo(1, 12);
    expect(burnRate({ requests: 0, bad: 0 }, availability)).toBe(0);
    expect(budgetRemaining({ requests: 1000, bad: 5 }, availability)).toBeCloseTo(0, 12);
    expect(budgetRemaining({ requests: 0, bad: 0 }, availability)).toBe(1);
    expect(budgetRemaining({ requests: 1000, bad: 10 }, availability)).toBeCloseTo(-1, 12);
  });

  it('page only when both windows burn fast, and say which rule fired', () => {
    // 10% failing in the last hour and the last 5 minutes: burn 20 against the 14.4 page rule.
    const windows =
      (badShare: { short: number; long: number }) =>
      (o: string, minutes: number): Window =>
        o !== 'availability'
          ? { requests: 1000, bad: 0 }
          : { requests: 1000, bad: 1000 * (minutes <= 5 ? badShare.short : badShare.long) };
    const firing = firingAlerts(windows({ short: 0.1, long: 0.1 }));
    expect(firing[0]).toMatchObject({ objective: 'availability', severity: 'page', long: 60, short: 5 });
    // Already over: the long window burned, the short one has recovered.
    expect(firingAlerts(windows({ short: 0, long: 0.1 })).filter(a => a.long === 60)).toEqual([]);
    // Nothing wrong.
    expect(firingAlerts(windows({ short: 0, long: 0 }))).toEqual([]);
  });

  it('stays quiet on too few requests to mean anything', () => {
    const windowOf = (): Window => ({ requests: MIN_REQUESTS - 1, bad: MIN_REQUESTS - 1 });
    expect(firingAlerts(windowOf)).toEqual([]);
    const enough = (): Window => ({ requests: MIN_REQUESTS, bad: MIN_REQUESTS });
    expect(firingAlerts(enough).length).toBe(BURN_RULES.length * OBJECTIVES.length);
  });

  it('list pages before tickets', () => {
    const all = firingAlerts(() => ({ requests: 1000, bad: 1000 }));
    const firstTicket = all.findIndex(a => a.severity === 'ticket');
    expect(all.slice(0, firstTicket).every(a => a.severity === 'page')).toBe(true);
    expect(all.slice(firstTicket).every(a => a.severity === 'ticket')).toBe(true);
  });
});
