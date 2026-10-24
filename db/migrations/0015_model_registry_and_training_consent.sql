-- Graphinity's own models (docs/adr/0010-own-models.md): trained here, from
-- Graphinity's data only, and kept here. Nothing is sent to an outside AI.

-- Training uses only the public questions and answers of people who turned
-- this on. Optional and off by default, like every non-required purpose.
INSERT INTO app.consent_categories
  (name, purpose, data_description, retention, recipients, policy_version, required_for_service)
VALUES
  ('model_training',
   'Use your public questions and answers to train Graphinity''s own models for search, duplicate detection and spam detection.',
   'The text of questions and answers you posted publicly. Never private settings, reading or search history, or anything you did not post.',
   'A model keeps learned statistics, not your posts; turning this off or deleting your account removes your text from every later training run.',
   'Graphinity only. Models are trained and run on Graphinity''s own servers; nothing is sent to an outside AI service.',
   1, false)
ON CONFLICT (name) DO NOTHING;

-- Every trained version of every model: what it was trained on, how it
-- scored against the model it would replace, and whether it serves. Weights
-- live here too, so a model never leaves the database it was trained from.
CREATE TABLE IF NOT EXISTS app.ml_models (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_-]{0,39}$'),
  version       integer NOT NULL CHECK (version > 0),
  algorithm     text NOT NULL CHECK (char_length(algorithm) BETWEEN 3 AND 80),
  params        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Rows and a fingerprint of exactly which records were used (no content).
  dataset       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- This model's held-out scores, and the serving model's on the same data.
  metrics       jsonb NOT NULL DEFAULT '{}'::jsonb,
  baseline      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL CHECK (status IN ('candidate', 'production', 'rejected', 'retired')),
  reason        text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500),
  artifact      bytea,
  artifact_sha256 text CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  promoted_at   timestamptz,
  retired_at    timestamptz,
  UNIQUE (name, version),
  CHECK ((artifact IS NULL) = (artifact_sha256 IS NULL)),
  CHECK (status <> 'production' OR (artifact IS NOT NULL AND promoted_at IS NOT NULL))
);
-- At most one serving version per model.
CREATE UNIQUE INDEX IF NOT EXISTS ml_models_one_production ON app.ml_models (name) WHERE status = 'production';
ALTER TABLE app.ml_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ml_models FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON app.ml_models TO app_api;
GRANT UPDATE (status, reason, promoted_at, retired_at) ON app.ml_models TO app_api;
-- Only the server's own jobs train, promote and load models; no request can.
CREATE POLICY ml_models_system ON app.ml_models FOR ALL TO app_api
  USING (app.is_system()) WITH CHECK (app.is_system());

-- A kill switch for training (apps/api/src/flags.ts): off, no new model is
-- trained or promoted; the serving model keeps serving.
INSERT INTO app.feature_flags (name, enabled, note) VALUES
  ('model_training', true, 'Daily training of Graphinity''s own models. Off: no training runs; the serving model stays.')
ON CONFLICT (name) DO NOTHING;

UPDATE app.schema_meta SET version = 30, applied_at = now();
