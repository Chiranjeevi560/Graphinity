-- Outside bidders (docs/adr/0022-advertising-platform.md part 9a): the
-- partners an ad slot may be offered to over OpenRTB 2.6, and the ads of
-- theirs that were shown. A partner is added by the owner once a contract
-- and a lawyer allow it (none exists, and none is enabled by default); its
-- address is https, never an IP address or a local name. What was shown
-- names no person: a partner impression keeps only the placement, the price,
-- where it led and when, for billing and for counting.

CREATE TABLE IF NOT EXISTS app.ad_partners (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL UNIQUE CHECK (char_length(name) BETWEEN 1 AND 80 AND name !~ '[[:cntrl:]]'),
  endpoint   text NOT NULL CHECK (
    char_length(endpoint) <= 500
    -- https, a dotted host name of letters, digits and hyphens (so no IP literal, no userinfo, no port games)
    AND endpoint ~ '^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(/[A-Za-z0-9._~/-]*)?$'
    AND endpoint !~ '^https://([^/]*\.)?(localhost|local|internal|localdomain|home\.arpa)(/|$)'),
  enabled    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.ad_partner_impressions (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token            uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  partner_id       bigint NOT NULL REFERENCES app.ad_partners (id) ON DELETE CASCADE,
  placement        text NOT NULL CHECK (placement IN ('search', 'question')),
  -- What the partner pays for this impression, in micro-units of the request's currency (CPM / 1000).
  price_micros     bigint NOT NULL CHECK (price_micros > 0 AND price_micros <= 1000000000),
  currency         text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  destination_url  text NOT NULL CHECK (destination_url ~ '^https://' AND char_length(destination_url) <= 2000),
  domain           text NOT NULL CHECK (char_length(domain) <= 253),
  shown_at         timestamptz NOT NULL DEFAULT now(),
  clicked_at       timestamptz
);
CREATE INDEX IF NOT EXISTS ad_partner_impressions_shown ON app.ad_partner_impressions (shown_at);

ALTER TABLE app.ad_partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ad_partners FORCE ROW LEVEL SECURITY;
ALTER TABLE app.ad_partner_impressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ad_partner_impressions FORCE ROW LEVEL SECURITY;
GRANT SELECT ON app.ad_partners TO app_api;
GRANT SELECT, INSERT (partner_id, placement, price_micros, currency, destination_url, domain), DELETE
  ON app.ad_partner_impressions TO app_api;
GRANT UPDATE (clicked_at) ON app.ad_partner_impressions TO app_api;
-- Partners: the system reads them; nobody but the owner (outside the API) adds or changes one.
DROP POLICY IF EXISTS ad_partners_system ON app.ad_partners;
CREATE POLICY ad_partners_system ON app.ad_partners FOR SELECT TO app_api USING (app.is_system());
DROP POLICY IF EXISTS ad_partner_impressions_system ON app.ad_partner_impressions;
CREATE POLICY ad_partner_impressions_system ON app.ad_partner_impressions FOR ALL TO app_api
  USING (app.is_system()) WITH CHECK (app.is_system());

-- A tap on a partner's ad: counted once, within an hour of showing it, and where it leads.
CREATE OR REPLACE FUNCTION app.record_partner_click(in_token uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  url text;
BEGIN
  IF NOT (app.flag_on('ads') AND app.flag_on('ads_rtb')) THEN RETURN NULL; END IF;
  UPDATE app.ad_partner_impressions SET clicked_at = coalesce(clicked_at, clock_timestamp())
  WHERE token = in_token AND shown_at > clock_timestamp() - interval '1 hour'
  RETURNING destination_url INTO url;
  RETURN url;
END
$$;
REVOKE ALL ON FUNCTION app.record_partner_click(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_partner_click(uuid) TO app_api;

-- Kept 13 months, like Graphinity's own impressions (0032).
CREATE OR REPLACE FUNCTION app.expire_ad_partner_impressions() RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  n bigint;
BEGIN
  IF NOT app.is_system() THEN
    RAISE EXCEPTION 'only the server expires impressions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM app.ad_partner_impressions WHERE shown_at < clock_timestamp() - interval '13 months';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION app.expire_ad_partner_impressions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.expire_ad_partner_impressions() TO app_api;

UPDATE app.schema_meta SET version = 53, applied_at = now();
