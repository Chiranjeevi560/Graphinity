-- Capture only first-party actions that a person explicitly enabled. These
-- records contain event type and source row id, never post text or identity.
CREATE OR REPLACE FUNCTION app.capture_consented_interaction_signal() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  event_row jsonb := to_jsonb(NEW);
  actor uuid;
  target text;
BEGIN
  IF TG_ARGV[0] = 'selection_asker' THEN
    SELECT q.asker_id INTO actor FROM app.questions q WHERE q.id = (event_row ->> 'question_id')::bigint;
    target := event_row ->> 'question_id';
  ELSIF TG_ARGV[0] = 'helpful_asker' THEN
    SELECT q.asker_id INTO actor
      FROM app.answers a JOIN app.questions q ON q.id = a.question_id
      WHERE a.id = (event_row ->> 'answer_id')::bigint;
    target := event_row ->> 'answer_id';
  ELSE
    actor := (event_row ->> TG_ARGV[0])::uuid;
    target := event_row ->> TG_ARGV[2];
  END IF;

  IF actor IS NOT NULL AND EXISTS (
    SELECT 1 FROM app.user_consent_settings s
    WHERE s.user_id = actor AND s.category = 'interaction_history' AND s.enabled
  ) THEN
    INSERT INTO app.personal_signal_events
      (user_id, consent_category, signal_type, subject_id, value, source, expires_at)
    VALUES
      (actor, 'interaction_history', TG_ARGV[1], target, '{}'::jsonb, 'graphinity_generated',
       clock_timestamp() + interval '365 days');
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.capture_consented_interaction_signal() FROM PUBLIC;

CREATE TRIGGER questions_personal_signal AFTER INSERT ON app.questions
  FOR EACH ROW EXECUTE FUNCTION app.capture_consented_interaction_signal('asker_id', 'question_asked', 'id');
CREATE TRIGGER answers_personal_signal AFTER INSERT ON app.answers
  FOR EACH ROW EXECUTE FUNCTION app.capture_consented_interaction_signal('answerer_id', 'answer_written', 'id');
CREATE TRIGGER selections_personal_signal AFTER INSERT OR UPDATE OF answer_id ON app.selections
  FOR EACH ROW EXECUTE FUNCTION app.capture_consented_interaction_signal('selection_asker', 'answer_selected', 'question_id');
CREATE TRIGGER helpful_marks_personal_signal AFTER INSERT ON app.helpful_marks
  FOR EACH ROW EXECUTE FUNCTION app.capture_consented_interaction_signal('helpful_asker', 'answer_marked_helpful', 'answer_id');
CREATE TRIGGER reports_personal_signal AFTER INSERT ON app.reports
  FOR EACH ROW EXECUTE FUNCTION app.capture_consented_interaction_signal('reporter_id', 'content_reported', 'id');

UPDATE app.schema_meta SET version = 21, applied_at = now();
