-- The re-audit of 2026-11-01. Deleting a question leaves its appeal with no post to put back: overturning it must
-- still close it, not fail on a decision about nothing. And the audit log's guard didn't cover TRUNCATE.
CREATE OR REPLACE FUNCTION app.decide_appeal(target uuid, uphold boolean) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  s app.statements_of_reasons;
BEGIN
  IF NOT app.is_moderator() THEN
    RAISE EXCEPTION 'only moderators decide appeals' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO s FROM app.statements_of_reasons WHERE public_id = target FOR UPDATE;
  IF NOT FOUND OR s.appeal_status <> 'appealed' THEN RETURN 'not_open'; END IF;
  IF s.decided_by = app.current_user_id() OR s.affected_id = app.current_user_id() THEN RETURN 'same_person'; END IF;
  UPDATE app.statements_of_reasons
     SET appeal_status = CASE WHEN uphold THEN 'upheld' ELSE 'overturned' END, appeal_decided_at = clock_timestamp()
   WHERE id = s.id;
  IF NOT uphold AND (s.question_id IS NOT NULL OR s.answer_id IS NOT NULL) AND NOT EXISTS (
    SELECT 1 FROM app.decisions d
    WHERE d.decision = 'remove' AND d.decided_at > s.issued_at
      AND d.question_id IS NOT DISTINCT FROM s.question_id AND d.answer_id IS NOT DISTINCT FROM s.answer_id
  ) THEN
    INSERT INTO app.decisions (question_id, answer_id, decision, decided_by)
      VALUES (s.question_id, s.answer_id, 'keep', app.current_user_id());
  END IF;
  -- Decided: the copy has done its job.
  UPDATE app.legal_holds SET released_at = clock_timestamp(), content = NULL
   WHERE statement_id = s.id AND released_at IS NULL;
  RETURN 'decided';
END
$$;

DROP TRIGGER IF EXISTS audit_log_no_truncate ON app.audit_log;
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON app.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION app.audit_log_immutable();

UPDATE app.schema_meta SET version = 72, applied_at = now();
