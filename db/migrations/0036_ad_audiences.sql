-- Audiences (docs/adr/0022-advertising-platform.md part 7): groups a
-- business can reach, made of rotating ad identities only. A business writes
-- what an audience is (a rule, the campaign whose tappers to remind, or the
-- audience to find look-alikes of); only the server's build job decides who
-- is in it, from people who allow personalized ads now. An audience under
-- 100 people can't be ready: it can't be targeted and its size isn't shown.
-- Membership goes with the ad identity, so a person who turns personalized
-- ads off (which rotates it, migration 0030) leaves every audience at once.

INSERT INTO app.feature_flags (name, enabled, note) VALUES
  ('ads_audiences', false, 'Audiences, ad reminders and look-alikes (ADR 0022 part 7). Off: none is built or matched.')
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS app.ad_audiences (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id          uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  advertiser_id      bigint NOT NULL REFERENCES app.ad_advertisers (id) ON DELETE CASCADE,
  name               text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120 AND name !~ '[[:cntrl:]]'),
  kind               text NOT NULL CHECK (kind IN ('segment', 'retargeting', 'lookalike')),
  rule               jsonb,
  source_campaign_id bigint REFERENCES app.ad_campaigns (id) ON DELETE CASCADE,
  seed_audience_id   bigint REFERENCES app.ad_audiences (id) ON DELETE CASCADE,
  expansion          real CHECK (expansion IN (0.01, 0.02, 0.05)),
  status             text NOT NULL DEFAULT 'building' CHECK (status IN ('building', 'ready', 'insufficient')),
  size               integer NOT NULL DEFAULT 0 CHECK (size >= 0),
  built_at           timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- The k >= 100 floor, in the database.
  CHECK (status <> 'ready' OR size >= 100),
  CHECK (kind <> 'segment' OR (rule IS NOT NULL AND jsonb_typeof(rule) = 'object' AND octet_length(rule::text) <= 4000
         AND source_campaign_id IS NULL AND seed_audience_id IS NULL AND expansion IS NULL)),
  CHECK (kind <> 'retargeting' OR (source_campaign_id IS NOT NULL AND rule IS NULL AND seed_audience_id IS NULL
         AND expansion IS NULL)),
  CHECK (kind <> 'lookalike' OR (seed_audience_id IS NOT NULL AND expansion IS NOT NULL AND rule IS NULL
         AND source_campaign_id IS NULL))
);
CREATE INDEX IF NOT EXISTS ad_audiences_advertiser ON app.ad_audiences (advertiser_id);

CREATE TABLE IF NOT EXISTS app.ad_audience_members (
  audience_id bigint NOT NULL REFERENCES app.ad_audiences (id) ON DELETE CASCADE,
  ad_id       uuid NOT NULL REFERENCES app.ad_identities (ad_id) ON DELETE CASCADE,
  -- When the person qualified (a reminder's tap; the build otherwise): reminders cool from it.
  event_at    timestamptz NOT NULL,
  PRIMARY KEY (audience_id, ad_id)
);
CREATE INDEX IF NOT EXISTS ad_audience_members_identity ON app.ad_audience_members (ad_id);

ALTER TABLE app.ad_audiences ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ad_audiences FORCE ROW LEVEL SECURITY;
ALTER TABLE app.ad_audience_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ad_audience_members FORCE ROW LEVEL SECURITY;
GRANT SELECT, DELETE ON app.ad_audiences TO app_api;
GRANT INSERT (advertiser_id, name, kind, rule, source_campaign_id, seed_audience_id, expansion) ON app.ad_audiences TO app_api;
GRANT UPDATE (status, size, built_at) ON app.ad_audiences TO app_api;
GRANT SELECT, INSERT, DELETE ON app.ad_audience_members TO app_api;

-- A business's members see and make its audiences while audiences are on; only the build job sizes them.
DROP POLICY IF EXISTS ad_audiences_read ON app.ad_audiences;
CREATE POLICY ad_audiences_read ON app.ad_audiences FOR SELECT TO app_api
  USING (app.is_system() OR app.is_ad_member(advertiser_id));
DROP POLICY IF EXISTS ad_audiences_make ON app.ad_audiences;
CREATE POLICY ad_audiences_make ON app.ad_audiences FOR INSERT TO app_api
  WITH CHECK (app.flag_on('ads') AND app.flag_on('ads_audiences') AND app.is_ad_member(advertiser_id));
DROP POLICY IF EXISTS ad_audiences_remove ON app.ad_audiences;
CREATE POLICY ad_audiences_remove ON app.ad_audiences FOR DELETE TO app_api
  USING (app.is_system() OR app.is_ad_member(advertiser_id));
DROP POLICY IF EXISTS ad_audiences_build ON app.ad_audiences;
CREATE POLICY ad_audiences_build ON app.ad_audiences FOR UPDATE TO app_api
  USING (app.is_system()) WITH CHECK (app.is_system());
-- Who is in an audience: the system's alone. No business ever reads a member.
DROP POLICY IF EXISTS ad_audience_members_system ON app.ad_audience_members;
CREATE POLICY ad_audience_members_system ON app.ad_audience_members FOR ALL TO app_api
  USING (app.is_system()) WITH CHECK (app.is_system());

-- An audience is built from its own business's campaign or audience, never another's;
-- new ones start building, at most 50 a business.
CREATE OR REPLACE FUNCTION app.guard_ad_audience() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('graphinity.ad-audiences'), hashtext(NEW.advertiser_id::text));
  IF (SELECT count(*) FROM app.ad_audiences a WHERE a.advertiser_id = NEW.advertiser_id) >= 50 THEN
    RAISE EXCEPTION 'at most 50 audiences' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.source_campaign_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM app.ad_campaigns c WHERE c.id = NEW.source_campaign_id AND c.advertiser_id = NEW.advertiser_id) THEN
    RAISE EXCEPTION 'an audience uses its own business''s campaigns' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.seed_audience_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM app.ad_audiences s WHERE s.id = NEW.seed_audience_id AND s.advertiser_id = NEW.advertiser_id
         AND s.kind <> 'lookalike') THEN
    RAISE EXCEPTION 'an audience uses its own business''s audiences' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.status := 'building';
  NEW.size := 0;
  NEW.built_at := NULL;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_ad_audience() FROM PUBLIC;
DROP TRIGGER IF EXISTS ad_audiences_guard ON app.ad_audiences;
CREATE TRIGGER ad_audiences_guard BEFORE INSERT ON app.ad_audiences
  FOR EACH ROW EXECUTE FUNCTION app.guard_ad_audience();

-- Members only of people who allow personalized ads now: the build job can't add anyone else.
CREATE OR REPLACE FUNCTION app.guard_ad_audience_member() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.ad_identities d WHERE d.ad_id = NEW.ad_id
                 AND app.ads_permitted(d.profile_id, 'ads_personalization')) THEN
    RAISE EXCEPTION 'only people who allow personalized ads join audiences' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_ad_audience_member() FROM PUBLIC;
DROP TRIGGER IF EXISTS ad_audience_members_guard ON app.ad_audience_members;
CREATE TRIGGER ad_audience_members_guard BEFORE INSERT ON app.ad_audience_members
  FOR EACH ROW EXECUTE FUNCTION app.guard_ad_audience_member();

-- Campaigns can target an audience of their own business (by its public id).
ALTER TABLE app.ad_targeting DROP CONSTRAINT IF EXISTS ad_targeting_kind_check;
ALTER TABLE app.ad_targeting ADD CONSTRAINT ad_targeting_kind_check
  CHECK (kind IN ('field', 'keyword', 'country', 'interest', 'audience'));
ALTER TABLE app.ad_targeting DROP CONSTRAINT IF EXISTS ad_targeting_audience_value;
ALTER TABLE app.ad_targeting ADD CONSTRAINT ad_targeting_audience_value
  CHECK (kind <> 'audience' OR value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

CREATE OR REPLACE FUNCTION app.guard_ad_targeting_audience() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.kind = 'audience' AND NOT EXISTS (
       SELECT 1 FROM app.ad_audiences a JOIN app.ad_campaigns c ON c.advertiser_id = a.advertiser_id
       WHERE c.id = NEW.campaign_id AND a.public_id = NEW.value::uuid) THEN
    RAISE EXCEPTION 'a campaign targets its own business''s audiences' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_ad_targeting_audience() FROM PUBLIC;
DROP TRIGGER IF EXISTS ad_targeting_audience_guard ON app.ad_targeting;
CREATE TRIGGER ad_targeting_audience_guard BEFORE INSERT OR UPDATE ON app.ad_targeting
  FOR EACH ROW EXECUTE FUNCTION app.guard_ad_targeting_audience();

UPDATE app.schema_meta SET version = 51, applied_at = now();
