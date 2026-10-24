-- Store field/country expertise priors and field-local co-answer affinity.
-- Both graphs are visible to the routing worker only, and both are private
-- from request transactions through app.is_system().
CREATE TABLE IF NOT EXISTS app.expertise_edge_weights (
  profile_id uuid NOT NULL REFERENCES app.profiles(id) ON DELETE CASCADE,
  field text NOT NULL REFERENCES app.fields(slug) ON DELETE CASCADE,
  country text NOT NULL REFERENCES app.countries(code),
  weight real NOT NULL DEFAULT 0.5 CHECK (weight BETWEEN 0.01 AND 0.999),
  confidence real NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
  evidence_count integer NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (profile_id, field, country)
) WITH (fillfactor = 80);
CREATE INDEX IF NOT EXISTS expertise_edges_route_idx ON app.expertise_edge_weights(field, country, weight DESC);
ALTER TABLE app.expertise_edge_weights ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.expertise_edge_weights FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON app.expertise_edge_weights TO app_api;
CREATE POLICY expertise_edges_system_only ON app.expertise_edge_weights FOR ALL TO app_api
  USING (app.is_system()) WITH CHECK (app.is_system());

INSERT INTO app.expertise_edge_weights (profile_id, field, country)
SELECT pf.profile_id, pf.field, p.country
FROM app.profile_fields pf JOIN app.profiles p ON p.id = pf.profile_id
ON CONFLICT (profile_id, field, country) DO NOTHING;

CREATE TABLE IF NOT EXISTS app.epistemic_affinity_edges (
  field text NOT NULL REFERENCES app.fields(slug) ON DELETE CASCADE,
  user_low uuid NOT NULL REFERENCES app.profiles(id) ON DELETE CASCADE,
  user_high uuid NOT NULL REFERENCES app.profiles(id) ON DELETE CASCADE,
  weight real NOT NULL DEFAULT 0.01 CHECK (weight BETWEEN 0.01 AND 0.999),
  confidence real NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
  co_answer_count integer NOT NULL DEFAULT 1 CHECK (co_answer_count > 0),
  evidence_count integer NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (field, user_low, user_high),
  CHECK (user_low < user_high)
) WITH (fillfactor = 80);
CREATE INDEX IF NOT EXISTS epistemic_affinity_route_idx ON app.epistemic_affinity_edges(field, user_low, user_high);
ALTER TABLE app.epistemic_affinity_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.epistemic_affinity_edges FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON app.epistemic_affinity_edges TO app_api;
CREATE POLICY epistemic_affinity_system_only ON app.epistemic_affinity_edges FOR ALL TO app_api
  USING (app.is_system()) WITH CHECK (app.is_system());

CREATE TABLE IF NOT EXISTS app.answer_edge_reinforcement (
  answer_id bigint PRIMARY KEY REFERENCES app.answers(id) ON DELETE CASCADE,
  reward real NOT NULL CHECK (reward BETWEEN -1 AND 1.5),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
) WITH (fillfactor = 80);
ALTER TABLE app.answer_edge_reinforcement ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.answer_edge_reinforcement FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON app.answer_edge_reinforcement TO app_api;
CREATE POLICY answer_edge_reinforcement_system_only ON app.answer_edge_reinforcement FOR ALL TO app_api
  USING (app.is_system()) WITH CHECK (app.is_system());

CREATE OR REPLACE FUNCTION app.seed_epistemic_affinity() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE answer_field text;
BEGIN
  SELECT q.field INTO answer_field FROM app.questions q WHERE q.id = NEW.question_id;
  INSERT INTO app.epistemic_affinity_edges (field, user_low, user_high, weight, co_answer_count)
  SELECT answer_field, least(a.answerer_id, NEW.answerer_id), greatest(a.answerer_id, NEW.answerer_id),
         least(0.999, 1 - exp(-0.08)), 1
  FROM app.answers a
  WHERE a.question_id = NEW.question_id AND a.answerer_id <> NEW.answerer_id
  ON CONFLICT (field, user_low, user_high) DO UPDATE SET
    co_answer_count = app.epistemic_affinity_edges.co_answer_count + 1,
    weight = least(0.999, 1 - exp(-0.08 * (app.epistemic_affinity_edges.co_answer_count + 1))),
    confidence = least(1, app.epistemic_affinity_edges.confidence + 0.05),
    updated_at = clock_timestamp();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.seed_epistemic_affinity() FROM PUBLIC;
CREATE TRIGGER answers_seed_affinity AFTER INSERT ON app.answers
  FOR EACH ROW EXECUTE FUNCTION app.seed_epistemic_affinity();

CREATE OR REPLACE FUNCTION app.refresh_answer_edge_reinforcement() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  target_answer bigint;
  answerer uuid;
  answer_field text;
  answer_country text;
  selected boolean;
  stars integer;
  correct boolean;
  helpful boolean;
  removed boolean;
  next_reward real;
  previous_reward real;
  delta_reward real;
  half_life_days real;
BEGIN
  IF TG_TABLE_NAME = 'selections' THEN
    target_answer := NEW.answer_id;
  ELSE
    target_answer := NEW.answer_id;
  END IF;
  IF target_answer IS NULL THEN RETURN NEW; END IF;

  SELECT a.answerer_id, q.field, COALESCE(q.country, p.country),
         EXISTS (SELECT 1 FROM app.selections s WHERE s.answer_id = a.id),
         COALESCE((SELECT r.stars FROM app.ratings r WHERE r.answer_id = a.id), 0),
         COALESCE((SELECT v.correct FROM app.verdicts v WHERE v.answer_id = a.id), false),
         EXISTS (SELECT 1 FROM app.helpful_marks h WHERE h.answer_id = a.id),
         EXISTS (SELECT 1 FROM app.decisions d WHERE d.answer_id = a.id AND d.decision = 'remove')
  INTO answerer, answer_field, answer_country, selected, stars, correct, helpful, removed
  FROM app.answers a JOIN app.questions q ON q.id = a.question_id
  JOIN app.profiles p ON p.id = a.answerer_id
  WHERE a.id = target_answer;
  IF answerer IS NULL OR answer_country IS NULL THEN RETURN NEW; END IF;

  next_reward := CASE
    WHEN removed THEN -0.8
    WHEN selected AND stars >= 4 AND correct THEN 1.5
    WHEN helpful OR correct THEN 0.65
    ELSE 0
  END;
  SELECT reward INTO previous_reward FROM app.answer_edge_reinforcement WHERE answer_id = target_answer FOR UPDATE;
  previous_reward := COALESCE(previous_reward, 0);
  delta_reward := greatest(-0.8, least(1.5, next_reward - previous_reward));
  IF delta_reward = 0 THEN RETURN NEW; END IF;
  half_life_days := CASE WHEN answer_field IN ('imports-customs', 'visas-immigration', 'travel') THEN 180 ELSE 730 END;

  INSERT INTO app.expertise_edge_weights (profile_id, field, country)
  VALUES (answerer, answer_field, answer_country)
  ON CONFLICT (profile_id, field, country) DO NOTHING;
  UPDATE app.expertise_edge_weights e
  SET weight = greatest(0.01, least(0.999,
        e.weight * exp(-ln(2) * greatest(0, extract(epoch FROM clock_timestamp() - e.updated_at) / 86400) / half_life_days)
        + 0.08 * delta_reward * (1 - e.weight))),
      confidence = least(1, e.confidence + 0.05 * abs(delta_reward)),
      evidence_count = e.evidence_count + 1,
      updated_at = clock_timestamp()
  WHERE e.profile_id = answerer AND e.field = answer_field AND e.country = answer_country;

  UPDATE app.epistemic_affinity_edges e
  SET weight = greatest(0.01, least(0.999,
        e.weight * exp(-ln(2) * greatest(0, extract(epoch FROM clock_timestamp() - e.updated_at) / 86400) / half_life_days)
        + 0.08 * delta_reward * (1 - e.weight))),
      confidence = least(1, e.confidence + 0.05 * abs(delta_reward)),
      evidence_count = e.evidence_count + 1,
      updated_at = clock_timestamp()
  WHERE e.field = answer_field AND EXISTS (
    SELECT 1 FROM app.answers peer
    WHERE peer.question_id = (SELECT question_id FROM app.answers WHERE id = target_answer)
      AND peer.answerer_id <> answerer
      AND (e.user_low = least(peer.answerer_id, answerer) AND e.user_high = greatest(peer.answerer_id, answerer))
  );

  INSERT INTO app.answer_edge_reinforcement (answer_id, reward)
  VALUES (target_answer, next_reward)
  ON CONFLICT (answer_id) DO UPDATE SET reward = EXCLUDED.reward, updated_at = clock_timestamp();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.refresh_answer_edge_reinforcement() FROM PUBLIC;
CREATE TRIGGER selections_refresh_expertise AFTER INSERT OR UPDATE OF answer_id ON app.selections
  FOR EACH ROW EXECUTE FUNCTION app.refresh_answer_edge_reinforcement();
CREATE TRIGGER helpful_refresh_expertise AFTER INSERT ON app.helpful_marks
  FOR EACH ROW EXECUTE FUNCTION app.refresh_answer_edge_reinforcement();
CREATE TRIGGER ratings_refresh_expertise AFTER INSERT OR UPDATE OF stars ON app.ratings
  FOR EACH ROW EXECUTE FUNCTION app.refresh_answer_edge_reinforcement();
CREATE TRIGGER verdicts_refresh_expertise AFTER INSERT OR UPDATE OF correct ON app.verdicts
  FOR EACH ROW EXECUTE FUNCTION app.refresh_answer_edge_reinforcement();
CREATE TRIGGER decisions_refresh_expertise AFTER INSERT ON app.decisions
  FOR EACH ROW EXECUTE FUNCTION app.refresh_answer_edge_reinforcement();

UPDATE app.schema_meta SET version = 22, applied_at = now();
