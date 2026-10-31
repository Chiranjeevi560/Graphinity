-- Fixes from the independent review of migrations 0038-0044, all still unreleased in production:
-- rotating ids belong to one business or bidder, so partners can't join lists; withdrawing
-- partner sites removes what they sent; account deletion reaches complaints and experiments;
-- a partner-match that succeeds is actually usable, under a daily quota; product words stay
-- with the system until 25 people have used them; lift reports draw on the privacy budget.

ALTER TABLE app.ad_eids ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT '' CHECK (char_length(scope) <= 40);
CREATE INDEX IF NOT EXISTS ad_eids_scope ON app.ad_eids (scope, eid);

CREATE TABLE IF NOT EXISTS app.ad_match_requests (
  advertiser_id bigint NOT NULL REFERENCES app.ad_advertisers (id) ON DELETE CASCADE,
  day           date NOT NULL,
  requests      integer NOT NULL CHECK (requests > 0),
  PRIMARY KEY (advertiser_id, day)
);
ALTER TABLE app.ad_match_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ad_match_requests FORCE ROW LEVEL SECURITY;
GRANT SELECT ON app.ad_match_requests TO app_api;
DROP POLICY IF EXISTS ad_match_requests_system ON app.ad_match_requests;
CREATE POLICY ad_match_requests_system ON app.ad_match_requests FOR SELECT TO app_api USING (app.is_system());

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
  SELECT k.advertiser_id INTO advertiser FROM app.ad_api_keys k WHERE k.key_hash = in_key_hash AND k.revoked_at IS NULL;
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
  SELECT k.advertiser_id INTO advertiser FROM app.ad_api_keys k WHERE k.key_hash = in_key_hash AND k.revoked_at IS NULL;
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

-- Withdrawing partner sites removes what partners sent about this person, at once.
CREATE OR REPLACE FUNCTION app.partner_forget_on_revoke() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  subject uuid;
BEGIN
  IF NEW.category = 'ads_partner_sites' AND NOT NEW.enabled THEN
    SELECT i.ad_id INTO subject FROM app.ad_identities i WHERE i.profile_id = NEW.user_id;
    IF subject IS NOT NULL THEN
      DELETE FROM app.ad_eids WHERE ad_id = subject;
      DELETE FROM app.ad_partner_events WHERE ad_id = subject;
      DELETE FROM app.ad_audience_members m USING app.ad_audiences a
      WHERE m.audience_id = a.id AND a.kind = 'partner_match' AND m.ad_id = subject;
    END IF;
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.partner_forget_on_revoke() FROM PUBLIC;
DROP TRIGGER IF EXISTS partner_forget ON app.user_consent_settings;
CREATE TRIGGER partner_forget AFTER INSERT OR UPDATE ON app.user_consent_settings
  FOR EACH ROW EXECUTE FUNCTION app.partner_forget_on_revoke();

-- Deleting an account: a complaint keeps its dates and outcome, never the person's words.
CREATE OR REPLACE FUNCTION app.grievance_forget() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE app.grievances SET body = '[removed with the account]' WHERE user_id = OLD.id;
  RETURN OLD;
END
$$;
REVOKE ALL ON FUNCTION app.grievance_forget() FROM PUBLIC;
DROP TRIGGER IF EXISTS profiles_grievance_forget ON app.profiles;
CREATE TRIGGER profiles_grievance_forget BEFORE DELETE ON app.profiles FOR EACH ROW EXECUTE FUNCTION app.grievance_forget();
GRANT UPDATE (body) ON app.grievances TO app_api;

-- Experiment rows go with the account. Reads never select this column.
ALTER TABLE app.exp_unit_metrics ADD COLUMN IF NOT EXISTS subject uuid REFERENCES app.profiles (id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS exp_unit_metrics_subject ON app.exp_unit_metrics (subject);

-- A product's words come from people's titles: nobody else reads them until 25 people have used them.
ALTER TABLE app.products ADD COLUMN IF NOT EXISTS k_reached boolean NOT NULL DEFAULT false;
DROP POLICY IF EXISTS products_system ON app.products;
CREATE POLICY products_system ON app.products FOR ALL TO app_api
  USING (app.is_system() OR (app.is_owner() AND k_reached)) WITH CHECK (app.is_system());
GRANT DELETE ON app.products TO app_api;

-- Lift reads draw on the same daily budget as other reports.
ALTER TABLE app.ad_report_releases DROP CONSTRAINT IF EXISTS ad_report_releases_breakdown_check;
ALTER TABLE app.ad_report_releases ADD CONSTRAINT ad_report_releases_breakdown_check
  CHECK (breakdown IN ('day', 'country', 'placement', 'audience', 'lift'));

UPDATE app.schema_meta SET version = 60, applied_at = now();
