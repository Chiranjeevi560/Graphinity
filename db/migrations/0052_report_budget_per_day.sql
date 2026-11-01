-- The security review of 2026-11-01: a report over many days cost one charge, as if the days were separate
-- people, but one person can appear on all of them. Each new day now costs its own share, so a privacy budget
-- means what it says. Long ranges take several days to release; what's released stays free to re-read.
ALTER TABLE app.ad_report_releases DROP CONSTRAINT IF EXISTS ad_report_releases_breakdown_check;
ALTER TABLE app.ad_report_releases ADD CONSTRAINT ad_report_releases_breakdown_check
  CHECK (breakdown IN ('day', 'country', 'placement', 'audience', 'lift', 'attribution'));

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
  cost numeric;
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
  -- Per fresh day: one person can be in every day, so days add up, they don't run in parallel.
  cost := in_epsilon * cardinality(fresh);
  IF spent + cost > 2.0 THEN
    RETURN QUERY SELECT 'exhausted'::text, 2.0 - spent;
    RETURN;
  END IF;
  INSERT INTO app.ad_privacy_budget_ledger (advertiser_id, epoch, epsilon_spent) VALUES (advertiser, today, cost)
  ON CONFLICT (advertiser_id, epoch) DO UPDATE SET epsilon_spent = app.ad_privacy_budget_ledger.epsilon_spent + EXCLUDED.epsilon_spent;
  INSERT INTO app.ad_report_releases (campaign_id, day, breakdown, released_on)
  SELECT in_campaign, d, in_breakdown, today FROM unnest(fresh) d;
  RETURN QUERY SELECT 'charged'::text, 2.0 - spent - cost;
END
$$;

UPDATE app.schema_meta SET version = 67, applied_at = now();
