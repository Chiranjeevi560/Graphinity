-- Persist the routing decision inputs needed to explain and audit a route.
ALTER TABLE app.routes
  ADD COLUMN IF NOT EXISTS ranking_score real CHECK (ranking_score >= 0),
  ADD COLUMN IF NOT EXISTS expertise_weight real CHECK (expertise_weight BETWEEN 0 AND 1),
  ADD COLUMN IF NOT EXISTS circadian_fit real CHECK (circadian_fit BETWEEN 0 AND 1),
  ADD COLUMN IF NOT EXISTS diversity_fit real CHECK (diversity_fit BETWEEN 0 AND 1),
  ADD COLUMN IF NOT EXISTS ranking_version smallint CHECK (ranking_version > 0);

GRANT INSERT (ranking_score, expertise_weight, circadian_fit, diversity_fit, ranking_version)
  ON app.routes TO app_api;

UPDATE app.schema_meta SET version = 23, applied_at = now();
