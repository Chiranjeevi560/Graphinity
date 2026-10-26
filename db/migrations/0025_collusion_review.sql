-- Collusion review (docs/adr/0017-collusion-detection.md). A background job
-- finds groups of accounts that give each other points by picking each
-- other's answers (src/ml/collusion.ts) and records them here; moderators
-- decide. Nothing is done to anyone automatically:
-- - open: found, waiting for a moderator; its members don't teach search or
--   routing meanwhile (they read this table as the system);
-- - dismissed: a moderator judged it genuine;
-- - confirmed: a moderator judged it collusion. The points the members gave
--   each other are taken back (app.take_back_collusion), and from then on
--   picks between them still count but move no points, as the pair cap does.
-- Only moderators and the job read it. A group is about exactly its members:
-- when any of them deletes their account, the group goes with them.

CREATE TABLE IF NOT EXISTS app.collusion_groups (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- What moderators' pages are given: random, so ids say nothing about how many were found.
  public_id   uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  -- The members as a SHA-256 of their sorted ids: finding the same group again updates it.
  member_key  text NOT NULL UNIQUE CHECK (member_key ~ '^[0-9a-f]{64}$'),
  members     integer NOT NULL CHECK (members >= 3),
  -- Picks among the members, how many their activity predicts, and the ratio.
  inside      integer NOT NULL CHECK (inside >= 0),
  expected    real NOT NULL CHECK (expected >= 0),
  lift        real NOT NULL CHECK (lift >= 0),
  found_at    timestamptz NOT NULL DEFAULT now(),
  seen_at     timestamptz NOT NULL DEFAULT now(),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'confirmed')),
  decided_by  uuid REFERENCES app.profiles (id) ON DELETE SET NULL,
  decided_at  timestamptz,
  CONSTRAINT collusion_decided CHECK ((status = 'open') = (decided_at IS NULL))
);

CREATE TABLE IF NOT EXISTS app.collusion_members (
  group_id    bigint NOT NULL REFERENCES app.collusion_groups (id) ON DELETE CASCADE,
  profile_id  uuid NOT NULL REFERENCES app.profiles (id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, profile_id)
);
CREATE INDEX IF NOT EXISTS collusion_members_profile ON app.collusion_members (profile_id);

ALTER TABLE app.collusion_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.collusion_groups FORCE ROW LEVEL SECURITY;
ALTER TABLE app.collusion_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.collusion_members FORCE ROW LEVEL SECURITY;

GRANT SELECT ON app.collusion_groups, app.collusion_members TO app_api;
GRANT INSERT (member_key, members, inside, expected, lift) ON app.collusion_groups TO app_api;
GRANT UPDATE (members, inside, expected, lift, seen_at, status, decided_by, decided_at) ON app.collusion_groups TO app_api;
GRANT INSERT (group_id, profile_id) ON app.collusion_members TO app_api;

DROP POLICY IF EXISTS collusion_groups_read ON app.collusion_groups;
CREATE POLICY collusion_groups_read ON app.collusion_groups FOR SELECT TO app_api
  USING (app.is_moderator() OR app.is_system());
DROP POLICY IF EXISTS collusion_groups_found ON app.collusion_groups;
CREATE POLICY collusion_groups_found ON app.collusion_groups FOR INSERT TO app_api
  WITH CHECK (app.is_system());
-- Who may change what is the trigger below's job: the system refreshes what
-- it measured, a moderator decides once.
DROP POLICY IF EXISTS collusion_groups_change ON app.collusion_groups;
CREATE POLICY collusion_groups_change ON app.collusion_groups FOR UPDATE TO app_api
  USING (app.is_moderator() OR app.is_system())
  WITH CHECK (app.is_moderator() OR app.is_system());
DROP POLICY IF EXISTS collusion_members_read ON app.collusion_members;
CREATE POLICY collusion_members_read ON app.collusion_members FOR SELECT TO app_api
  USING (app.is_moderator() OR app.is_system());
DROP POLICY IF EXISTS collusion_members_found ON app.collusion_members;
CREATE POLICY collusion_members_found ON app.collusion_members FOR INSERT TO app_api
  WITH CHECK (app.is_system());

CREATE OR REPLACE FUNCTION app.guard_collusion_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- The deciding moderator's account deleted: the database's own cascade
  -- empties decided_by. Foreign-key actions run as the table's owner, a role
  -- the API can't become; trigger depth would be no proof.
  IF current_user = (
    SELECT r.rolname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
    WHERE c.oid = 'app.collusion_groups'::regclass
  ) THEN
    RETURN NEW;
  END IF;
  IF app.is_system() THEN
    -- The job measures; it never decides.
    IF NEW.status IS DISTINCT FROM OLD.status OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
       OR NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
      RAISE EXCEPTION 'only a moderator decides about a group' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  -- A moderator decides once, and only the decision.
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'this group was already decided' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status NOT IN ('dismissed', 'confirmed') OR NEW.members IS DISTINCT FROM OLD.members
     OR NEW.inside IS DISTINCT FROM OLD.inside OR NEW.expected IS DISTINCT FROM OLD.expected
     OR NEW.lift IS DISTINCT FROM OLD.lift OR NEW.seen_at IS DISTINCT FROM OLD.seen_at THEN
    RAISE EXCEPTION 'a moderator can only dismiss or confirm a group' USING ERRCODE = 'check_violation';
  END IF;
  -- Nobody decides about a group they are in.
  IF EXISTS (SELECT 1 FROM app.collusion_members m WHERE m.group_id = OLD.id AND m.profile_id = app.current_user_id()) THEN
    RAISE EXCEPTION 'a moderator can''t decide about a group they are in' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Who and when come from the session and the clock, never the request.
  NEW.decided_by := app.current_user_id();
  NEW.decided_at := clock_timestamp();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_collusion_change() FROM PUBLIC;
DROP TRIGGER IF EXISTS collusion_groups_guard ON app.collusion_groups;
CREATE TRIGGER collusion_groups_guard BEFORE UPDATE ON app.collusion_groups
  FOR EACH ROW EXECUTE FUNCTION app.guard_collusion_change();

-- A member leaving (deleting their account) takes the whole group: its key,
-- numbers and decision were about exactly these people. Runs as the owner:
-- the account's deletion runs as that person, who can't see the group.
CREATE OR REPLACE FUNCTION app.drop_collusion_group() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  DELETE FROM app.collusion_groups WHERE id = OLD.group_id;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.drop_collusion_group() FROM PUBLIC;
DROP TRIGGER IF EXISTS collusion_members_leave ON app.collusion_members;
CREATE TRIGGER collusion_members_leave AFTER DELETE ON app.collusion_members
  FOR EACH ROW EXECUTE FUNCTION app.drop_collusion_group();

-- Whether two people are in the same confirmed group. Read by the points
-- guard while a person picks, who can't see the groups themselves; says
-- nothing but yes or no about the one pair being paid.
CREATE OR REPLACE FUNCTION app.confirmed_collusion(giver uuid, recipient uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.collusion_members a
    JOIN app.collusion_members b ON b.group_id = a.group_id
    JOIN app.collusion_groups g ON g.id = a.group_id
    WHERE a.profile_id = giver AND b.profile_id = recipient AND g.status = 'confirmed')
$$;
REVOKE ALL ON FUNCTION app.confirmed_collusion(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.confirmed_collusion(uuid, uuid) TO app_api;

-- Taking back a confirmed group's points is a ledger row of its own kind,
-- naming the award it cancels, like a changed pick.
ALTER TABLE app.points_ledger DROP CONSTRAINT IF EXISTS points_amount_matches_reason;
ALTER TABLE app.points_ledger ADD CONSTRAINT points_amount_matches_reason CHECK (
  (reason = 'selected' AND amount IN (5, 0) AND reverses IS NULL)
  OR (reason = 'helpful' AND amount IN (2, 0) AND reverses IS NULL)
  OR (reason = 'selection_changed' AND amount IN (-5, 0) AND reverses IS NOT NULL)
  OR (reason = 'collusion' AND amount IN (-5, -2) AND reverses IS NOT NULL));

-- The pair cap (0001), plus: between members of a confirmed group, a pick or
-- mark still counts but moves no points.
CREATE OR REPLACE FUNCTION app.guard_points() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- A null would make the lock key null, and the lock silently not taken.
  IF NEW.giver_id IS NULL OR NEW.recipient_id IS NULL OR NEW.question_id IS NULL THEN
    RAISE EXCEPTION 'points need a giver, a recipient and a question' USING ERRCODE = 'not_null_violation';
  END IF;
  -- The cap count below must see what others just committed: only true at
  -- READ COMMITTED, which a caller could otherwise change for itself.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'points can only move at READ COMMITTED' USING ERRCODE = 'invalid_transaction_state';
  END IF;
  -- One question's pick at a time, then one pair at a time (always this order).
  PERFORM pg_advisory_xact_lock(hashtext('graphinity.pick'), hashtext(NEW.question_id::text));
  PERFORM pg_advisory_xact_lock(hashtext('graphinity.points'), hashtext(NEW.giver_id::text || ':' || NEW.recipient_id::text));
  -- The real time, not the transaction's start: a transaction held open
  -- for a month must not backdate its awards out of the cap's window.
  NEW.created_at := clock_timestamp();
  IF NEW.reason = 'selected' AND EXISTS (
    SELECT 1 FROM app.points_ledger l
    WHERE l.question_id = NEW.question_id AND l.reason = 'selected'
      AND NOT EXISTS (SELECT 1 FROM app.points_ledger r WHERE r.reverses = l.id)
  ) THEN
    RAISE EXCEPTION 'this question''s pick already has its points' USING ERRCODE = 'unique_violation';
  END IF;
  IF NEW.amount > 0 AND (
    SELECT count(*) FROM app.points_ledger l
    WHERE l.giver_id = NEW.giver_id AND l.recipient_id = NEW.recipient_id
      AND l.amount > 0 AND l.created_at > clock_timestamp() - interval '30 days'
      AND NOT EXISTS (SELECT 1 FROM app.points_ledger r WHERE r.reverses = l.id)
  ) >= 3 THEN
    NEW.amount := 0;
  END IF;
  IF NEW.amount > 0 AND app.confirmed_collusion(NEW.giver_id, NEW.recipient_id) THEN
    NEW.amount := 0;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_points() FROM PUBLIC;

-- A moderator takes back every point a confirmed group's members gave each
-- other: one 'collusion' row per award still standing, through the same
-- guard as every ledger write (locks, real time). Awards whose question was
-- deleted can't be named by a guarded row and stay. Runs as the owner, who
-- writes the ledger for the moderator; the checks below are the permission.
CREATE OR REPLACE FUNCTION app.take_back_collusion(target bigint) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  moved integer;
BEGIN
  IF NOT app.is_moderator() THEN
    RAISE EXCEPTION 'only moderators take back points' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.collusion_groups g WHERE g.id = target AND g.status = 'confirmed') THEN
    RAISE EXCEPTION 'points are taken back only from a confirmed group' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM app.collusion_members m WHERE m.group_id = target AND m.profile_id = app.current_user_id()) THEN
    RAISE EXCEPTION 'a moderator can''t act on a group they are in' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO app.points_ledger (recipient_id, giver_id, field, amount, reason, question_id, answer_id, reverses)
    SELECT l.recipient_id, l.giver_id, l.field, -l.amount, 'collusion', l.question_id, l.answer_id, l.id
    FROM app.points_ledger l
    WHERE l.reason IN ('selected', 'helpful') AND l.amount > 0 AND l.question_id IS NOT NULL
      AND l.giver_id IN (SELECT m.profile_id FROM app.collusion_members m WHERE m.group_id = target)
      AND l.recipient_id IN (SELECT m.profile_id FROM app.collusion_members m WHERE m.group_id = target)
      AND NOT EXISTS (SELECT 1 FROM app.points_ledger r WHERE r.reverses = l.id)
    ORDER BY l.id;
  GET DIAGNOSTICS moved = ROW_COUNT;
  RETURN moved;
END
$$;
REVOKE ALL ON FUNCTION app.take_back_collusion(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.take_back_collusion(bigint) TO app_api;

UPDATE app.schema_meta SET version = 40, applied_at = now();
