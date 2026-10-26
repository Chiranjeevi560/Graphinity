-- Campaigns (docs/adr/0022-advertising-platform.md part 3): advertisers,
-- the people who run them, campaigns with budgets and caps, plain-text ads
-- reviewed by moderators, and targeting. Money is in micro-units of the
-- campaign's currency (1 rupee = 1,000,000), never floating point.
-- Everything here is about businesses and what they want to show; nothing
-- about the people who will see the ads.

-- A business that advertises. Pending until a moderator approves it.
CREATE TABLE IF NOT EXISTS app.ad_advertisers (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id   uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80 AND name = btrim(name)
                                   AND name !~ '[[:cntrl:]]' AND NOT app.has_hidden_marks(name)),
  country     text NOT NULL REFERENCES app.countries (code),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The business's own staff (not the people who see ads): the one ad table
-- besides the identity map allowed to name a person.
CREATE TABLE IF NOT EXISTS app.ad_advertiser_members (
  advertiser_id bigint NOT NULL REFERENCES app.ad_advertisers (id) ON DELETE CASCADE,
  profile_id    uuid NOT NULL REFERENCES app.profiles (id) ON DELETE CASCADE,
  role          text NOT NULL DEFAULT 'manager' CHECK (role IN ('owner', 'manager')),
  added_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (advertiser_id, profile_id)
);
CREATE INDEX IF NOT EXISTS ad_advertiser_members_profile ON app.ad_advertiser_members (profile_id);

CREATE TABLE IF NOT EXISTS app.ad_campaigns (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id           uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  advertiser_id       bigint NOT NULL REFERENCES app.ad_advertisers (id) ON DELETE CASCADE,
  name                text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80 AND name = btrim(name)
                                           AND name !~ '[[:cntrl:]]' AND NOT app.has_hidden_marks(name)),
  objective           text NOT NULL CHECK (objective IN ('awareness', 'clicks', 'conversions')),
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'ended')),
  currency            text NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  -- Per day and in total; the bid is the most it pays for one click.
  daily_budget_micros bigint NOT NULL CHECK (daily_budget_micros BETWEEN 1000000 AND 100000000000000),
  total_budget_micros bigint CHECK (total_budget_micros IS NULL OR total_budget_micros >= daily_budget_micros),
  max_cpc_micros      bigint NOT NULL CHECK (max_cpc_micros BETWEEN 10000 AND 100000000000),
  -- At most this many times a day to the same person (ad identity).
  frequency_cap       smallint NOT NULL DEFAULT 3 CHECK (frequency_cap BETWEEN 1 AND 20),
  starts_at           timestamptz NOT NULL DEFAULT now(),
  ends_at             timestamptz CHECK (ends_at IS NULL OR ends_at > starts_at),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (max_cpc_micros <= daily_budget_micros)
);
CREATE INDEX IF NOT EXISTS ad_campaigns_advertiser ON app.ad_campaigns (advertiser_id);
CREATE INDEX IF NOT EXISTS ad_campaigns_active ON app.ad_campaigns (status) WHERE status = 'active';

-- A plain-text ad: what it says and where it goes. Only an approved one serves.
CREATE TABLE IF NOT EXISTS app.ad_creatives (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id       uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  campaign_id     bigint NOT NULL REFERENCES app.ad_campaigns (id) ON DELETE CASCADE,
  headline        text NOT NULL CHECK (char_length(headline) BETWEEN 5 AND 60 AND headline = btrim(headline)
                                       AND headline !~ '[[:cntrl:]]' AND NOT app.has_hidden_marks(headline)),
  body            text NOT NULL CHECK (char_length(body) BETWEEN 10 AND 150 AND body = btrim(body)
                                       AND body !~ '[[:cntrl:]]' AND NOT app.has_hidden_marks(body)),
  -- Where a tap goes: https only, no credentials in it, at most 500 characters.
  destination_url text NOT NULL CHECK (destination_url ~ '^https://[A-Za-z0-9.-]+\.[A-Za-z]{2,}(:[0-9]{2,5})?(/[^\s@]*)?$'
                                       AND char_length(destination_url) <= 500),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reject_reason   text CHECK (char_length(reject_reason) <= 300),
  reviewed_by     uuid REFERENCES app.profiles (id) ON DELETE SET NULL,
  reviewed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'pending') = (reviewed_at IS NULL)),
  CHECK (status <> 'rejected' OR reject_reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ad_creatives_campaign ON app.ad_creatives (campaign_id);
CREATE INDEX IF NOT EXISTS ad_creatives_pending ON app.ad_creatives (created_at) WHERE status = 'pending';

-- What a campaign targets. Contextual kinds match the page or search
-- (topic, a word in the query, the reader's country); 'interest' matches a
-- person's advertising interests and serves only with ads_behavioral on and
-- their permission (part 4). Several values of one kind are "any of";
-- several kinds are "all of".
CREATE TABLE IF NOT EXISTS app.ad_targeting (
  campaign_id bigint NOT NULL REFERENCES app.ad_campaigns (id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('field', 'keyword', 'country', 'interest')),
  value       text NOT NULL CHECK (char_length(value) BETWEEN 2 AND 40),
  CHECK (kind <> 'keyword' OR (value ~ '^[[:alnum:]]+$' AND value = lower(value))),
  CHECK (kind NOT IN ('field', 'interest') OR value ~ '^[a-z]+(-[a-z]+)*$'),
  CHECK (kind <> 'country' OR value ~ '^[A-Z]{2}$'),
  PRIMARY KEY (campaign_id, kind, value)
);
CREATE INDEX IF NOT EXISTS ad_targeting_lookup ON app.ad_targeting (kind, value);

-- Whether the signed-in person runs this advertiser (as owner or manager).
CREATE OR REPLACE FUNCTION app.is_ad_member(advertiser bigint) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM app.ad_advertiser_members m
                 WHERE m.advertiser_id = advertiser AND m.profile_id = app.current_user_id())
$$;
REVOKE ALL ON FUNCTION app.is_ad_member(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_ad_member(bigint) TO app_api;

CREATE OR REPLACE FUNCTION app.campaign_advertiser(campaign bigint) RETURNS bigint
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$ SELECT c.advertiser_id FROM app.ad_campaigns c WHERE c.id = campaign $$;
REVOKE ALL ON FUNCTION app.campaign_advertiser(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.campaign_advertiser(bigint) TO app_api;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ad_advertisers', 'ad_advertiser_members', 'ad_campaigns', 'ad_creatives', 'ad_targeting'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

GRANT SELECT ON app.ad_advertisers, app.ad_advertiser_members, app.ad_campaigns, app.ad_creatives, app.ad_targeting TO app_api;
-- Advertisers and their owners are created only by app.create_advertiser below.
GRANT UPDATE (status) ON app.ad_advertisers TO app_api;
GRANT INSERT (advertiser_id, profile_id, role) ON app.ad_advertiser_members TO app_api;
GRANT DELETE ON app.ad_advertiser_members TO app_api;
GRANT INSERT (advertiser_id, name, objective, currency, daily_budget_micros, total_budget_micros, max_cpc_micros,
              frequency_cap, starts_at, ends_at) ON app.ad_campaigns TO app_api;
GRANT UPDATE (name, status, daily_budget_micros, total_budget_micros, max_cpc_micros, frequency_cap, ends_at, updated_at)
  ON app.ad_campaigns TO app_api;
GRANT INSERT (campaign_id, headline, body, destination_url) ON app.ad_creatives TO app_api;
GRANT UPDATE (status, reject_reason, reviewed_by, reviewed_at) ON app.ad_creatives TO app_api;
GRANT INSERT, DELETE ON app.ad_targeting TO app_api;

-- Advertisers: a signed-in person creates one (pending) and becomes its owner
-- (app.create_advertiser below); members read theirs; moderators read all and
-- decide status; the server's jobs read all.
DROP POLICY IF EXISTS ad_advertisers_read ON app.ad_advertisers;
CREATE POLICY ad_advertisers_read ON app.ad_advertisers FOR SELECT TO app_api
  USING (app.is_system() OR app.is_moderator() OR app.is_ad_member(id));
DROP POLICY IF EXISTS ad_advertisers_status ON app.ad_advertisers;
CREATE POLICY ad_advertisers_status ON app.ad_advertisers FOR UPDATE TO app_api
  USING (app.is_moderator()) WITH CHECK (app.is_moderator());

DROP POLICY IF EXISTS ad_members_read ON app.ad_advertiser_members;
CREATE POLICY ad_members_read ON app.ad_advertiser_members FOR SELECT TO app_api
  USING (app.is_system() OR app.is_moderator() OR app.is_ad_member(advertiser_id));
-- An owner adds and removes managers; nobody adds themselves anywhere.
DROP POLICY IF EXISTS ad_members_add ON app.ad_advertiser_members;
CREATE POLICY ad_members_add ON app.ad_advertiser_members FOR INSERT TO app_api
  WITH CHECK (role = 'manager' AND EXISTS (
    SELECT 1 FROM app.ad_advertiser_members o
    WHERE o.advertiser_id = ad_advertiser_members.advertiser_id AND o.profile_id = app.current_user_id() AND o.role = 'owner'));
DROP POLICY IF EXISTS ad_members_remove ON app.ad_advertiser_members;
CREATE POLICY ad_members_remove ON app.ad_advertiser_members FOR DELETE TO app_api
  USING (role = 'manager' AND EXISTS (
    SELECT 1 FROM app.ad_advertiser_members o
    WHERE o.advertiser_id = ad_advertiser_members.advertiser_id AND o.profile_id = app.current_user_id() AND o.role = 'owner'));

DROP POLICY IF EXISTS ad_campaigns_read ON app.ad_campaigns;
CREATE POLICY ad_campaigns_read ON app.ad_campaigns FOR SELECT TO app_api
  USING (app.is_system() OR app.is_moderator() OR app.is_ad_member(advertiser_id));
DROP POLICY IF EXISTS ad_campaigns_write ON app.ad_campaigns;
CREATE POLICY ad_campaigns_write ON app.ad_campaigns FOR INSERT TO app_api
  WITH CHECK (app.flag_on('ads') AND app.is_ad_member(advertiser_id));
DROP POLICY IF EXISTS ad_campaigns_change ON app.ad_campaigns;
CREATE POLICY ad_campaigns_change ON app.ad_campaigns FOR UPDATE TO app_api
  USING (app.is_ad_member(advertiser_id)) WITH CHECK (app.is_ad_member(advertiser_id));

DROP POLICY IF EXISTS ad_creatives_read ON app.ad_creatives;
CREATE POLICY ad_creatives_read ON app.ad_creatives FOR SELECT TO app_api
  USING (app.is_system() OR app.is_moderator() OR app.is_ad_member(app.campaign_advertiser(campaign_id)));
DROP POLICY IF EXISTS ad_creatives_write ON app.ad_creatives;
CREATE POLICY ad_creatives_write ON app.ad_creatives FOR INSERT TO app_api
  WITH CHECK (app.flag_on('ads') AND app.is_ad_member(app.campaign_advertiser(campaign_id)));
DROP POLICY IF EXISTS ad_creatives_review ON app.ad_creatives;
CREATE POLICY ad_creatives_review ON app.ad_creatives FOR UPDATE TO app_api
  USING (app.is_moderator()) WITH CHECK (app.is_moderator());

DROP POLICY IF EXISTS ad_targeting_read ON app.ad_targeting;
CREATE POLICY ad_targeting_read ON app.ad_targeting FOR SELECT TO app_api
  USING (app.is_system() OR app.is_moderator() OR app.is_ad_member(app.campaign_advertiser(campaign_id)));
DROP POLICY IF EXISTS ad_targeting_write ON app.ad_targeting;
CREATE POLICY ad_targeting_write ON app.ad_targeting FOR INSERT TO app_api
  WITH CHECK (app.flag_on('ads') AND app.is_ad_member(app.campaign_advertiser(campaign_id)));
DROP POLICY IF EXISTS ad_targeting_remove ON app.ad_targeting;
CREATE POLICY ad_targeting_remove ON app.ad_targeting FOR DELETE TO app_api
  USING (app.is_ad_member(app.campaign_advertiser(campaign_id)));

-- Creating an advertiser makes its creator the owner, in one step: there is
-- no moment where an advertiser has no owner, and nobody else can claim it.
CREATE OR REPLACE FUNCTION app.create_advertiser(in_name text, in_country text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  created app.ad_advertisers;
BEGIN
  IF NOT app.flag_on('ads') THEN
    RAISE EXCEPTION 'advertising is not available' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF app.current_user_id() IS NULL OR app.is_blocked() THEN
    RAISE EXCEPTION 'sign in with an account that can post to advertise' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- At most 3 advertisers per person: enough for real businesses, not a farm of them.
  PERFORM pg_advisory_xact_lock(hashtext('graphinity.advertisers'), hashtext(app.current_user_id()::text));
  IF (SELECT count(*) FROM app.ad_advertiser_members m WHERE m.profile_id = app.current_user_id() AND m.role = 'owner') >= 3 THEN
    RAISE EXCEPTION 'at most 3 advertisers per person' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO app.ad_advertisers (name, country) VALUES (in_name, in_country) RETURNING * INTO created;
  INSERT INTO app.ad_advertiser_members (advertiser_id, profile_id, role) VALUES (created.id, app.current_user_id(), 'owner');
  RETURN created.public_id;
END
$$;
REVOKE ALL ON FUNCTION app.create_advertiser(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_advertiser(text, text) TO app_api;

-- Members change their campaigns, never who reviewed an ad; moderators
-- review ads, never what they say. Who and when come from the session and
-- the clock.
CREATE OR REPLACE FUNCTION app.guard_ad_creative() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Nobody reviews their own business's ads.
    IF app.is_ad_member(app.campaign_advertiser(NEW.campaign_id)) THEN
      RAISE EXCEPTION 'a moderator can''t review their own advertiser''s ads' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.status = 'pending' THEN
      RAISE EXCEPTION 'a reviewed ad stays reviewed' USING ERRCODE = 'check_violation';
    END IF;
    NEW.reviewed_by := app.current_user_id();
    NEW.reviewed_at := clock_timestamp();
    IF NEW.status = 'approved' THEN NEW.reject_reason := NULL; END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_ad_creative() FROM PUBLIC;
DROP TRIGGER IF EXISTS ad_creatives_guard ON app.ad_creatives;
CREATE TRIGGER ad_creatives_guard BEFORE UPDATE ON app.ad_creatives
  FOR EACH ROW EXECUTE FUNCTION app.guard_ad_creative();

-- Nobody approves or suspends their own business.
CREATE OR REPLACE FUNCTION app.guard_ad_advertiser() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF app.is_ad_member(NEW.id) THEN
    RAISE EXCEPTION 'a moderator can''t decide about their own advertiser' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_ad_advertiser() FROM PUBLIC;
DROP TRIGGER IF EXISTS ad_advertisers_guard ON app.ad_advertisers;
CREATE TRIGGER ad_advertisers_guard BEFORE UPDATE ON app.ad_advertisers
  FOR EACH ROW EXECUTE FUNCTION app.guard_ad_advertiser();

CREATE OR REPLACE FUNCTION app.touch_ad_campaign() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- A campaign only moves forward through draft -> active <-> paused -> ended.
  IF OLD.status = 'ended' AND NEW.status <> 'ended' THEN
    RAISE EXCEPTION 'an ended campaign stays ended' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'draft' AND OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'a campaign can''t go back to draft' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.touch_ad_campaign() FROM PUBLIC;
DROP TRIGGER IF EXISTS ad_campaigns_touch ON app.ad_campaigns;
CREATE TRIGGER ad_campaigns_touch BEFORE UPDATE ON app.ad_campaigns
  FOR EACH ROW EXECUTE FUNCTION app.touch_ad_campaign();

UPDATE app.schema_meta SET version = 46, applied_at = now();
