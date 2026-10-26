-- The advertising interest graph (docs/adr/0022-advertising-platform.md part 2):
-- how interested each ad identity is in each topic, from what the person
-- searched for and read in Graphinity, collected only while
-- ads_personalization is permitted for them (app.ads_permitted). Purpose
-- limitation: nothing collected for another purpose (search logs, reading
-- history) is reused here; each signal is recorded at the moment of the
-- search or read, and only as a topic, never the words.
--
-- One row per (ad identity, topic): a score that halves every HALF_LIFE (30
-- days), updated in O(1) per signal by decaying the stored score to now
-- and adding the signal's weight. No event history is kept.

CREATE TABLE IF NOT EXISTS app.ad_interests (
  ad_id       uuid NOT NULL REFERENCES app.ad_identities (ad_id) ON DELETE CASCADE,
  field       text NOT NULL REFERENCES app.fields (slug) ON DELETE CASCADE,
  -- Decayed to updated_at.
  score       double precision NOT NULL CHECK (score >= 0 AND score <= 1000000),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ad_id, field)
);
CREATE INDEX IF NOT EXISTS ad_interests_updated ON app.ad_interests (updated_at);
ALTER TABLE app.ad_interests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ad_interests FORCE ROW LEVEL SECURITY;
GRANT SELECT, DELETE ON app.ad_interests TO app_api;
DROP POLICY IF EXISTS ad_interests_system ON app.ad_interests;
CREATE POLICY ad_interests_system ON app.ad_interests FOR ALL TO app_api
  USING (app.is_system()) WITH CHECK (app.is_system());

-- The score as of now: halves every 30 days.
CREATE OR REPLACE FUNCTION app.decayed(score double precision, at timestamptz) RETURNS double precision
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$ SELECT score * power(0.5, greatest(extract(epoch FROM clock_timestamp() - at), 0) / (30 * 86400.0)) $$;
REVOKE ALL ON FUNCTION app.decayed(double precision, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.decayed(double precision, timestamptz) TO app_api;

-- Records one interest signal for the signed-in person (or for anyone, from
-- the server's own jobs). Does nothing unless ads_personalization is
-- permitted for them now; returns whether it recorded. Runs as the owner,
-- who writes the identity map and interests for them.
CREATE OR REPLACE FUNCTION app.record_ad_interest(person uuid, in_field text, weight double precision)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  id uuid;
BEGIN
  IF person IS DISTINCT FROM app.current_user_id() AND NOT app.is_system() THEN
    RAISE EXCEPTION 'interests are recorded only for the signed-in person' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF weight IS NULL OR weight <= 0 OR weight > 10 THEN
    RAISE EXCEPTION 'an interest signal weighs more than 0 and at most 10' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT app.ads_permitted(person, 'ads_personalization') THEN RETURN false; END IF;
  INSERT INTO app.ad_identities (profile_id) VALUES (person) ON CONFLICT (profile_id) DO NOTHING;
  SELECT i.ad_id INTO id FROM app.ad_identities i WHERE i.profile_id = person;
  INSERT INTO app.ad_interests (ad_id, field, score, updated_at)
  VALUES (id, in_field, weight, clock_timestamp())
  ON CONFLICT (ad_id, field) DO UPDATE SET
    score = least(app.decayed(app.ad_interests.score, app.ad_interests.updated_at) + EXCLUDED.score, 1000000),
    updated_at = EXCLUDED.updated_at;
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION app.record_ad_interest(uuid, text, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_ad_interest(uuid, text, double precision) TO app_api;

-- What the signed-in person's advertising profile says about them, strongest
-- first, as of now: so they can see it, export it and remove any of it.
CREATE OR REPLACE FUNCTION app.my_ad_interests()
  RETURNS TABLE (field text, name text, score double precision, updated_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT a.field, f.name, app.decayed(a.score, a.updated_at), a.updated_at
  FROM app.ad_identities i
  JOIN app.ad_interests a ON a.ad_id = i.ad_id
  JOIN app.fields f ON f.slug = a.field
  WHERE i.profile_id = app.current_user_id()
  ORDER BY 3 DESC, a.field
$$;
REVOKE ALL ON FUNCTION app.my_ad_interests() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_ad_interests() TO app_api;

CREATE OR REPLACE FUNCTION app.forget_ad_interest(in_field text) RETURNS boolean
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  WITH gone AS (
    DELETE FROM app.ad_interests a USING app.ad_identities i
    WHERE i.profile_id = app.current_user_id() AND a.ad_id = i.ad_id AND a.field = in_field
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM gone)
$$;
REVOKE ALL ON FUNCTION app.forget_ad_interest(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.forget_ad_interest(text) TO app_api;

-- Interests not refreshed for 13 months, or faded to almost nothing, go.
CREATE OR REPLACE FUNCTION app.expire_ad_interests() RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  IF NOT app.is_system() THEN
    RAISE EXCEPTION 'only the server''s own jobs expire interests' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM app.ad_interests
  WHERE updated_at < clock_timestamp() - interval '13 months' OR app.decayed(score, updated_at) < 0.01;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION app.expire_ad_interests() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.expire_ad_interests() TO app_api;

-- Turning ads_personalization off now replaces the identity row instead of
-- changing its id: everything any ad table holds under the old ad_id is
-- deleted by its own cascade, in the same transaction as the choice.
CREATE OR REPLACE FUNCTION app.rotate_ad_identity_on_revoke() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  old_epoch integer;
BEGIN
  IF NEW.category = 'ads_personalization' AND NOT NEW.enabled
     AND (TG_OP = 'INSERT' OR OLD.enabled IS DISTINCT FROM NEW.enabled) THEN
    DELETE FROM app.ad_identities WHERE profile_id = NEW.user_id RETURNING epoch INTO old_epoch;
    IF old_epoch IS NOT NULL THEN
      INSERT INTO app.ad_identities (profile_id, epoch, rotated_at) VALUES (NEW.user_id, old_epoch + 1, clock_timestamp());
    END IF;
  END IF;
  RETURN NULL;
END
$$;

UPDATE app.schema_meta SET version = 45, applied_at = now();
