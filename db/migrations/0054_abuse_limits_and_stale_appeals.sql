-- What the security review of 2026-11-01 found in moderation, collusion, complaints and rollouts.

-- Confirmed collusion: a group goes when any member deletes their account, so a throwaway member could free
-- the rest. What was decided about each pair outlives the group, and goes only with one of that pair.
CREATE TABLE IF NOT EXISTS app.collusion_pairs (
  low   uuid NOT NULL REFERENCES app.profiles (id) ON DELETE CASCADE,
  high  uuid NOT NULL REFERENCES app.profiles (id) ON DELETE CASCADE,
  PRIMARY KEY (low, high),
  CHECK (low < high)
);
CREATE INDEX IF NOT EXISTS collusion_pairs_high ON app.collusion_pairs (high);
ALTER TABLE app.collusion_pairs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.collusion_pairs FORCE ROW LEVEL SECURITY;
GRANT SELECT ON app.collusion_pairs TO app_api;
DROP POLICY IF EXISTS collusion_pairs_read ON app.collusion_pairs;
CREATE POLICY collusion_pairs_read ON app.collusion_pairs FOR SELECT TO app_api USING (app.is_moderator());

CREATE OR REPLACE FUNCTION app.remember_collusion_pairs() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO app.collusion_pairs (low, high)
    SELECT a.profile_id, b.profile_id FROM app.collusion_members a
    JOIN app.collusion_members b ON b.group_id = a.group_id AND a.profile_id < b.profile_id
    WHERE a.group_id = NEW.id
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.remember_collusion_pairs() FROM PUBLIC;
DROP TRIGGER IF EXISTS collusion_confirmed ON app.collusion_groups;
CREATE TRIGGER collusion_confirmed AFTER UPDATE OF status ON app.collusion_groups
  FOR EACH ROW WHEN (NEW.status = 'confirmed' AND OLD.status <> 'confirmed')
  EXECUTE FUNCTION app.remember_collusion_pairs();

INSERT INTO app.collusion_pairs (low, high)
  SELECT a.profile_id, b.profile_id FROM app.collusion_members a
  JOIN app.collusion_members b ON b.group_id = a.group_id AND a.profile_id < b.profile_id
  JOIN app.collusion_groups g ON g.id = a.group_id
  WHERE g.status = 'confirmed'
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION app.confirmed_collusion(giver uuid, recipient uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM app.collusion_pairs p
                 WHERE p.low = LEAST(giver, recipient) AND p.high = GREATEST(giver, recipient))
$$;

-- Three aged accounts' reports hide a post until review. One account's reports beyond ten a day still reach
-- review but stop counting toward hiding, so nobody can hide posts in bulk. It isn't told.
CREATE OR REPLACE FUNCTION app.stamp_moderation() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME = 'reports' THEN
    NEW.created_at := clock_timestamp();
    PERFORM pg_advisory_xact_lock(hashtextextended('report:' || NEW.reporter_id::text, 0));
    NEW.counts := EXISTS (SELECT 1 FROM app.profiles p WHERE p.id = NEW.reporter_id AND p.created_at < now() - interval '1 day')
      AND (SELECT count(*) FROM app.reports r
           WHERE r.reporter_id = NEW.reporter_id AND r.counts AND r.created_at > clock_timestamp() - interval '1 day') < 10;
  ELSE
    NEW.decided_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$$;

-- Complaints have legal deadlines, and the queue shows the 100 soonest. Five open at once per person keeps one
-- account from burying everyone else's.
CREATE OR REPLACE FUNCTION app.limit_open_grievances() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.user_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('grievance:' || NEW.user_id::text, 0));
    IF (SELECT count(*) FROM app.grievances g WHERE g.user_id = NEW.user_id AND g.resolved_at IS NULL) >= 5 THEN
      RAISE EXCEPTION 'at most 5 open complaints' USING ERRCODE = 'GR001';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.limit_open_grievances() FROM PUBLIC;
DROP TRIGGER IF EXISTS grievances_open_limit ON app.grievances;
CREATE TRIGGER grievances_open_limit BEFORE INSERT ON app.grievances
  FOR EACH ROW EXECUTE FUNCTION app.limit_open_grievances();

-- Overturning an old removal must not undo a newer one, made later for its own reasons.
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
  IF NOT uphold AND NOT EXISTS (
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

-- The governor switches off what's rolling out when errors climb. A security check isn't a suspect: load
-- on the site must not be a way to turn it off.
CREATE OR REPLACE FUNCTION app.trip_rollouts() RETURNS SETOF text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT app.is_system() THEN
    RAISE EXCEPTION 'only the governor trips rollouts' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    UPDATE app.feature_flags SET enabled = false, ring = NULL, tripped_at = clock_timestamp(), updated_at = clock_timestamp()
     WHERE enabled AND ring IS NOT NULL AND name <> 'step_up_auth'
    RETURNING name;
END
$$;

-- Two sign-ups at once could both pass the count.
CREATE OR REPLACE FUNCTION app.check_push_count() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('push:' || NEW.profile_id::text, 0));
  IF (SELECT count(*) FROM app.push_subscriptions WHERE profile_id = NEW.profile_id) >= 10 THEN
    RAISE EXCEPTION 'at most 10 devices' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

UPDATE app.schema_meta SET version = 69, applied_at = now();
