-- Changing the selected answer must also retract the old answer's outcome
-- signal; the 0007 trigger handles the newly selected answer.
CREATE OR REPLACE FUNCTION app.refresh_previous_selection_learning() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  target_answer bigint := OLD.answer_id;
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
  IF TG_OP <> 'UPDATE' OR OLD.answer_id = NEW.answer_id THEN RETURN NEW; END IF;

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
  IF previous_reward IS NULL THEN RETURN NEW; END IF;
  delta_reward := next_reward - previous_reward;
  IF delta_reward = 0 THEN RETURN NEW; END IF;
  half_life_days := CASE WHEN answer_field IN ('imports-customs', 'visas-immigration', 'travel') THEN 180 ELSE 730 END;

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

  UPDATE app.answer_edge_reinforcement
  SET reward = next_reward, updated_at = clock_timestamp()
  WHERE answer_id = target_answer;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.refresh_previous_selection_learning() FROM PUBLIC;
CREATE TRIGGER selections_retract_previous_learning
  AFTER UPDATE OF answer_id ON app.selections
  FOR EACH ROW EXECUTE FUNCTION app.refresh_previous_selection_learning();

UPDATE app.schema_meta SET version = 25, applied_at = now();
