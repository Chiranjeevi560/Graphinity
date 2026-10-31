-- The feature store (master charter §6.1) and model lineage (§6.3). Features describe topics and
-- campaigns, not people. A training row can only ever read history at or before its label's time.

CREATE UNLOGGED TABLE IF NOT EXISTS app.feature_store_online (
  entity_type            varchar(32) NOT NULL,
  entity_id              text NOT NULL CHECK (char_length(entity_id) <= 100),
  feature_group          varchar(64) NOT NULL,
  feature_schema_version smallint NOT NULL,
  numeric_features       real[] NOT NULL,
  valid_from             timestamptz NOT NULL,
  PRIMARY KEY (entity_type, entity_id, feature_group)
);

CREATE TABLE IF NOT EXISTS app.feature_store_history (
  entity_type            varchar(32) NOT NULL,
  entity_id              text NOT NULL CHECK (char_length(entity_id) <= 100),
  feature_group          varchar(64) NOT NULL,
  feature_schema_version smallint NOT NULL,
  numeric_features       real[] NOT NULL,
  valid_from             timestamptz NOT NULL,
  tx_recorded_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (entity_type, entity_id, feature_group, valid_from)
);
CREATE INDEX IF NOT EXISTS feature_store_history_lookup
  ON app.feature_store_history (entity_type, feature_group, entity_id, valid_from DESC);

ALTER TABLE app.feature_store_online ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.feature_store_online FORCE ROW LEVEL SECURITY;
ALTER TABLE app.feature_store_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.feature_store_history FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON app.feature_store_online TO app_api;
GRANT SELECT, INSERT ON app.feature_store_history TO app_api;
DROP POLICY IF EXISTS feature_online_system ON app.feature_store_online;
CREATE POLICY feature_online_system ON app.feature_store_online FOR ALL TO app_api USING (app.is_system()) WITH CHECK (app.is_system());
DROP POLICY IF EXISTS feature_history_system ON app.feature_store_history;
CREATE POLICY feature_history_system ON app.feature_store_history FOR ALL TO app_api USING (app.is_system()) WITH CHECK (app.is_system());

-- Lineage, on the existing registry (expand only): where each version came from, and how far it's
-- been let out. Serving still follows status = 'production'.
ALTER TABLE app.ml_models ADD COLUMN IF NOT EXISTS git_commit_sha text CHECK (git_commit_sha ~ '^[0-9a-f]{7,40}$');
ALTER TABLE app.ml_models ADD COLUMN IF NOT EXISTS feature_schema_version smallint;
ALTER TABLE app.ml_models ADD COLUMN IF NOT EXISTS calibration jsonb;
ALTER TABLE app.ml_models ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'CANDIDATE'
  CHECK (stage IN ('CANDIDATE', 'SHADOW', 'CANARY', 'PRODUCTION', 'ARCHIVED'));
UPDATE app.ml_models SET stage = CASE status WHEN 'production' THEN 'PRODUCTION' WHEN 'retired' THEN 'ARCHIVED' WHEN 'rejected' THEN 'ARCHIVED' ELSE 'CANDIDATE' END;
GRANT UPDATE (stage) ON app.ml_models TO app_api;

-- How a version was made never changes. (The API has no grant on its dataset, and weights can only
-- be dropped: migrations 0015, 0023.)
CREATE OR REPLACE FUNCTION app.guard_ml_lineage() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.params IS DISTINCT FROM OLD.params OR NEW.algorithm IS DISTINCT FROM OLD.algorithm
     OR NEW.git_commit_sha IS DISTINCT FROM OLD.git_commit_sha THEN
    RAISE EXCEPTION 'a model version''s lineage can''t change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_ml_lineage() FROM PUBLIC;
DROP TRIGGER IF EXISTS ml_models_lineage ON app.ml_models;
CREATE TRIGGER ml_models_lineage BEFORE UPDATE ON app.ml_models
  FOR EACH ROW EXECUTE FUNCTION app.guard_ml_lineage();

UPDATE app.schema_meta SET version = 56, applied_at = now();
