-- Experiments (master charter §7). A unit is a keyed hash, never an account. Buckets in a layer
-- can't overlap, in the database; a mismatch halts the experiment.

CREATE TABLE IF NOT EXISTS app.exp_layers (
  layer_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL UNIQUE CHECK (name ~ '^[a-z][a-z0-9_]{0,39}$'),
  salt_secret bytea NOT NULL DEFAULT uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid())
);

CREATE TABLE IF NOT EXISTS app.exp_definitions (
  exp_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  layer_id     bigint NOT NULL REFERENCES app.exp_layers (layer_id) ON DELETE CASCADE,
  name         text NOT NULL UNIQUE CHECK (name ~ '^[a-z][a-z0-9_]{0,39}$'),
  bucket_start integer NOT NULL CHECK (bucket_start >= 0),
  bucket_end   integer NOT NULL CHECK (bucket_end <= 10000),
  control_share real NOT NULL DEFAULT 0.5 CHECK (control_share > 0 AND control_share < 1),
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'halted_srm', 'stopped')),
  srm_p_value  double precision,
  always_valid_p double precision NOT NULL DEFAULT 1 CHECK (always_valid_p BETWEEN 0 AND 1),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (bucket_start < bucket_end)
);

CREATE OR REPLACE FUNCTION app.guard_exp_buckets() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('exp'), NEW.layer_id::integer);
  IF NEW.status IN ('draft', 'running') AND EXISTS (
    SELECT 1 FROM app.exp_definitions e
    WHERE e.layer_id = NEW.layer_id AND e.exp_id <> coalesce(NEW.exp_id, -1) AND e.status IN ('draft', 'running')
      AND NEW.bucket_start < e.bucket_end AND e.bucket_start < NEW.bucket_end) THEN
    RAISE EXCEPTION 'buckets overlap in this layer' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_exp_buckets() FROM PUBLIC;
DROP TRIGGER IF EXISTS exp_buckets_guard ON app.exp_definitions;
CREATE TRIGGER exp_buckets_guard BEFORE INSERT OR UPDATE ON app.exp_definitions
  FOR EACH ROW EXECUTE FUNCTION app.guard_exp_buckets();

CREATE TABLE IF NOT EXISTS app.exp_unit_metrics (
  exp_id  bigint NOT NULL REFERENCES app.exp_definitions (exp_id) ON DELETE CASCADE,
  unit_id text NOT NULL CHECK (unit_id ~ '^[A-Za-z0-9_-]{22,64}$'),
  arm     text NOT NULL CHECK (arm IN ('control', 'treatment')),
  pre_experiment_covariate_x double precision NOT NULL DEFAULT 0,
  post_metric_y double precision NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (exp_id, unit_id)
);

ALTER TABLE app.exp_layers ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.exp_layers FORCE ROW LEVEL SECURITY;
ALTER TABLE app.exp_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.exp_definitions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.exp_unit_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.exp_unit_metrics FORCE ROW LEVEL SECURITY;
GRANT SELECT ON app.exp_layers TO app_api;
GRANT SELECT ON app.exp_definitions TO app_api;
GRANT UPDATE (status, srm_p_value, always_valid_p) ON app.exp_definitions TO app_api;
GRANT SELECT, INSERT, UPDATE ON app.exp_unit_metrics TO app_api;
DROP POLICY IF EXISTS exp_layers_system ON app.exp_layers;
CREATE POLICY exp_layers_system ON app.exp_layers FOR SELECT TO app_api USING (app.is_system());
DROP POLICY IF EXISTS exp_definitions_read ON app.exp_definitions;
CREATE POLICY exp_definitions_read ON app.exp_definitions FOR SELECT TO app_api USING (app.is_system() OR app.is_owner());
DROP POLICY IF EXISTS exp_definitions_update ON app.exp_definitions;
CREATE POLICY exp_definitions_update ON app.exp_definitions FOR UPDATE TO app_api USING (app.is_system()) WITH CHECK (app.is_system());
DROP POLICY IF EXISTS exp_metrics_system ON app.exp_unit_metrics;
CREATE POLICY exp_metrics_system ON app.exp_unit_metrics FOR ALL TO app_api USING (app.is_system()) WITH CHECK (app.is_system());

UPDATE app.schema_meta SET version = 57, applied_at = now();
