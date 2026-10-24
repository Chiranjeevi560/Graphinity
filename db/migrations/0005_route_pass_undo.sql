-- A routed question can be passed once. The pass is reversible for seven
-- seconds, with the database clock deciding the deadline.
CREATE TABLE IF NOT EXISTS app.route_passes (
  question_id bigint NOT NULL,
  profile_id uuid NOT NULL,
  passed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  undo_until timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '7 seconds'),
  undone_at timestamptz,
  PRIMARY KEY (question_id, profile_id),
  FOREIGN KEY (question_id, profile_id) REFERENCES app.routes(question_id, profile_id) ON DELETE CASCADE,
  CHECK (undone_at IS NULL OR undone_at >= passed_at)
);
CREATE INDEX IF NOT EXISTS route_passes_active_idx ON app.route_passes(profile_id, undo_until)
  WHERE undone_at IS NULL;
ALTER TABLE app.route_passes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.route_passes FORCE ROW LEVEL SECURITY;
GRANT SELECT ON app.route_passes TO app_api;
GRANT INSERT (question_id, profile_id) ON app.route_passes TO app_api;
GRANT UPDATE (undone_at) ON app.route_passes TO app_api;
CREATE POLICY route_passes_read_self ON app.route_passes FOR SELECT TO app_api
  USING (profile_id = app.current_user_id());
CREATE POLICY route_passes_create_self ON app.route_passes FOR INSERT TO app_api
  WITH CHECK (profile_id = app.current_user_id());
CREATE POLICY route_passes_undo_self ON app.route_passes FOR UPDATE TO app_api
  USING (profile_id = app.current_user_id() AND undone_at IS NULL AND undo_until > clock_timestamp())
  WITH CHECK (profile_id = app.current_user_id() AND undone_at IS NOT NULL);

CREATE OR REPLACE FUNCTION app.guard_route_pass_undo() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.passed_at := clock_timestamp();
    NEW.undo_until := NEW.passed_at + interval '7 seconds';
    NEW.undone_at := NULL;
    RETURN NEW;
  END IF;
  IF OLD.undone_at IS NOT NULL OR NEW.undone_at IS NULL OR clock_timestamp() > OLD.undo_until THEN
    RAISE EXCEPTION 'route pass can no longer be undone' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.question_id <> OLD.question_id OR NEW.profile_id <> OLD.profile_id
     OR NEW.passed_at <> OLD.passed_at OR NEW.undo_until <> OLD.undo_until THEN
    RAISE EXCEPTION 'route pass history is immutable' USING ERRCODE = 'check_violation';
  END IF;
  NEW.undone_at := clock_timestamp();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_route_pass_undo() FROM PUBLIC;
CREATE TRIGGER route_pass_undo_guard BEFORE INSERT OR UPDATE ON app.route_passes
  FOR EACH ROW EXECUTE FUNCTION app.guard_route_pass_undo();

UPDATE app.schema_meta SET version = 20, applied_at = now();
