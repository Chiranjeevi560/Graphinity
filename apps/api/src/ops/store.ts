// Persisting and reading operations data (docs/adr/0020-observability.md,
// migration 0027). The server flushes its request counts once a minute in
// one statement; each background job records its runs; the operations page
// reads SLO windows, burn rates, the slowest routes and job health back. All
// as the system, or as a moderator for reading.
import type { Database, Queryable } from '../db.ts';
import { errorKind } from '../jobs.ts';
import { mergeBuckets, quantileOf, type RouteMinute } from './metrics.ts';
import {
  budgetRemaining,
  burnRate,
  EXCLUDED_ROUTES,
  firingAlerts,
  OBJECTIVES,
  type Alert,
  type Objective,
  type Window,
} from './slo.ts';

/** Each background job as a person would say it, for the operations screen and alerts. */
export const JOB_LABELS: Readonly<Record<string, string>> = {
  deletions: 'Finishing account deletions',
  'signal-expiry': 'Forgetting expired activity',
  'route-factor-expiry': 'Forgetting old routing records',
  'search-expiry': 'Forgetting old searches',
  'graph-projection': 'Updating personal graphs',
  routing: 'Sending questions to people',
  'embedding-backfill': 'Understanding new questions',
  training: 'Training Graphinity’s own models',
  'search-judge': 'Comparing search rankings',
  'drift-monitor': 'Checking models still fit',
  'collusion-review': 'Looking for groups picking each other',
  alerts: 'Sending these alerts',
  'ad-interest-expiry': 'Forgetting old advertising interests',
  'ad-impression-expiry': 'Forgetting old ad impressions',
  'ad-partner-impression-expiry': 'Forgetting old outside-bidder impressions',
  'ad-audiences': 'Building advertising audiences',
};

export const RETENTION_DAYS = 35;
/** Minutes older than this are added into hours. */
export const MINUTE_HOURS = 48;
/** The windows the status reads, in minutes: every burn rule's, and the 30-day budget. */
export const WINDOWS = [5, 30, 60, 120, 360, 1440, 4320, 43_200] as const;

/** Adds a minute's counts (several flushes in one minute add up). One statement, at most one row per route. */
export async function saveMinute(q: Queryable, minute: Date, rows: readonly RouteMinute[]): Promise<void> {
  if (rows.length === 0) return;
  const at = new Date(Math.floor(minute.getTime() / 60_000) * 60_000);
  await q.query(
    `INSERT INTO app.ops_minutes (minute, method, route, requests, errors, slow, total_ms, buckets)
     SELECT $1, m.method, m.route, m.requests, m.errors, m.slow, m.total_ms,
            ARRAY(SELECT jsonb_array_elements_text(m.buckets)::int)
     FROM jsonb_to_recordset($2::jsonb)
       AS m(method text, route text, requests int, errors int, slow int, total_ms float8, buckets jsonb)
     ON CONFLICT (minute, span, method, route) DO UPDATE SET
       requests = app.ops_minutes.requests + EXCLUDED.requests,
       errors = app.ops_minutes.errors + EXCLUDED.errors,
       slow = app.ops_minutes.slow + EXCLUDED.slow,
       total_ms = app.ops_minutes.total_ms + EXCLUDED.total_ms,
       buckets = ARRAY(SELECT a + b FROM unnest(app.ops_minutes.buckets, EXCLUDED.buckets) AS x(a, b))`,
    [
      at,
      JSON.stringify(
        rows.map(r => ({
          method: r.method,
          route: r.route,
          requests: r.requests,
          errors: r.errors,
          slow: r.slow,
          total_ms: r.totalMs,
          buckets: r.buckets,
        })),
      ),
    ],
  );
}

/**
 * Adds minutes older than MINUTE_HOURS into their hours, then deletes them
 * and hours older than RETENTION_DAYS. One transaction (the caller's), so a
 * minute is never counted twice or lost. Returns the rows removed.
 */
export async function compactMinutes(q: Queryable): Promise<number> {
  await q.query(
    `WITH old AS (
       SELECT date_trunc('hour', minute, 'UTC') AS hour, method, route, requests, errors, slow, total_ms, buckets
       FROM app.ops_minutes WHERE span = 1 AND minute < now() - make_interval(hours => $1)
     ), counts AS (
       SELECT hour, method, route, i, sum(v)::int AS n
       FROM old, unnest(buckets) WITH ORDINALITY AS u(v, i)
       GROUP BY hour, method, route, i
     ), hours AS (
       SELECT hour, method, route, sum(requests) AS requests, sum(errors) AS errors, sum(slow) AS slow,
              sum(total_ms) AS total_ms
       FROM old GROUP BY hour, method, route
     )
     INSERT INTO app.ops_minutes (minute, span, method, route, requests, errors, slow, total_ms, buckets)
     SELECT h.hour, 60, h.method, h.route, h.requests, h.errors, h.slow, h.total_ms,
            (SELECT array_agg(c.n ORDER BY c.i) FROM counts c
             WHERE c.hour = h.hour AND c.method = h.method AND c.route = h.route)
     FROM hours h
     ON CONFLICT (minute, span, method, route) DO UPDATE SET
       requests = app.ops_minutes.requests + EXCLUDED.requests,
       errors = app.ops_minutes.errors + EXCLUDED.errors,
       slow = app.ops_minutes.slow + EXCLUDED.slow,
       total_ms = app.ops_minutes.total_ms + EXCLUDED.total_ms,
       buckets = ARRAY(SELECT a + b FROM unnest(app.ops_minutes.buckets, EXCLUDED.buckets) AS x(a, b))`,
    [MINUTE_HOURS],
  );
  const r = await q.query(
    `DELETE FROM app.ops_minutes
     WHERE (span = 1 AND minute < now() - make_interval(hours => $1)) OR minute < now() - make_interval(days => $2)`,
    [MINUTE_HOURS, RETENTION_DAYS],
  );
  return r.rowCount ?? 0;
}

/**
 * Runs a background job and records the run: started, then succeeded or
 * failed with its error's kind. The job's own errors still propagate. A
 * failure to record never hides the job's outcome.
 */
export async function recordedRun<T>(
  db: Pick<Database, 'asSystem'>,
  job: string,
  expectedSeconds: number,
  task: () => Promise<T>,
): Promise<T> {
  const mark = (sql: string, values: unknown[]) =>
    db
      .asSystem(q => q.query(sql, values))
      .then(
        () => undefined,
        () => undefined,
      );
  await mark(
    `INSERT INTO app.ops_jobs (job, expected_seconds, last_started_at, runs) VALUES ($1, $2, now(), 1)
     ON CONFLICT (job) DO UPDATE SET expected_seconds = EXCLUDED.expected_seconds, last_started_at = now(),
       runs = app.ops_jobs.runs + 1`,
    [job, expectedSeconds],
  );
  try {
    const out = await task();
    await mark('UPDATE app.ops_jobs SET last_success_at = now() WHERE job = $1', [job]);
    return out;
  } catch (err) {
    await mark(
      'UPDATE app.ops_jobs SET last_failure_at = now(), last_error_kind = $2, failures = failures + 1 WHERE job = $1',
      [job, /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(errorKind(err)) ? errorKind(err) : 'unknown'],
    );
    throw err;
  }
}

export interface JobHealth {
  job: string;
  /** What it does, in plain words. */
  label: string;
  expectedSeconds: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastErrorKind: string | null;
  runs: number;
  failures: number;
  /** No success within twice the expected interval (or ever, after that long), or the last run failed. */
  healthy: boolean;
}

export interface RouteLatency {
  method: string;
  route: string;
  requests: number;
  errors: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface OpsStatus {
  objectives: Array<{
    name: Objective['name'];
    target: number;
    /** Over the last 30 days. */
    good: number | null;
    budgetRemaining: number;
    burn: { hour: number; day: number };
  }>;
  alerts: Alert[];
  routes: RouteLatency[];
  jobs: JobHealth[];
}

/** Totals per window and objective, from one scan of the last 30 days. */
export async function loadWindows(q: Queryable): Promise<(o: Objective['name'], minutes: number) => Window> {
  const columns = WINDOWS.map(
    w => `coalesce(sum(requests) FILTER (WHERE minute >= now() - interval '${String(w)} minutes'), 0)::float8 AS r${String(w)},
          coalesce(sum(errors) FILTER (WHERE minute >= now() - interval '${String(w)} minutes'), 0)::float8 AS e${String(w)},
          coalesce(sum(slow) FILTER (WHERE minute >= now() - interval '${String(w)} minutes'), 0)::float8 AS s${String(w)}`,
  ).join(',\n');
  const row =
    (
      await q.query<Record<string, number>>(
        `SELECT ${columns} FROM app.ops_minutes
         WHERE minute >= now() - interval '${String(Math.max(...WINDOWS))} minutes' AND NOT (route = ANY($1))`,
        [[...EXCLUDED_ROUTES]],
      )
    ).rows[0] ?? {};
  return (o, minutes) => {
    const w = WINDOWS.find(x => x >= minutes) ?? Math.max(...WINDOWS);
    const requests = row[`r${String(w)}`] ?? 0;
    return { requests, bad: (o === 'availability' ? row[`e${String(w)}`] : row[`s${String(w)}`]) ?? 0 };
  };
}

export async function loadStatus(q: Queryable): Promise<OpsStatus> {
  const windowOf = await loadWindows(q);
  const objectives = OBJECTIVES.map(o => {
    const month = windowOf(o.name, 43_200);
    return {
      name: o.name,
      target: o.target,
      good: month.requests ? 1 - month.bad / month.requests : null,
      budgetRemaining: budgetRemaining(month, o.target),
      burn: { hour: burnRate(windowOf(o.name, 60), o.target), day: burnRate(windowOf(o.name, 1440), o.target) },
    };
  });
  const minutes = (
    await q.query<{ method: string; route: string; requests: number; errors: number; buckets: number[] }>(
      `SELECT method, route, requests, errors, buckets FROM app.ops_minutes WHERE minute >= now() - interval '1 day'`,
    )
  ).rows;
  const byRoute = new Map<
    string,
    { method: string; route: string; requests: number; errors: number; buckets: number[] }
  >();
  for (const m of minutes) {
    const key = `${m.method} ${m.route}`;
    const r = byRoute.get(key) ?? { method: m.method, route: m.route, requests: 0, errors: 0, buckets: [] };
    r.requests += m.requests;
    r.errors += m.errors;
    mergeBuckets(r.buckets, m.buckets);
    byRoute.set(key, r);
  }
  const routes = [...byRoute.values()]
    .filter(r => !EXCLUDED_ROUTES.has(r.route))
    .map(r => ({
      method: r.method,
      route: r.route,
      requests: r.requests,
      errors: r.errors,
      p50: quantileOf(r.buckets, 0.5),
      p95: quantileOf(r.buckets, 0.95),
      p99: quantileOf(r.buckets, 0.99),
    }))
    .sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0) || b.requests - a.requests)
    .slice(0, 20);
  const jobs = (
    await q.query<{
      job: string;
      expected_seconds: number;
      last_success_at: Date | null;
      last_failure_at: Date | null;
      last_error_kind: string | null;
      runs: string;
      failures: string;
      failing: boolean;
      stale: boolean;
    }>(
      `SELECT job, expected_seconds, last_success_at, last_failure_at, last_error_kind, runs::text, failures::text,
              coalesce(last_success_at, last_started_at) < now() - make_interval(secs => 2 * expected_seconds) AS stale,
              last_failure_at IS NOT NULL AND (last_success_at IS NULL OR last_failure_at > last_success_at) AS failing
       FROM app.ops_jobs ORDER BY job`,
    )
  ).rows.map(j => ({
    job: j.job,
    label: JOB_LABELS[j.job] ?? j.job,
    expectedSeconds: j.expected_seconds,
    lastSuccessAt: j.last_success_at?.toISOString() ?? null,
    lastFailureAt: j.last_failure_at?.toISOString() ?? null,
    lastErrorKind: j.last_error_kind,
    runs: Number(j.runs),
    failures: Number(j.failures),
    healthy: !j.stale && !j.failing,
  }));
  return { objectives, alerts: firingAlerts(windowOf), routes, jobs };
}
