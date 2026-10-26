-- Operations (docs/adr/0020-observability.md): what the server measures about
-- itself, kept where a restart can't lose it (the free instance sleeps when
-- idle). Nothing about any person: route patterns, counts and times; job
-- names and outcomes. Written by the server's own jobs; read by them and by
-- moderators, whose operations page shows it.

-- Per minute, route pattern and method: requests, failures on our side,
-- requests over the latency objective, total time and a latency histogram
-- (src/ops/metrics.ts BUCKETS_MS). After 48 hours minutes are added into
-- hours (span 60); hours are kept 35 days: the 30-day SLO window and a
-- margin. At 40 busy routes that is at most about 27 MB.
CREATE TABLE IF NOT EXISTS app.ops_minutes (
  minute    timestamptz NOT NULL CHECK (minute = date_trunc('minute', minute)),
  -- Minutes covered: 1, or 60 for an hour rolled up (starting on the UTC hour, whatever the
  -- session's time zone: in India's +5:30 a local hour starts at half past).
  span      smallint NOT NULL DEFAULT 1 CHECK (span = 1 OR (span = 60 AND minute = date_trunc('hour', minute, 'UTC'))),
  method    text NOT NULL CHECK (method IN ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'OTHER')),
  route     text NOT NULL CHECK (route = 'unmatched' OR (route ~ '^(/[A-Za-z0-9:_*.-]*)+$' AND char_length(route) <= 200)),
  requests  integer NOT NULL CHECK (requests > 0),
  errors    integer NOT NULL CHECK (errors BETWEEN 0 AND requests),
  slow      integer NOT NULL CHECK (slow BETWEEN 0 AND requests),
  total_ms  double precision NOT NULL CHECK (total_ms >= 0),
  buckets   integer[] NOT NULL CHECK (
              array_length(buckets, 1) = 30 AND array_ndims(buckets) = 1
              AND array_position(buckets, NULL) IS NULL AND 0 <= ALL (buckets)),
  PRIMARY KEY (minute, span, method, route)
);
CREATE INDEX IF NOT EXISTS ops_minutes_minute ON app.ops_minutes (minute);

-- Each background job's last run: when it started, last succeeded, last
-- failed and with what kind of error (a class name, never a message), and
-- how often it is expected to run, so a job that silently stopped shows.
CREATE TABLE IF NOT EXISTS app.ops_jobs (
  job              text PRIMARY KEY CHECK (job ~ '^[a-z][a-z0-9-]{0,39}$'),
  expected_seconds integer NOT NULL CHECK (expected_seconds > 0),
  last_started_at  timestamptz,
  last_success_at  timestamptz,
  last_failure_at  timestamptz,
  last_error_kind  text CHECK (last_error_kind ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'),
  runs             bigint NOT NULL DEFAULT 0 CHECK (runs >= 0),
  failures         bigint NOT NULL DEFAULT 0 CHECK (failures BETWEEN 0 AND runs)
);

ALTER TABLE app.ops_minutes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ops_minutes FORCE ROW LEVEL SECURITY;
ALTER TABLE app.ops_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ops_jobs FORCE ROW LEVEL SECURITY;
GRANT SELECT, DELETE ON app.ops_minutes TO app_api;
GRANT INSERT (minute, span, method, route, requests, errors, slow, total_ms, buckets) ON app.ops_minutes TO app_api;
GRANT UPDATE (requests, errors, slow, total_ms, buckets) ON app.ops_minutes TO app_api;
GRANT SELECT, INSERT ON app.ops_jobs TO app_api;
GRANT UPDATE (expected_seconds, last_started_at, last_success_at, last_failure_at, last_error_kind, runs, failures)
  ON app.ops_jobs TO app_api;

DROP POLICY IF EXISTS ops_minutes_read ON app.ops_minutes;
CREATE POLICY ops_minutes_read ON app.ops_minutes FOR SELECT TO app_api
  USING (app.is_system() OR app.is_moderator());
DROP POLICY IF EXISTS ops_minutes_write ON app.ops_minutes;
CREATE POLICY ops_minutes_write ON app.ops_minutes FOR INSERT TO app_api WITH CHECK (app.is_system());
DROP POLICY IF EXISTS ops_minutes_add ON app.ops_minutes;
CREATE POLICY ops_minutes_add ON app.ops_minutes FOR UPDATE TO app_api
  USING (app.is_system()) WITH CHECK (app.is_system());
DROP POLICY IF EXISTS ops_minutes_expire ON app.ops_minutes;
CREATE POLICY ops_minutes_expire ON app.ops_minutes FOR DELETE TO app_api
  USING (app.is_system() AND (
    (span = 1 AND minute < now() - interval '48 hours') OR minute < now() - interval '35 days'));

DROP POLICY IF EXISTS ops_jobs_read ON app.ops_jobs;
CREATE POLICY ops_jobs_read ON app.ops_jobs FOR SELECT TO app_api
  USING (app.is_system() OR app.is_moderator());
DROP POLICY IF EXISTS ops_jobs_write ON app.ops_jobs;
CREATE POLICY ops_jobs_write ON app.ops_jobs FOR INSERT TO app_api WITH CHECK (app.is_system());
DROP POLICY IF EXISTS ops_jobs_update ON app.ops_jobs;
CREATE POLICY ops_jobs_update ON app.ops_jobs FOR UPDATE TO app_api
  USING (app.is_system()) WITH CHECK (app.is_system());

UPDATE app.schema_meta SET version = 42, applied_at = now();
