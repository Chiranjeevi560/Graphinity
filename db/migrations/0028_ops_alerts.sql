-- Alert delivery (docs/adr/0020-observability.md): which problems moderators
-- were told about and when, so the same one isn't sent again while it
-- lasts, and a problem that clears and comes back is news again. Problem
-- keys name an objective or a job, nothing about any person. Only the
-- server's own jobs read and write it.
CREATE TABLE IF NOT EXISTS app.ops_alerts (
  key           text PRIMARY KEY CHECK (key ~ '^(slo:(availability|latency):[0-9]{1,5}|job:[a-z][a-z0-9-]{0,39})$'),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_sent_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  CHECK (resolved_at IS NULL OR resolved_at >= first_seen_at)
);
ALTER TABLE app.ops_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ops_alerts FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON app.ops_alerts TO app_api;
GRANT UPDATE (first_seen_at, last_sent_at, resolved_at) ON app.ops_alerts TO app_api;
DROP POLICY IF EXISTS ops_alerts_system ON app.ops_alerts;
CREATE POLICY ops_alerts_system ON app.ops_alerts FOR ALL TO app_api
  USING (app.is_system()) WITH CHECK (app.is_system());

-- Alerts go to moderators who aren't blocked: the server's own jobs must be
-- able to see who is blocked (until now only the person and moderators could).
DROP POLICY IF EXISTS blocks_system ON app.blocks;
CREATE POLICY blocks_system ON app.blocks FOR SELECT TO app_api USING (app.is_system());

UPDATE app.schema_meta SET version = 43, applied_at = now();
