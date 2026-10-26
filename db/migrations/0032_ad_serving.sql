-- Serving ads (docs/adr/0022-advertising-platform.md part 4): what was shown,
-- clicked and charged. An impression names the person's ad identity only
-- when ads_personalization is permitted for them (for frequency caps and,
-- later, measurement); everyone else's impressions name nobody. Turning
-- personalized ads off removes the identity, and with it the link
-- (ON DELETE SET NULL): the counts stay, the person is gone from them.

CREATE TABLE IF NOT EXISTS app.ad_impressions (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- What the page is given: random, so it says nothing about volume.
  token          uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  campaign_id    bigint NOT NULL REFERENCES app.ad_campaigns (id) ON DELETE CASCADE,
  creative_id    bigint NOT NULL REFERENCES app.ad_creatives (id) ON DELETE CASCADE,
  ad_id          uuid REFERENCES app.ad_identities (ad_id) ON DELETE SET NULL,
  placement      text NOT NULL CHECK (placement IN ('search', 'question')),
  -- What a click on it costs (the auction's second price).
  price_micros   bigint NOT NULL CHECK (price_micros > 0),
  shown_at       timestamptz NOT NULL DEFAULT now(),
  clicked_at     timestamptz,
  charged_micros bigint NOT NULL DEFAULT 0 CHECK (charged_micros >= 0 AND charged_micros <= price_micros),
  CHECK (clicked_at IS NOT NULL OR charged_micros = 0)
);
CREATE INDEX IF NOT EXISTS ad_impressions_campaign ON app.ad_impressions (campaign_id, shown_at);
CREATE INDEX IF NOT EXISTS ad_impressions_identity ON app.ad_impressions (ad_id, campaign_id, shown_at) WHERE ad_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ad_impressions_shown ON app.ad_impressions (shown_at);
ALTER TABLE app.ad_impressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ad_impressions FORCE ROW LEVEL SECURITY;
GRANT SELECT, DELETE ON app.ad_impressions TO app_api;
GRANT INSERT (campaign_id, creative_id, ad_id, placement, price_micros) ON app.ad_impressions TO app_api;
DROP POLICY IF EXISTS ad_impressions_system ON app.ad_impressions;
CREATE POLICY ad_impressions_system ON app.ad_impressions FOR ALL TO app_api
  USING (app.is_system()) WITH CHECK (app.is_system());

-- A click on an impression, at most once, within an hour of showing it.
-- Charged its price only if it is a valid click: not by the advertiser's own
-- staff, and within the campaign's daily budget (per UTC day). Returns the
-- destination, or nothing if the token is unknown or too old. One campaign
-- at a time (an advisory lock), so two clicks can't both squeeze under the budget.
CREATE OR REPLACE FUNCTION app.record_ad_click(in_token uuid, clicker uuid)
  RETURNS TABLE (destination text, charged bigint)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  imp record;
  spent bigint;
  charge bigint := 0;
BEGIN
  IF NOT app.flag_on('ads') THEN RETURN; END IF;
  SELECT i.id, i.campaign_id, i.price_micros, i.clicked_at, i.shown_at, c.daily_budget_micros, c.advertiser_id,
         cr.destination_url
  INTO imp
  FROM app.ad_impressions i
  JOIN app.ad_campaigns c ON c.id = i.campaign_id
  JOIN app.ad_creatives cr ON cr.id = i.creative_id
  WHERE i.token = in_token;
  IF NOT FOUND OR imp.shown_at < clock_timestamp() - interval '1 hour' THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('graphinity.ad-budget'), hashtext(imp.campaign_id::text));
  -- Locked and read again: a second click on the same impression sees the first.
  IF (SELECT i.clicked_at FROM app.ad_impressions i WHERE i.id = imp.id) IS NULL THEN
    SELECT coalesce(sum(i.charged_micros), 0) INTO spent FROM app.ad_impressions i
    WHERE i.campaign_id = imp.campaign_id AND i.shown_at >= date_trunc('day', clock_timestamp(), 'UTC');
    IF (clicker IS NULL OR NOT EXISTS (
          SELECT 1 FROM app.ad_advertiser_members m WHERE m.advertiser_id = imp.advertiser_id AND m.profile_id = clicker))
       AND spent + imp.price_micros <= imp.daily_budget_micros THEN
      charge := imp.price_micros;
    END IF;
    UPDATE app.ad_impressions SET clicked_at = clock_timestamp(), charged_micros = charge WHERE id = imp.id;
  END IF;
  RETURN QUERY SELECT imp.destination_url, charge;
END
$$;
REVOKE ALL ON FUNCTION app.record_ad_click(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_ad_click(uuid, uuid) TO app_api;

-- Impressions are kept 13 months, then deleted (the measurement purpose's retention).
CREATE OR REPLACE FUNCTION app.expire_ad_impressions() RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  IF NOT app.is_system() THEN
    RAISE EXCEPTION 'only the server''s own jobs expire impressions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM app.ad_impressions WHERE shown_at < clock_timestamp() - interval '13 months';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION app.expire_ad_impressions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.expire_ad_impressions() TO app_api;

UPDATE app.schema_meta SET version = 47, applied_at = now();
