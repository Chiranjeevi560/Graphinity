-- What the security review found in ad billing and access (docs/SECURITY.md, review of 2026-11-01).
-- Daily spend was summed by when an ad was shown and charged to that day, so a click after midnight on
-- an ad shown before it cost a day whose budget nothing checked: tokens gathered at 23:00 could overspend
-- without limit. Spend now counts by when the charge happened, and the total budget and the campaign's
-- state are checked under the same lock.
ALTER TABLE app.ad_impressions ADD COLUMN IF NOT EXISTS charged_at timestamptz;
UPDATE app.ad_impressions SET charged_at = clicked_at WHERE charged_micros > 0 AND charged_at IS NULL;
CREATE INDEX IF NOT EXISTS ad_impressions_charged ON app.ad_impressions (campaign_id, charged_at) WHERE charged_at IS NOT NULL;

CREATE OR REPLACE FUNCTION app.record_ad_click(in_token uuid, clicker uuid)
  RETURNS TABLE (destination text, charged bigint, click_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  imp record;
  spent bigint;
  spent_ever bigint;
  charge bigint := 0;
  issued uuid;
BEGIN
  IF NOT app.flag_on('ads') THEN RETURN; END IF;
  SELECT i.id, i.campaign_id, i.price_micros, i.shown_at, c.advertiser_id, cr.destination_url
  INTO imp
  FROM app.ad_impressions i
  JOIN app.ad_campaigns c ON c.id = i.campaign_id
  JOIN app.ad_creatives cr ON cr.id = i.creative_id
  WHERE i.token = in_token;
  IF NOT FOUND OR imp.shown_at < clock_timestamp() - interval '1 hour' THEN RETURN; END IF;
  -- A business's own staff tapping its ad isn't a click: no charge, and nothing that would raise
  -- its predicted click rate and so its rank.
  IF clicker IS NOT NULL AND EXISTS (
       SELECT 1 FROM app.ad_advertiser_members m WHERE m.advertiser_id = imp.advertiser_id AND m.profile_id = clicker) THEN
    RETURN QUERY SELECT imp.destination_url, 0::bigint, NULL::uuid;
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('graphinity.ad-budget'), hashtext(imp.campaign_id::text));
  issued := (SELECT i.click_id FROM app.ad_impressions i WHERE i.id = imp.id);
  IF (SELECT i.clicked_at FROM app.ad_impressions i WHERE i.id = imp.id) IS NULL THEN
    SELECT coalesce(sum(i.charged_micros) FILTER (WHERE i.charged_at >= date_trunc('day', clock_timestamp(), 'UTC')), 0),
           coalesce(sum(i.charged_micros), 0)
      INTO spent, spent_ever
      FROM app.ad_impressions i WHERE i.campaign_id = imp.campaign_id AND i.charged_at IS NOT NULL;
    -- Read under the lock: a pause or a suspension stops charges from that moment.
    IF EXISTS (
         SELECT 1 FROM app.ad_campaigns c JOIN app.ad_advertisers a ON a.id = c.advertiser_id
         WHERE c.id = imp.campaign_id AND c.status = 'active' AND a.status = 'active'
           AND spent + imp.price_micros <= c.daily_budget_micros
           AND (c.total_budget_micros IS NULL OR spent_ever + imp.price_micros <= c.total_budget_micros)) THEN
      charge := imp.price_micros;
    END IF;
    IF clicker IS NOT NULL AND app.ads_permitted(clicker, 'ads_measurement') THEN issued := gen_random_uuid(); END IF;
    UPDATE app.ad_impressions
       SET clicked_at = clock_timestamp(), charged_micros = charge, click_id = issued,
           charged_at = CASE WHEN charge > 0 THEN clock_timestamp() END
     WHERE id = imp.id;
  END IF;
  RETURN QUERY SELECT imp.destination_url, charge, issued;
END
$$;

-- Suspending a business stops its keys, not only its ads.
CREATE OR REPLACE FUNCTION app.active_key_advertiser(in_key_hash text) RETURNS bigint
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT k.advertiser_id FROM app.ad_api_keys k JOIN app.ad_advertisers a ON a.id = k.advertiser_id
  WHERE k.key_hash = in_key_hash AND k.revoked_at IS NULL AND a.status = 'active'
$$;
REVOKE ALL ON FUNCTION app.active_key_advertiser(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.active_key_advertiser(text) TO app_api;

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
  advertiser := app.active_key_advertiser(in_key_hash);
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

CREATE OR REPLACE FUNCTION app.record_partner_event(
  in_key_hash text, in_eid text, in_kind text, in_product text, in_field text, in_external text, in_value bigint)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  advertiser bigint;
  subject uuid;
  added bigint;
BEGIN
  IF NOT (app.flag_on('ads') AND app.flag_on('ads_partner_sites')) THEN RETURN 'unknown'; END IF;
  advertiser := app.active_key_advertiser(in_key_hash);
  IF advertiser IS NULL THEN RETURN 'unknown'; END IF;
  -- Only an id handed to this business: one from a bidder or another business matches nothing.
  SELECT e.ad_id INTO subject FROM app.ad_eids e JOIN app.ad_identities i ON i.ad_id = e.ad_id
  WHERE e.eid = in_eid AND e.scope = 'advertiser:' || advertiser::text AND e.expires_at > clock_timestamp()
    AND app.ads_permitted(i.profile_id, 'ads_partner_sites');
  IF subject IS NULL THEN RETURN 'unknown'; END IF;
  INSERT INTO app.ad_partner_events (advertiser_id, ad_id, kind, product_key, field, external_id, value_micros)
  VALUES (advertiser, subject, in_kind, in_product,
          (SELECT slug FROM app.fields WHERE slug = in_field), in_external, coalesce(in_value, 0))
  ON CONFLICT (advertiser_id, external_id) DO NOTHING
  RETURNING id INTO added;
  RETURN CASE WHEN added IS NULL THEN 'already' ELSE 'recorded' END;
END
$$;

CREATE OR REPLACE FUNCTION app.match_partner_audience(in_key_hash text, in_name text, in_eids text[])
  RETURNS TABLE (public_id uuid, status text, size integer)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  advertiser bigint;
  today date := (clock_timestamp() AT TIME ZONE 'UTC')::date;
  used integer;
  matched uuid[];
  created app.ad_audiences;
BEGIN
  IF NOT (app.flag_on('ads') AND app.flag_on('ads_partner_sites') AND app.flag_on('ads_audiences')) THEN RETURN; END IF;
  advertiser := app.active_key_advertiser(in_key_hash);
  IF advertiser IS NULL THEN RETURN; END IF;
  -- Three tries a day: comparing many lists is how one person's presence would be tested.
  INSERT INTO app.ad_match_requests (advertiser_id, day, requests) VALUES (advertiser, today, 1)
  ON CONFLICT (advertiser_id, day) DO UPDATE SET requests = app.ad_match_requests.requests + 1
  RETURNING requests INTO used;
  IF used > 3 THEN
    RETURN QUERY SELECT NULL::uuid, 'insufficient'::text, 0;
    RETURN;
  END IF;
  SELECT array_agg(DISTINCT e.ad_id) INTO matched
  FROM app.ad_eids e JOIN app.ad_identities i ON i.ad_id = e.ad_id
  WHERE e.eid = ANY (in_eids) AND e.scope = 'advertiser:' || advertiser::text AND e.expires_at > clock_timestamp()
    AND app.ads_permitted(i.profile_id, 'ads_partner_sites')
    AND app.ads_permitted(i.profile_id, 'ads_personalization');
  IF coalesce(array_length(matched, 1), 0) < 100 THEN
    RETURN QUERY SELECT NULL::uuid, 'insufficient'::text, 0;
    RETURN;
  END IF;
  INSERT INTO app.ad_audiences (advertiser_id, name, kind)
  VALUES (advertiser, in_name, 'partner_match')
  RETURNING * INTO created;
  INSERT INTO app.ad_audience_members (audience_id, ad_id, event_at)
  SELECT created.id, m, clock_timestamp() FROM unnest(matched) AS m;
  -- The insert guard starts every audience as building; this one is decided here.
  UPDATE app.ad_audiences a SET status = 'ready', size = array_length(matched, 1), built_at = clock_timestamp()
  WHERE a.id = created.id;
  RETURN QUERY SELECT created.public_id, 'ready'::text, (array_length(matched, 1) / 100) * 100;
END
$$;

-- A pixel event can't take an order number away from the Conversions API: separate id spaces.
CREATE OR REPLACE FUNCTION app.record_pixel_event(
  in_pixel uuid, in_host text, in_eid text, in_kind text, in_product text, in_field text, in_external text)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  advertiser bigint;
  subject uuid;
  added bigint;
BEGIN
  IF NOT (app.flag_on('ads') AND app.flag_on('ads_partner_sites')) THEN RETURN 'off'; END IF;
  SELECT a.id INTO advertiser FROM app.ad_advertisers a
   WHERE a.pixel_id = in_pixel AND a.status = 'active' AND in_host = ANY (a.pixel_domains);
  IF advertiser IS NULL THEN RETURN 'unknown'; END IF;
  SELECT e.ad_id INTO subject FROM app.ad_eids e JOIN app.ad_identities i ON i.ad_id = e.ad_id
   WHERE e.eid = in_eid AND e.expires_at > clock_timestamp() AND e.scope = 'advertiser:' || advertiser::text
     AND app.ads_permitted(i.profile_id, 'ads_partner_sites');
  IF subject IS NULL THEN RETURN 'unknown'; END IF;
  INSERT INTO app.ad_partner_events (advertiser_id, ad_id, kind, product_key, field, external_id, value_micros)
  VALUES (advertiser, subject, in_kind, in_product, (SELECT slug FROM app.fields WHERE slug = in_field),
          left('pixel:' || in_external, 100), 0)
  ON CONFLICT (advertiser_id, external_id) DO NOTHING
  RETURNING id INTO added;
  RETURN CASE WHEN added IS NULL THEN 'already' ELSE 'recorded' END;
END
$$;

-- A blocked person can't build on a business they already had.
DROP POLICY IF EXISTS ad_campaigns_write ON app.ad_campaigns;
CREATE POLICY ad_campaigns_write ON app.ad_campaigns FOR INSERT TO app_api
  WITH CHECK (app.flag_on('ads') AND app.is_ad_member(advertiser_id) AND NOT app.is_blocked());
DROP POLICY IF EXISTS ad_creatives_write ON app.ad_creatives;
CREATE POLICY ad_creatives_write ON app.ad_creatives FOR INSERT TO app_api
  WITH CHECK (app.flag_on('ads') AND app.is_ad_member(app.campaign_advertiser(campaign_id)) AND NOT app.is_blocked());
DROP POLICY IF EXISTS ad_targeting_write ON app.ad_targeting;
CREATE POLICY ad_targeting_write ON app.ad_targeting FOR INSERT TO app_api
  WITH CHECK (app.flag_on('ads') AND app.is_ad_member(app.campaign_advertiser(campaign_id)) AND NOT app.is_blocked());
DROP POLICY IF EXISTS ad_api_keys_make ON app.ad_api_keys;
CREATE POLICY ad_api_keys_make ON app.ad_api_keys FOR INSERT TO app_api
  WITH CHECK (app.flag_on('ads') AND NOT app.is_blocked() AND EXISTS (
    SELECT 1 FROM app.ad_advertiser_members m
    WHERE m.advertiser_id = ad_api_keys.advertiser_id AND m.profile_id = app.current_user_id() AND m.role = 'owner'));

UPDATE app.schema_meta SET version = 66, applied_at = now();
