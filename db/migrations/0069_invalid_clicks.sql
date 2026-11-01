-- Clicks that shouldn't cost a business anything.
DROP FUNCTION IF EXISTS app.record_ad_click(uuid, uuid);
CREATE OR REPLACE FUNCTION app.record_ad_click(in_token uuid, clicker uuid, may_charge boolean DEFAULT true)
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
           -- Not from someone over their allowance, nor a person this campaign already paid for today: reloading makes a
           -- new impression, so one click per impression alone let a rival drain a budget. Still a click: a sale can follow.
           AND may_charge AND NOT (imp.ad_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM app.ad_impressions p WHERE p.ad_id = imp.ad_id AND p.campaign_id = imp.campaign_id
               AND p.charged_micros > 0 AND p.charged_at > clock_timestamp() - interval '24 hours'))
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
REVOKE ALL ON FUNCTION app.record_ad_click(uuid, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_ad_click(uuid, uuid, boolean) TO app_api;

UPDATE app.schema_meta SET version = 84, applied_at = now();
