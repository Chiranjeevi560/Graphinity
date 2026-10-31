-- The legal workflow (docs/adr/0027-legal-workflow.md; wording and deadlines for a lawyer to
-- confirm). Complaints get a reference a person can quote; impersonation runs on the short
-- clock; a copyright notice needs a sworn statement. A moderator removing a post produces a
-- statement of reasons its author can read and appeal within 14 days, and a hold that keeps
-- a copy of the post, with no link to anyone, until the appeal window closes.

ALTER TABLE app.grievances ADD COLUMN IF NOT EXISTS reference text UNIQUE;
ALTER TABLE app.grievances ADD COLUMN IF NOT EXISTS sworn boolean NOT NULL DEFAULT false;
UPDATE app.grievances SET reference = 'GRV-' || to_char(received_at, 'YYYYMMDD') || '-' || upper(substr(md5(public_id::text), 1, 8))
  WHERE reference IS NULL;
ALTER TABLE app.grievances DROP CONSTRAINT IF EXISTS grievances_kind_check;
ALTER TABLE app.grievances ADD CONSTRAINT grievances_kind_check
  CHECK (kind IN ('general', 'unlawful_content', 'impersonation', 'personal_data', 'copyright'));
ALTER TABLE app.grievances DROP CONSTRAINT IF EXISTS grievances_copyright_sworn;
ALTER TABLE app.grievances ADD CONSTRAINT grievances_copyright_sworn CHECK (kind <> 'copyright' OR sworn);
GRANT INSERT (sworn) ON app.grievances TO app_api;

CREATE OR REPLACE FUNCTION app.grievance_clock() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- From the database's clock and the kind, never from what was sent.
  NEW.received_at := clock_timestamp();
  NEW.acknowledge_by := NEW.received_at + interval '24 hours';
  NEW.resolve_by := NEW.received_at + CASE WHEN NEW.kind IN ('unlawful_content', 'impersonation')
    THEN interval '72 hours' ELSE interval '15 days' END;
  NEW.acknowledged_at := NULL;
  NEW.resolved_at := NULL;
  -- Random, so a reference says nothing about how many complaints there are.
  NEW.reference := 'GRV-' || to_char(NEW.received_at AT TIME ZONE 'UTC', 'YYYYMMDD') || '-'
    || upper(substr(md5(gen_random_uuid()::text), 1, 8));
  RETURN NEW;
END
$$;

-- Statements: readable by the person affected, appealed once, decided by another moderator.
ALTER TABLE app.statements_of_reasons
  ADD COLUMN IF NOT EXISTS public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  ADD COLUMN IF NOT EXISTS answer_id bigint REFERENCES app.answers (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS affected_id uuid REFERENCES app.profiles (id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS decided_by uuid REFERENCES app.profiles (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS appeal_by timestamptz NOT NULL DEFAULT clock_timestamp() + interval '14 days',
  ADD COLUMN IF NOT EXISTS appeal_status text NOT NULL DEFAULT 'none'
    CHECK (appeal_status IN ('none', 'appealed', 'upheld', 'overturned')),
  ADD COLUMN IF NOT EXISTS appeal_text text CHECK (char_length(appeal_text) <= 2000),
  ADD COLUMN IF NOT EXISTS appealed_at timestamptz,
  ADD COLUMN IF NOT EXISTS appeal_decided_at timestamptz;
CREATE INDEX IF NOT EXISTS statements_affected ON app.statements_of_reasons (affected_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS statements_appealed ON app.statements_of_reasons (appealed_at) WHERE appeal_status = 'appealed';
GRANT INSERT (answer_id, affected_id, decided_by) ON app.statements_of_reasons TO app_api;
DROP POLICY IF EXISTS sor_affected_read ON app.statements_of_reasons;
CREATE POLICY sor_affected_read ON app.statements_of_reasons FOR SELECT TO app_api
  USING (affected_id = app.current_user_id());

-- Appealing has one door: the person affected, in time, once. Runs as the owner because
-- the affected person may read their statement but not write to it.
CREATE OR REPLACE FUNCTION app.appeal_statement(target uuid, why text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE app.statements_of_reasons
     SET appeal_status = 'appealed', appeal_text = why, appealed_at = clock_timestamp()
   WHERE public_id = target AND affected_id = app.current_user_id()
     AND appeal_status = 'none' AND appeal_by > clock_timestamp();
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION app.appeal_statement(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.appeal_statement(uuid, text) TO app_api;

-- Deciding an appeal: a moderator other than whoever decided first. Overturning puts the
-- post back, through the same decisions table every other moderation choice goes through.
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
  IF NOT uphold THEN
    INSERT INTO app.decisions (question_id, answer_id, decision, decided_by)
      VALUES (s.question_id, s.answer_id, 'keep', app.current_user_id());
  END IF;
  -- Decided: the copy has done its job.
  UPDATE app.legal_holds SET released_at = clock_timestamp(), content = NULL
   WHERE statement_id = s.id AND released_at IS NULL;
  RETURN 'decided';
END
$$;
REVOKE ALL ON FUNCTION app.decide_appeal(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.decide_appeal(uuid, boolean) TO app_api;

-- Holds keep the words, not who wrote them, so deleting an account still removes the person.
ALTER TABLE app.legal_holds
  ADD COLUMN IF NOT EXISTS statement_id bigint REFERENCES app.statements_of_reasons (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS content text CHECK (char_length(content) <= 10200),
  ADD COLUMN IF NOT EXISTS release_after timestamptz;
GRANT INSERT (statement_id, content, release_after) ON app.legal_holds TO app_api;
GRANT UPDATE (content) ON app.legal_holds TO app_api;
DROP POLICY IF EXISTS holds_system ON app.legal_holds;
CREATE POLICY holds_system ON app.legal_holds FOR UPDATE TO app_api USING (app.is_system()) WITH CHECK (app.is_system());
DROP POLICY IF EXISTS holds_system_read ON app.legal_holds;
CREATE POLICY holds_system_read ON app.legal_holds FOR SELECT TO app_api USING (app.is_system());
DROP POLICY IF EXISTS sor_system_read ON app.statements_of_reasons;
CREATE POLICY sor_system_read ON app.statements_of_reasons FOR SELECT TO app_api USING (app.is_system());

UPDATE app.schema_meta SET version = 62, applied_at = now();
