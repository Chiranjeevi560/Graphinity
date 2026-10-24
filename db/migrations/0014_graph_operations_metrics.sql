-- Keep a bounded, aggregate-only view of graph queue lag available without
-- granting the API role direct system access to personal event rows.
CREATE INDEX personal_signal_events_projection_lag_idx
  ON app.personal_signal_events(occurred_at)
  WHERE projected_at IS NULL;

CREATE OR REPLACE FUNCTION app.personal_graph_projection_status()
RETURNS TABLE(pending bigint, oldest_seconds double precision)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF NOT app.is_system() THEN
    RAISE EXCEPTION 'system transaction required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT count(*)::bigint,
           COALESCE(greatest(0, extract(epoch FROM clock_timestamp() - min(occurred_at))), 0)::double precision
    FROM app.personal_signal_events
    WHERE projected_at IS NULL;
END
$$;
REVOKE ALL ON FUNCTION app.personal_graph_projection_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.personal_graph_projection_status() TO app_api;

UPDATE app.schema_meta SET version = 29, applied_at = now();
