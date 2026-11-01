-- When an experiment really began, which may be weeks after it was drafted: what's before it is the covariate, and what's
-- after it the outcome. And entering one holds the choice that allows it, so a withdrawal can't slip between the check
-- and the row, as 0060 settled for memory.
ALTER TABLE app.exp_definitions ADD COLUMN IF NOT EXISTS started_at timestamptz;
UPDATE app.exp_definitions SET started_at = created_at WHERE status <> 'draft' AND started_at IS NULL;

CREATE OR REPLACE FUNCTION app.stamp_experiment_start() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.status = 'running' AND NEW.started_at IS NULL THEN
    NEW.started_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.stamp_experiment_start() FROM PUBLIC;
DROP TRIGGER IF EXISTS exp_start_stamp ON app.exp_definitions;
CREATE TRIGGER exp_start_stamp BEFORE INSERT OR UPDATE OF status ON app.exp_definitions
  FOR EACH ROW EXECUTE FUNCTION app.stamp_experiment_start();

CREATE OR REPLACE FUNCTION app.search_improvement_allowed_locked(person uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT (app.is_system() OR person = app.current_user_id()) THEN
    RAISE EXCEPTION 'only for yourself' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM 1 FROM app.user_consent_settings s
    WHERE s.user_id = person AND s.category = 'search_improvement' AND s.enabled FOR SHARE;
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION app.search_improvement_allowed_locked(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.search_improvement_allowed_locked(uuid) TO app_api;

UPDATE app.schema_meta SET version = 83, applied_at = now();
