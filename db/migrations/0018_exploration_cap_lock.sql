-- The weekly exploration cap (0017) counted without a lock: two routing runs
-- at once (two servers overlapping during a deploy) could both see room for
-- the same person and both insert. One person at a time now; the routing job
-- turns a refusal into exploitation's choice for that place (routing.ts).
CREATE OR REPLACE FUNCTION app.guard_exploration_cap() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF NEW.explore_reason = 'explored' THEN
    PERFORM pg_advisory_xact_lock(hashtext('exploration:' || NEW.profile_id::text));
    IF (
      SELECT count(*) FROM app.route_factors f
      WHERE f.profile_id = NEW.profile_id AND f.explore_reason = 'explored'
        AND f.recorded_at > clock_timestamp() - interval '7 days'
    ) >= 3 THEN
      RAISE EXCEPTION 'exploration cap reached for this person' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

UPDATE app.schema_meta SET version = 33, applied_at = now();
