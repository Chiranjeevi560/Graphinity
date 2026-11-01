-- What the daily evaluation job found about each engine that measures but doesn't yet decide anything. Aggregate
-- numbers only: no person, no question, no session.
CREATE TABLE IF NOT EXISTS app.model_evaluations (
  name         text PRIMARY KEY CHECK (name ~ '^[a-z0-9_:-]{1,80}$'),
  metrics      jsonb NOT NULL,
  evaluated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.model_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.model_evaluations FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON app.model_evaluations TO app_api;
DROP POLICY IF EXISTS model_evaluations_read ON app.model_evaluations;
CREATE POLICY model_evaluations_read ON app.model_evaluations FOR SELECT TO app_api
  USING (app.is_system() OR app.is_owner());
DROP POLICY IF EXISTS model_evaluations_add ON app.model_evaluations;
CREATE POLICY model_evaluations_add ON app.model_evaluations FOR INSERT TO app_api WITH CHECK (app.is_system());
DROP POLICY IF EXISTS model_evaluations_change ON app.model_evaluations;
CREATE POLICY model_evaluations_change ON app.model_evaluations FOR UPDATE TO app_api
  USING (app.is_system()) WITH CHECK (app.is_system());

UPDATE app.schema_meta SET version = 70, applied_at = now();
