-- Drift monitoring (docs/adr/0018-drift-monitoring.md): each day, how far
-- each serving model's inputs have moved from what it was trained on, per
-- feature. Numbers about features only, nothing about any person. Only the
-- server's own jobs read and write it; kept 400 days so a year can be
-- compared with the last.
CREATE TABLE IF NOT EXISTS app.ml_drift (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  model        text NOT NULL CHECK (model ~ '^[a-z][a-z0-9_-]{0,39}$'),
  version      integer NOT NULL CHECK (version > 0),
  feature      text NOT NULL CHECK (feature ~ '^[a-z][a-z0-9_]{0,63}$'),
  psi          double precision NOT NULL CHECK (psi >= 0),
  ks           double precision NOT NULL CHECK (ks BETWEEN 0 AND 1),
  p            double precision NOT NULL CHECK (p BETWEEN 0 AND 1),
  n            integer NOT NULL CHECK (n >= 0),
  drifted      boolean NOT NULL,
  measured_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ml_drift_model ON app.ml_drift (model, version, measured_at);
CREATE INDEX IF NOT EXISTS ml_drift_measured ON app.ml_drift (measured_at);
ALTER TABLE app.ml_drift ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ml_drift FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON app.ml_drift TO app_api;
DROP POLICY IF EXISTS ml_drift_system ON app.ml_drift;
CREATE POLICY ml_drift_system ON app.ml_drift FOR ALL TO app_api
  USING (app.is_system()) WITH CHECK (app.is_system());

UPDATE app.schema_meta SET version = 41, applied_at = now();
