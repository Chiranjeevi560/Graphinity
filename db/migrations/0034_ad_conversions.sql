-- Measuring what ads lead to (docs/adr/0022-advertising-platform.md part 6a):
-- an advertiser's server tells Graphinity that a click led to a sale or
-- sign-up. A click carries an id the advertiser can report back only when
-- the person who clicked permits ads_measurement (app.ads_permitted); the
-- id says nothing about them. Advertisers authenticate with an API key
-- shown once and stored only as its SHA-256 (32 random bytes: nothing to
-- guess, so no slow hash is needed).

ALTER TABLE app.ad_impressions ADD COLUMN IF NOT EXISTS click_id uuid UNIQUE;

CREATE TABLE IF NOT EXISTS app.ad_api_keys (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  advertiser_id bigint NOT NULL REFERENCES app.ad_advertisers (id) ON DELETE CASCADE,
  key_hash      text NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  -- The first characters, to tell keys apart on a screen.
  prefix        text NOT NULL CHECK (prefix ~ '^grk_[A-Za-z0-9_-]{6}$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);
CREATE INDEX IF NOT EXISTS ad_api_keys_advertiser ON app.ad_api_keys (advertiser_id);

CREATE TABLE IF NOT EXISTS app.ad_conversions (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  advertiser_id  bigint NOT NULL REFERENCES app.ad_advertisers (id) ON DELETE CASCADE,
  impression_id  bigint NOT NULL REFERENCES app.ad_impressions (id) ON DELETE CASCADE,
  -- The advertiser's own id for it (an order number): reporting it twice counts once.
  external_id    text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 100 AND external_id !~ '[[:cntrl:]]'),
  value_micros   bigint NOT NULL DEFAULT 0 CHECK (value_micros >= 0 AND value_micros <= 1000000000000000),
  currency       text NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  converted_at   timestamptz NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (advertiser_id, external_id)
);
CREATE INDEX IF NOT EXISTS ad_conversions_impression ON app.ad_conversions (impression_id);

ALTER TABLE app.ad_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ad_api_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE app.ad_conversions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ad_conversions FORCE ROW LEVEL SECURITY;
GRANT SELECT ON app.ad_api_keys, app.ad_conversions TO app_api;
GRANT INSERT (advertiser_id, key_hash, prefix) ON app.ad_api_keys TO app_api;
GRANT UPDATE (revoked_at) ON app.ad_api_keys TO app_api;
GRANT UPDATE (click_id) ON app.ad_impressions TO app_api;

-- Keys: a business's owner makes and revokes them (while advertising is on); members see them.
DROP POLICY IF EXISTS ad_api_keys_read ON app.ad_api_keys;
CREATE POLICY ad_api_keys_read ON app.ad_api_keys FOR SELECT TO app_api
  USING (app.is_system() OR app.is_ad_member(advertiser_id));
DROP POLICY IF EXISTS ad_api_keys_make ON app.ad_api_keys;
CREATE POLICY ad_api_keys_make ON app.ad_api_keys FOR INSERT TO app_api
  WITH CHECK (app.flag_on('ads') AND EXISTS (
    SELECT 1 FROM app.ad_advertiser_members m
    WHERE m.advertiser_id = ad_api_keys.advertiser_id AND m.profile_id = app.current_user_id() AND m.role = 'owner'));
DROP POLICY IF EXISTS ad_api_keys_revoke ON app.ad_api_keys;
CREATE POLICY ad_api_keys_revoke ON app.ad_api_keys FOR UPDATE TO app_api
  USING (EXISTS (
    SELECT 1 FROM app.ad_advertiser_members m
    WHERE m.advertiser_id = ad_api_keys.advertiser_id AND m.profile_id = app.current_user_id() AND m.role = 'owner'))
  WITH CHECK (revoked_at IS NOT NULL);

-- Conversions: members read their own business's; only app.record_ad_conversion writes.
DROP POLICY IF EXISTS ad_conversions_read ON app.ad_conversions;
CREATE POLICY ad_conversions_read ON app.ad_conversions FOR SELECT TO app_api
  USING (app.is_system() OR app.is_ad_member(advertiser_id));

-- At most 10 working keys per business, and a revoked key stays revoked.
CREATE OR REPLACE FUNCTION app.guard_ad_api_key() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtext('graphinity.ad-keys'), hashtext(NEW.advertiser_id::text));
    IF (SELECT count(*) FROM app.ad_api_keys k WHERE k.advertiser_id = NEW.advertiser_id AND k.revoked_at IS NULL) >= 10 THEN
      RAISE EXCEPTION 'at most 10 working keys' USING ERRCODE = 'check_violation';
    END IF;
    NEW.created_at := clock_timestamp();
    NEW.revoked_at := NULL;
  ELSE
    IF OLD.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'a revoked key stays revoked' USING ERRCODE = 'check_violation';
    END IF;
    NEW.revoked_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_ad_api_key() FROM PUBLIC;
DROP TRIGGER IF EXISTS ad_api_keys_guard ON app.ad_api_keys;
CREATE TRIGGER ad_api_keys_guard BEFORE INSERT OR UPDATE ON app.ad_api_keys
  FOR EACH ROW EXECUTE FUNCTION app.guard_ad_api_key();

-- Records a conversion an advertiser reports with its key. Counted only when
-- measurement is on, the key works, and the click id is a click on one of
-- that business's own campaigns within the last 30 days, with the
-- conversion after the click (allowing five minutes of clock difference). Answers 'recorded', 'already' (its external
-- id was reported before) or 'unknown' (anything else, without saying
-- which, so keys and click ids can't be probed).
CREATE OR REPLACE FUNCTION app.record_ad_conversion(
  in_key_hash text, in_click uuid, in_external text, in_value bigint, in_currency text, in_at timestamptz)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  advertiser bigint;
  imp record;
  added bigint;
BEGIN
  IF NOT (app.flag_on('ads') AND app.flag_on('ads_measurement')) THEN RETURN 'unknown'; END IF;
  SELECT k.advertiser_id INTO advertiser FROM app.ad_api_keys k WHERE k.key_hash = in_key_hash AND k.revoked_at IS NULL;
  IF advertiser IS NULL THEN RETURN 'unknown'; END IF;
  SELECT i.id, i.clicked_at INTO imp
  FROM app.ad_impressions i JOIN app.ad_campaigns c ON c.id = i.campaign_id
  WHERE i.click_id = in_click AND c.advertiser_id = advertiser;
  IF imp.id IS NULL OR imp.clicked_at < clock_timestamp() - interval '30 days'
     -- Clocks differ, and many advertisers send whole seconds: five minutes either way is allowed.
     OR in_at < imp.clicked_at - interval '5 minutes' OR in_at > clock_timestamp() + interval '5 minutes' THEN
    RETURN 'unknown';
  END IF;
  INSERT INTO app.ad_conversions (advertiser_id, impression_id, external_id, value_micros, currency, converted_at)
  VALUES (advertiser, imp.id, in_external, coalesce(in_value, 0), coalesce(in_currency, 'INR'), in_at)
  ON CONFLICT (advertiser_id, external_id) DO NOTHING
  RETURNING id INTO added;
  RETURN CASE WHEN added IS NULL THEN 'already' ELSE 'recorded' END;
END
$$;
REVOKE ALL ON FUNCTION app.record_ad_conversion(text, uuid, text, bigint, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_ad_conversion(text, uuid, text, bigint, text, timestamptz) TO app_api;

-- A click gets an id to report back only if its clicker permits measurement now.
-- Replaces 0032's version: same rules for counting and charging, plus the id.
-- A new result column means a new function (Postgres can't change it in
-- place); code still running from before reads only the columns it knew.
DROP FUNCTION IF EXISTS app.record_ad_click(uuid, uuid);
CREATE FUNCTION app.record_ad_click(in_token uuid, clicker uuid)
  RETURNS TABLE (destination text, charged bigint, click_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  imp record;
  spent bigint;
  charge bigint := 0;
  issued uuid;
BEGIN
  IF NOT app.flag_on('ads') THEN RETURN; END IF;
  SELECT i.id, i.campaign_id, i.price_micros, i.clicked_at, i.shown_at, c.daily_budget_micros,
         c.advertiser_id, cr.destination_url
  INTO imp
  FROM app.ad_impressions i
  JOIN app.ad_campaigns c ON c.id = i.campaign_id
  JOIN app.ad_creatives cr ON cr.id = i.creative_id
  WHERE i.token = in_token;
  IF NOT FOUND OR imp.shown_at < clock_timestamp() - interval '1 hour' THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('graphinity.ad-budget'), hashtext(imp.campaign_id::text));
  issued := (SELECT i.click_id FROM app.ad_impressions i WHERE i.id = imp.id);
  IF (SELECT i.clicked_at FROM app.ad_impressions i WHERE i.id = imp.id) IS NULL THEN
    SELECT coalesce(sum(i.charged_micros), 0) INTO spent FROM app.ad_impressions i
    WHERE i.campaign_id = imp.campaign_id AND i.shown_at >= date_trunc('day', clock_timestamp(), 'UTC');
    IF (clicker IS NULL OR NOT EXISTS (
          SELECT 1 FROM app.ad_advertiser_members m WHERE m.advertiser_id = imp.advertiser_id AND m.profile_id = clicker))
       AND spent + imp.price_micros <= imp.daily_budget_micros THEN
      charge := imp.price_micros;
    END IF;
    IF clicker IS NOT NULL AND app.ads_permitted(clicker, 'ads_measurement') THEN issued := gen_random_uuid(); END IF;
    UPDATE app.ad_impressions SET clicked_at = clock_timestamp(), charged_micros = charge, click_id = issued WHERE id = imp.id;
  END IF;
  RETURN QUERY SELECT imp.destination_url, charge, issued;
END
$$;
REVOKE ALL ON FUNCTION app.record_ad_click(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_ad_click(uuid, uuid) TO app_api;

UPDATE app.schema_meta SET version = 49, applied_at = now();
