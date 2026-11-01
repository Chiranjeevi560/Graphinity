-- The second review of 2026-11-01. Reading a report again was free with the same noise, but the data under it changes
-- when someone withdraws: the difference between two reads was that person's exact contribution. So every read now
-- costs and draws fresh noise. A business also has a rolling 30-day limit, since one person is in many days' reads.
DROP FUNCTION app.release_ad_report(bigint, date[], text, numeric);
CREATE FUNCTION app.release_ad_report(in_campaign bigint, in_days date[], in_breakdown text, in_epsilon numeric)
  RETURNS TABLE (outcome text, remaining numeric)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  advertiser bigint;
  today date := (clock_timestamp() AT TIME ZONE 'UTC')::date;
  spent numeric;
  spent_month numeric;
BEGIN
  IF NOT app.is_system() THEN
    RAISE EXCEPTION 'reports are released by the server' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF in_epsilon IS NULL OR in_epsilon <= 0 OR in_epsilon > 2.0 THEN
    RAISE EXCEPTION 'a release costs more than 0 and at most 2.0' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(in_days) d WHERE d >= today) THEN
    RAISE EXCEPTION 'only complete days are released' USING ERRCODE = 'check_violation';
  END IF;
  SELECT c.advertiser_id INTO advertiser FROM app.ad_campaigns c WHERE c.id = in_campaign;
  IF advertiser IS NULL THEN RAISE EXCEPTION 'no such campaign' USING ERRCODE = 'no_data_found'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('graphinity.ad-privacy'), hashtext(advertiser::text));
  SELECT coalesce(sum(l.epsilon_spent) FILTER (WHERE l.epoch = today), 0), coalesce(sum(l.epsilon_spent), 0)
    INTO spent, spent_month
    FROM app.ad_privacy_budget_ledger l WHERE l.advertiser_id = advertiser AND l.epoch > today - 30;
  IF spent + in_epsilon > 2.0 OR spent_month + in_epsilon > 12.0 THEN
    RETURN QUERY SELECT 'exhausted'::text, least(2.0 - spent, 12.0 - spent_month);
    RETURN;
  END IF;
  INSERT INTO app.ad_privacy_budget_ledger (advertiser_id, epoch, epsilon_spent) VALUES (advertiser, today, in_epsilon)
  ON CONFLICT (advertiser_id, epoch) DO UPDATE SET epsilon_spent = app.ad_privacy_budget_ledger.epsilon_spent + EXCLUDED.epsilon_spent;
  INSERT INTO app.ad_report_releases (campaign_id, day, breakdown, released_on)
  SELECT in_campaign, d, in_breakdown, today FROM unnest(in_days) d
  ON CONFLICT DO NOTHING;
  RETURN QUERY SELECT 'charged'::text, least(2.0 - spent - in_epsilon, 12.0 - spent_month - in_epsilon);
END
$$;
REVOKE ALL ON FUNCTION app.release_ad_report(bigint, date[], text, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.release_ad_report(bigint, date[], text, numeric) TO app_api;

-- A tap can only be measured through an identity, so it can be found and removed when the person withdraws or
-- leaves. Global Privacy Control leaves an impression with no identity, and so no click id.
-- The total budget is counted on the campaign: impressions age out after 13 months, which would hand budget back.
ALTER TABLE app.ad_campaigns ADD COLUMN IF NOT EXISTS spent_total_micros bigint NOT NULL DEFAULT 0 CHECK (spent_total_micros >= 0);
UPDATE app.ad_campaigns c SET spent_total_micros =
  (SELECT coalesce(sum(i.charged_micros), 0) FROM app.ad_impressions i WHERE i.campaign_id = c.id);

CREATE OR REPLACE FUNCTION app.record_ad_click(in_token uuid, clicker uuid)
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
  SELECT i.id, i.campaign_id, i.price_micros, i.shown_at, i.ad_id, c.advertiser_id, cr.destination_url
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
    SELECT coalesce(sum(i.charged_micros), 0) INTO spent
      FROM app.ad_impressions i
      WHERE i.campaign_id = imp.campaign_id AND i.charged_at >= date_trunc('day', clock_timestamp(), 'UTC');
    -- Read under the lock: a pause or a suspension stops charges from that moment.
    IF EXISTS (
         SELECT 1 FROM app.ad_campaigns c JOIN app.ad_advertisers a ON a.id = c.advertiser_id
         WHERE c.id = imp.campaign_id AND c.status = 'active' AND a.status = 'active'
           AND spent + imp.price_micros <= c.daily_budget_micros
           AND (c.total_budget_micros IS NULL OR c.spent_total_micros + imp.price_micros <= c.total_budget_micros)) THEN
      charge := imp.price_micros;
    END IF;
    IF imp.ad_id IS NOT NULL AND clicker IS NOT NULL AND app.ads_permitted(clicker, 'ads_measurement') THEN
      issued := gen_random_uuid();
    END IF;
    UPDATE app.ad_impressions i
       SET clicked_at = clock_timestamp(), charged_micros = charge, click_id = issued,
           charged_at = CASE WHEN charge > 0 THEN clock_timestamp() END
     WHERE i.id = imp.id;
    IF charge > 0 THEN
      UPDATE app.ad_campaigns c SET spent_total_micros = c.spent_total_micros + charge WHERE c.id = imp.campaign_id;
    END IF;
  END IF;
  RETURN QUERY SELECT imp.destination_url, charge, issued;
END
$$;

-- A merchant holding a click id can't keep reporting sales for someone who has withdrawn.
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
  JOIN app.ad_identities d ON d.ad_id = i.ad_id
  WHERE i.click_id = in_click AND c.advertiser_id = advertiser AND app.ads_permitted(d.profile_id, 'ads_measurement');
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

-- Turning measurement off takes what measurement collected, while the identity lives on for personalized ads.
CREATE OR REPLACE FUNCTION app.scrub_measurement_on_revoke() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  identity_id uuid;
BEGIN
  SELECT d.ad_id INTO identity_id FROM app.ad_identities d WHERE d.profile_id = NEW.user_id;
  IF identity_id IS NOT NULL THEN
    DELETE FROM app.ad_conversions c USING app.ad_impressions i WHERE c.impression_id = i.id AND i.ad_id = identity_id;
    UPDATE app.ad_impressions i SET click_id = NULL WHERE i.ad_id = identity_id;
    DELETE FROM app.ad_partner_events e WHERE e.ad_id = identity_id;
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.scrub_measurement_on_revoke() FROM PUBLIC;
DROP TRIGGER IF EXISTS scrub_measurement ON app.user_consent_settings;
CREATE TRIGGER scrub_measurement AFTER INSERT OR UPDATE ON app.user_consent_settings
  FOR EACH ROW WHEN (NEW.category = 'ads_measurement' AND NOT NEW.enabled)
  EXECUTE FUNCTION app.scrub_measurement_on_revoke();

-- The export also says which audiences and rotating ids exist for this person.
CREATE OR REPLACE FUNCTION app.my_ad_memberships() RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'audiences', coalesce((SELECT jsonb_agg(jsonb_build_object('advertiser', adv.name, 'audience', au.name) ORDER BY au.id)
      FROM app.ad_audience_members m JOIN app.ad_audiences au ON au.id = m.audience_id
      JOIN app.ad_advertisers adv ON adv.id = au.advertiser_id
      WHERE m.ad_id = d.ad_id), '[]'::jsonb),
    'rotatingIds', (SELECT count(*) FROM app.ad_eids e WHERE e.ad_id = d.ad_id))
  FROM app.ad_identities d WHERE d.profile_id = app.current_user_id()
$$;
REVOKE ALL ON FUNCTION app.my_ad_memberships() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_ad_memberships() TO app_api;

UPDATE app.schema_meta SET version = 71, applied_at = now();
