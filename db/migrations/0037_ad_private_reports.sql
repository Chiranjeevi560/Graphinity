-- Private advertiser reporting (docs/adr/0022-advertising-platform.md part 8):
-- what a report may break campaigns down by, the secret its noise is seeded
-- from, which breakdowns of which days a business has been shown, and each
-- business's privacy budget per UTC day.

-- Breakdowns: the reader's country (from their profile, never more precise) and the audience
-- that matched, recorded with each impression.
ALTER TABLE app.ad_impressions ADD COLUMN IF NOT EXISTS country text CHECK (country ~ '^[A-Z]{2}$');
ALTER TABLE app.ad_impressions ADD COLUMN IF NOT EXISTS audience_id bigint REFERENCES app.ad_audiences (id) ON DELETE SET NULL;
GRANT INSERT (country, audience_id) ON app.ad_impressions TO app_api;

-- One secret, made by the server on first use (32 random bytes), read only by the system.
CREATE TABLE IF NOT EXISTS app.ad_report_secret (
  id         boolean PRIMARY KEY DEFAULT true CHECK (id),
  secret     bytea NOT NULL CHECK (octet_length(secret) = 32),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Which breakdown of which campaign day has been released: released again, it costs nothing,
-- since its noise is fixed.
CREATE TABLE IF NOT EXISTS app.ad_report_releases (
  campaign_id bigint NOT NULL REFERENCES app.ad_campaigns (id) ON DELETE CASCADE,
  day         date NOT NULL,
  breakdown   text NOT NULL CHECK (breakdown IN ('day', 'country', 'placement', 'audience')),
  released_on date NOT NULL,
  PRIMARY KEY (campaign_id, breakdown, day)
);

-- ε spent per business per UTC day; never more than 2.0 (charter §3.3).
CREATE TABLE IF NOT EXISTS app.ad_privacy_budget_ledger (
  advertiser_id bigint NOT NULL REFERENCES app.ad_advertisers (id) ON DELETE CASCADE,
  epoch         date NOT NULL,
  epsilon_spent numeric(6, 3) NOT NULL DEFAULT 0 CHECK (epsilon_spent >= 0 AND epsilon_spent <= 2.0),
  -- Laplace noise is pure ε-differential privacy: δ stays 0.
  delta_spent   double precision NOT NULL DEFAULT 0 CHECK (delta_spent = 0),
  PRIMARY KEY (advertiser_id, epoch)
);

ALTER TABLE app.ad_report_secret ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ad_report_secret FORCE ROW LEVEL SECURITY;
ALTER TABLE app.ad_report_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ad_report_releases FORCE ROW LEVEL SECURITY;
ALTER TABLE app.ad_privacy_budget_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ad_privacy_budget_ledger FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON app.ad_report_secret TO app_api;
GRANT SELECT ON app.ad_report_releases, app.ad_privacy_budget_ledger TO app_api;

DROP POLICY IF EXISTS ad_report_secret_system ON app.ad_report_secret;
CREATE POLICY ad_report_secret_system ON app.ad_report_secret FOR ALL TO app_api
  USING (app.is_system()) WITH CHECK (app.is_system());
DROP POLICY IF EXISTS ad_report_releases_read ON app.ad_report_releases;
CREATE POLICY ad_report_releases_read ON app.ad_report_releases FOR SELECT TO app_api
  USING (app.is_system() OR app.is_ad_member(app.campaign_advertiser(campaign_id)));
DROP POLICY IF EXISTS ad_privacy_budget_read ON app.ad_privacy_budget_ledger;
CREATE POLICY ad_privacy_budget_read ON app.ad_privacy_budget_ledger FOR SELECT TO app_api
  USING (app.is_system() OR app.is_ad_member(advertiser_id));

-- Charges a release, as the system. Only complete UTC days may be released (a day still under
-- way, released twice with the same noise, would give away the exact change). Days already
-- released in this breakdown cost nothing; any new ones cost in_epsilon once (the days are
-- disjoint, so they compose in parallel). Answers 'free', 'charged' or 'exhausted' (nothing
-- recorded), with what remains of today's budget.
CREATE OR REPLACE FUNCTION app.release_ad_report(
  in_campaign bigint, in_days date[], in_breakdown text, in_epsilon numeric)
  RETURNS TABLE (outcome text, remaining numeric)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  advertiser bigint;
  today date := (clock_timestamp() AT TIME ZONE 'UTC')::date;
  spent numeric;
  fresh date[];
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
  SELECT coalesce((SELECT l.epsilon_spent FROM app.ad_privacy_budget_ledger l
                   WHERE l.advertiser_id = advertiser AND l.epoch = today), 0) INTO spent;
  fresh := ARRAY(SELECT DISTINCT d FROM unnest(in_days) d WHERE NOT EXISTS (
    SELECT 1 FROM app.ad_report_releases r WHERE r.campaign_id = in_campaign AND r.breakdown = in_breakdown AND r.day = d));
  IF cardinality(fresh) = 0 THEN
    RETURN QUERY SELECT 'free'::text, 2.0 - spent;
    RETURN;
  END IF;
  IF spent + in_epsilon > 2.0 THEN
    RETURN QUERY SELECT 'exhausted'::text, 2.0 - spent;
    RETURN;
  END IF;
  INSERT INTO app.ad_privacy_budget_ledger (advertiser_id, epoch, epsilon_spent) VALUES (advertiser, today, in_epsilon)
  ON CONFLICT (advertiser_id, epoch) DO UPDATE SET epsilon_spent = app.ad_privacy_budget_ledger.epsilon_spent + EXCLUDED.epsilon_spent;
  INSERT INTO app.ad_report_releases (campaign_id, day, breakdown, released_on)
  SELECT in_campaign, d, in_breakdown, today FROM unnest(fresh) d;
  RETURN QUERY SELECT 'charged'::text, 2.0 - spent - in_epsilon;
END
$$;
REVOKE ALL ON FUNCTION app.release_ad_report(bigint, date[], text, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.release_ad_report(bigint, date[], text, numeric) TO app_api;

UPDATE app.schema_meta SET version = 52, applied_at = now();
