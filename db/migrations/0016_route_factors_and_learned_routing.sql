-- Learned routing (docs/adr/0013-learned-routing.md): every routing decision's
-- factors, exactly as the routing job saw them, so a model can learn from
-- outcomes without rebuilding factors later from counts that already include
-- those outcomes.
--
-- A table of its own, not columns on app.routes: a routed person can read
-- their own routes, and these factors include internal scores and how
-- similar they are to other people asked. Only the server's own jobs can
-- read or write them, and they are deleted after 180 days.

CREATE TABLE IF NOT EXISTS app.route_factors (
  question_id     bigint NOT NULL,
  profile_id      uuid NOT NULL,
  -- What the nine numbers mean (routing-score.ts FACTORS_VERSION). A change
  -- to any factor's definition gets a new version; training reads one version.
  factors_version smallint NOT NULL CHECK (factors_version = 1),
  -- φ1..φ9 in [0, 1], diversity as applied at selection. NaN and infinities
  -- fail the range check; a NULL element fails array_position.
  factors         double precision[] NOT NULL CHECK (
    array_length(factors, 1) = 9 AND array_ndims(factors) = 1
    AND array_position(factors, NULL) IS NULL
    AND 0 <= ALL (factors) AND 1 >= ALL (factors)
  ),
  -- The newcomer place (ranked with the exploration bonus) or an exploit place.
  explore         boolean NOT NULL,
  wave            smallint NOT NULL CHECK (wave BETWEEN 1 AND 3),
  -- The learned model that ranked this person, or NULL when Ψ did.
  model_name      text GENERATED ALWAYS AS ('routing') STORED,
  model_version   integer CHECK (model_version > 0),
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (question_id, profile_id),
  FOREIGN KEY (question_id, profile_id) REFERENCES app.routes (question_id, profile_id) ON DELETE CASCADE,
  FOREIGN KEY (model_name, model_version) REFERENCES app.ml_models (name, version),
  -- The newcomer place is always ranked by Ψ with its bonus.
  CHECK (NOT explore OR model_version IS NULL)
);
CREATE INDEX IF NOT EXISTS route_factors_recorded_idx ON app.route_factors (recorded_at);
ALTER TABLE app.route_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.route_factors FORCE ROW LEVEL SECURITY;
GRANT SELECT, DELETE ON app.route_factors TO app_api;
GRANT INSERT (question_id, profile_id, factors_version, factors, explore, wave, model_version)
  ON app.route_factors TO app_api;
CREATE POLICY route_factors_system ON app.route_factors FOR ALL TO app_api
  USING (app.is_system()) WITH CHECK (app.is_system());

-- The route's own record of what ranked it must agree: ranking_version 1 is
-- Ψ, 2 is a learned model.
CREATE OR REPLACE FUNCTION app.guard_route_factors() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE version smallint;
BEGIN
  SELECT r.ranking_version INTO version FROM app.routes r
  WHERE r.question_id = NEW.question_id AND r.profile_id = NEW.profile_id;
  IF version IS DISTINCT FROM (CASE WHEN NEW.model_version IS NULL THEN 1 ELSE 2 END) THEN
    RAISE EXCEPTION 'route ranking_version % does not match the factors'' model', version
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER route_factors_agree BEFORE INSERT ON app.route_factors
  FOR EACH ROW EXECUTE FUNCTION app.guard_route_factors();

-- Serving a learned routing model is the owner's decision: off until they
-- turn it on, and switching it off returns every place to Ψ at once.
INSERT INTO app.feature_flags (name, enabled, note) VALUES
  ('learned_routing', false, 'Rank exploit places with the promoted learned routing model instead of Ψ. Off: Ψ ranks everyone.')
ON CONFLICT (name) DO NOTHING;

UPDATE app.schema_meta SET version = 31, applied_at = now();
