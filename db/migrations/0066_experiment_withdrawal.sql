-- Experiments enrol only people who chose to help improve search, so withdrawing that removes what's held about them.
CREATE OR REPLACE FUNCTION app.forget_experiments_on_withdrawal() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.category = 'search_improvement' AND NOT NEW.enabled THEN
    DELETE FROM app.exp_unit_metrics WHERE subject = NEW.user_id;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.forget_experiments_on_withdrawal() FROM PUBLIC;
DROP TRIGGER IF EXISTS forget_experiments ON app.user_consent_settings;
CREATE TRIGGER forget_experiments AFTER INSERT OR UPDATE OF enabled ON app.user_consent_settings
  FOR EACH ROW EXECUTE FUNCTION app.forget_experiments_on_withdrawal();

UPDATE app.schema_meta SET version = 81, applied_at = now();
