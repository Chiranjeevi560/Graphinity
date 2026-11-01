-- The final re-audit of 2026-11-01. Withdrawal deletes memory, but a write still in progress when it commits stayed
-- behind, unseen by the delete. Writers now hold a share lock on the consent row, so withdrawal waits for them and
-- its delete sees what they wrote. Definer, since the system's sweep can't read people's consent rows otherwise.
CREATE OR REPLACE FUNCTION app.memory_allowed_locked(person uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT (app.is_system() OR person = app.current_user_id()) THEN
    RAISE EXCEPTION 'only for yourself' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM 1 FROM app.user_consent_settings s
    WHERE s.user_id = person AND s.category = 'memory_personalization' AND s.enabled FOR SHARE;
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION app.memory_allowed_locked(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.memory_allowed_locked(uuid) TO app_api;

UPDATE app.schema_meta SET version = 75, applied_at = now();
