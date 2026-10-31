-- The merchant pixel (docs/adr/0030-browser-signals-and-pixel.md). A browser can't keep a secret, so a tag
-- carries a public id, and an event counts only from a site the advertiser listed. The Conversions API
-- with its secret key stays the stronger path; only that one may report money.
ALTER TABLE app.ad_advertisers
  ADD COLUMN IF NOT EXISTS pixel_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  ADD COLUMN IF NOT EXISTS pixel_domains text[] NOT NULL DEFAULT '{}';

-- The rule against deciding about your own business is about its status: staff may set their own pixel.
CREATE OR REPLACE FUNCTION app.guard_ad_advertiser() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND app.is_ad_member(NEW.id) THEN
    RAISE EXCEPTION 'a moderator can''t decide about their own advertiser' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION app.set_pixel_domains(target uuid, domains text[]) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  out_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(domains) d
             WHERE d !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$') OR coalesce(array_length(domains, 1), 0) > 10 THEN
    RAISE EXCEPTION 'pixel domains must be plain host names, at most 10' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE app.ad_advertisers a SET pixel_domains = domains
   WHERE a.public_id = target AND EXISTS (
     SELECT 1 FROM app.ad_advertiser_members m WHERE m.advertiser_id = a.id AND m.profile_id = app.current_user_id())
  RETURNING a.pixel_id INTO out_id;
  RETURN out_id;
END
$$;
REVOKE ALL ON FUNCTION app.set_pixel_domains(uuid, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.set_pixel_domains(uuid, text[]) TO app_api;

-- Like app.record_partner_event, without value: a page can claim anything about money.
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
  VALUES (advertiser, subject, in_kind, in_product, (SELECT slug FROM app.fields WHERE slug = in_field), in_external, 0)
  ON CONFLICT (advertiser_id, external_id) DO NOTHING
  RETURNING id INTO added;
  RETURN CASE WHEN added IS NULL THEN 'already' ELSE 'recorded' END;
END
$$;
REVOKE ALL ON FUNCTION app.record_pixel_event(uuid, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_pixel_event(uuid, text, text, text, text, text, text) TO app_api;

UPDATE app.schema_meta SET version = 65, applied_at = now();
