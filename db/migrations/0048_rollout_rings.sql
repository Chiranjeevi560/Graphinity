-- Rollout rings (docs/adr/0028-rollout-governor.md): a switch that is on can reach only part of
-- its people, hashed by person, while it proves itself. No ring means everyone.
-- The governor turns a switch off by itself when requests go bad; only an owner moves rings.
ALTER TABLE app.feature_flags
  ADD COLUMN IF NOT EXISTS ring smallint CHECK (ring BETWEEN 0 AND 3),
  ADD COLUMN IF NOT EXISTS tripped_at timestamptz;

CREATE OR REPLACE FUNCTION app.set_flag_ring(target text, to_ring smallint) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT app.is_owner() THEN
    RAISE EXCEPTION 'only an owner moves rollout rings' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Ring 3 is everyone, the same as no ring: starting or moving a rollout also turns the switch on.
  UPDATE app.feature_flags SET enabled = true, ring = NULLIF(to_ring, 3), tripped_at = NULL, updated_at = now()
   WHERE name = target;
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION app.set_flag_ring(text, smallint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.set_flag_ring(text, smallint) TO app_api;

-- Trips every switch still in a ring. Only the system's own job may.
CREATE OR REPLACE FUNCTION app.trip_rollouts() RETURNS SETOF text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT app.is_system() THEN
    RAISE EXCEPTION 'only the governor trips rollouts' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    UPDATE app.feature_flags SET enabled = false, ring = NULL, tripped_at = clock_timestamp(), updated_at = now()
     WHERE enabled AND ring IS NOT NULL
    RETURNING name;
END
$$;
REVOKE ALL ON FUNCTION app.trip_rollouts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.trip_rollouts() TO app_api;

UPDATE app.schema_meta SET version = 63, applied_at = now();
