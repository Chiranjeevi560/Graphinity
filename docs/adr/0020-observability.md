# ADR 0020: Request metrics, SLOs and job health, at no cost

- **Status:** Accepted and built 2026-10-26. The operations screen is built; alert delivery follows
  in its own change.

## Problem

- **No aggregate view:** the server logged one line per request (route pattern, status, time) and
  nothing added them up. Nobody could say how fast Graphinity answers, how often it fails, or
  whether that is getting worse.
- **Silent job failures:** background jobs (routing, training, deletions, collusion review, drift)
  logged a warning when they failed and nothing more. A job that stopped running made no sound at
  all.
- **Free-tier limits:** paid monitoring services are out (zero cost). The free instance sleeps when
  idle, so anything kept in memory is lost every few minutes of quiet.

## Decision

**Recording** (`src/ops/metrics.ts`):

- Every response is counted by route pattern (never the URL) and method.
- Each count records the requests, failures on our side (5xx), requests over 500 ms, total time,
  and a latency histogram.
- Unknown methods count as `OTHER`, and patterns the database wouldn't accept count as
  `unmatched`, so one odd request can never make a minute's save fail.
- Cost: 166 ns per request, no allocation after a route's first request.

**Histogram layout:** 29 bounds, 1 ms times powers of √2 up to 15 s, plus an open bucket. Measured
on log-normal latencies, 300 requests a minute, worst relative error against exact:

| Layout | Buckets | p50 | p95 | p99 | Mean p95 error |
|---|---|---|---|---|---|
| 1-2-5 per decade | 13 | 13% | 35% | 52% | 11% |
| **√2 steps (built)** | 29 | 9% | 17% | 34% | 5% |
| 2^(1/3) steps | 43 | 5% | 13% | 26% | 3% |
| 2^(1/4) steps | 57 | 5% | 11% | 18% | 2% |

- p99 of 300 requests rests on its top three values, so no layout makes it exact.
- Finer steps cost storage the free database can't spare.
- The SLO doesn't depend on the histogram at all: it counts requests over 500 ms exactly.

**Storage** (migration 0027):

- Once a minute, one statement adds the minute's counts into `app.ops_minutes` (several flushes in
  one minute add up).
- After 48 hours, minutes are added into UTC hours (`span` 60); hours are kept 35 days. A test
  caught truncation in the session's time zone splitting hours at half past in India.
- Worst case at 40 busy routes: about 21 MB of minutes plus 6 MB of hours, inside Supabase's free
  500 MB.
- Only the server writes; moderators and the server read. Not even the server may delete a minute
  younger than 48 hours or an hour younger than 35 days.

**SLOs** (`src/ops/slo.ts`), over 30 days, every route but the live stream:

- **Availability:** 99.5% of requests don't fail on our side.
- **Latency:** 95% finish within 500 ms.
- Why these targets: the free tier is one instance that sleeps when idle and takes tens of seconds
  to wake. Promising more would be a promise it can't keep.

**Burn-rate alerts:** the Google SRE workbook's multiwindow, multi-burn-rate rules for a 30-day
budget:

- **Page:** burn ≥ 14.4 over 1 hour and 5 minutes, or ≥ 6 over 6 hours and 30 minutes.
- **Ticket:** burn ≥ 3 over 1 day and 2 hours, or ≥ 1 over 3 days and 6 hours.
- **Quiet below 50 requests** in the long window: one failure in three requests isn't an outage.
  This is the workbook's known limit for low-traffic services.

**Job health:**

- Every background job runs through `recordedRun`, which records start, success, or failure with
  the error's class name (never its message).
- A job is unhealthy when its last run failed, or when it hasn't succeeded within twice its
  expected interval.

**Reading:** `GET /ops/status`, for moderators, returns:

- each objective's 30-day good share, budget left, and burn over the last hour and day;
- the alerts firing now;
- the 20 slowest routes over the last day (p50, p95, p99);
- every job's health.

**The screen:** Operations, for moderators (Profile → Operations), says it in plain words:

- whether everything is within its objectives, and if not, what's wrong and what to do;
- each objective's 30 days, with the allowance left;
- each background job by what it does ("Sending questions to people"), with when it last worked or
  failed;
- the slowest requests today.

Every row stacks the name over its figures, so nothing wraps raggedly at phone widths.

## Performance and scale

- **Per request:** a map lookup and a binary search over 29 bounds.
- **Per minute:** one insert of at most one row per active route, then one compaction statement
  that touches only the minutes crossing the 48-hour line.
- **Status:** one scan of 35 days of rows with eight filtered sums (an index on `minute`), plus a
  day of rows for route percentiles.
- **At larger scale:** with many instances, each flushes its own counts and the same rows add up.
  Histograms merge by addition, which is why they are fixed buckets and not per-instance sketches.

## Not built here, and why

- **Distributed tracing:** one process with one database. `Server-Timing` already breaks a search
  down (ADR 0015). A tracing backend would be a paid or self-hosted service.
- **External uptime checks:** they need an outside service. The owner can add a free one (the
  runbook says how), which also wakes the instance.
