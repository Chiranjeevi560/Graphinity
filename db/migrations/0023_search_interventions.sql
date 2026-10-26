-- Search, part 6 (docs/adr/0015-search.md): what learning from clicks needs
-- beyond part 3's logs, to correct for position and to compare rankings online.
-- Only recorded searches (search_improvement on) are ever swapped or
-- interleaved: there is no reason to change anyone else's results.

-- Position bias (RandPair): on a small, disclosed share of recorded searches,
-- the neighbours at swap and swap + 1 exchange places.
ALTER TABLE app.searches ADD COLUMN IF NOT EXISTS swap smallint CHECK (swap BETWEEN 1 AND 4);
-- Online comparison (team-draft interleaving, Radlinski et al. 2008): which
-- two rankers' results were interleaved, e.g. "lambdamart:v3/lambdamart:v2".
ALTER TABLE app.searches ADD COLUMN IF NOT EXISTS experiment text
  CHECK (experiment ~ '^[a-z0-9:._-]{1,40}/[a-z0-9:._-]{1,40}$');
ALTER TABLE app.searches ADD CONSTRAINT searches_one_intervention CHECK (swap IS NULL OR experiment IS NULL);

-- Where the ranker put each result, before any swap (shown at `position`).
ALTER TABLE app.search_results ADD COLUMN IF NOT EXISTS ranked_position smallint CHECK (ranked_position BETWEEN 1 AND 20);
-- In an interleaved search, which ranker contributed the result: a (control) or b (candidate).
ALTER TABLE app.search_results ADD COLUMN IF NOT EXISTS team text CHECK (team IN ('a', 'b'));

GRANT INSERT (swap, experiment) ON app.searches TO app_api;

-- A learned model waits as a candidate until online comparison decides
-- (apps/api/src/search/judge.ts): at most one waits per model.
CREATE UNIQUE INDEX IF NOT EXISTS ml_models_one_candidate ON app.ml_models (name) WHERE status = 'candidate';

-- Online comparison drops a losing or superseded candidate's weights and adds
-- its online evidence. The API role may clear weights, never write new ones
-- into an existing version (a version's weights are fixed when it is recorded).
GRANT UPDATE (artifact, artifact_sha256, metrics) ON app.ml_models TO app_api;
CREATE OR REPLACE FUNCTION app.ml_models_weights_fixed() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF (NEW.artifact IS NOT NULL AND NEW.artifact IS DISTINCT FROM OLD.artifact)
     OR (NEW.artifact_sha256 IS NOT NULL AND NEW.artifact_sha256 IS DISTINCT FROM OLD.artifact_sha256) THEN
    RAISE EXCEPTION 'a model version''s weights can be removed, never replaced' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.ml_models_weights_fixed() FROM PUBLIC;
DROP TRIGGER IF EXISTS ml_models_weights_fixed ON app.ml_models;
CREATE TRIGGER ml_models_weights_fixed BEFORE UPDATE OF artifact, artifact_sha256 ON app.ml_models
  FOR EACH ROW EXECUTE FUNCTION app.ml_models_weights_fixed();

-- Learned search ranking serves, and is compared online, only while the owner
-- has this on (as learned_routing, ADR 0013). Training runs either way.
INSERT INTO app.feature_flags (name, enabled, note)
VALUES (
  'learned_search_ranking', false,
  'Off: search ranks by fusion only; no learned model serves and nothing is interleaved. Training still runs.'
)
ON CONFLICT (name) DO NOTHING;

UPDATE app.schema_meta SET version = 38, applied_at = now();
