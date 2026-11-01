-- The partner push needs a choice of its own. People who allowed partner sites agreed that those sites tell Graphinity
-- what they did there, which says nothing about Graphinity sending its interest topics out. Not asked until the push's
-- switch is on and a lawyer has approved it, so nobody sees a question about something that isn't happening.
INSERT INTO app.consent_categories
  (name, purpose, data_description, retention, recipients, policy_version, required_for_service)
VALUES
  ('ads_partner_cohorts',
   'Let Graphinity include you in lists of people interested in a topic, sent to advertising partners so they can show you relevant ads elsewhere.',
   'A topic you showed interest in, with an id that changes every day and differs for each topic and partner. Never your name, handle, email or address, and never health, immigration or legal topics.',
   'We send it no more than once a day. Partners are contractually required to delete it within 30 days.',
   'The advertising partners listed in our privacy policy.',
   1, false)
ON CONFLICT (name) DO NOTHING;

ALTER TABLE app.ad_jurisdiction_rules DROP CONSTRAINT IF EXISTS ad_jurisdiction_rules_purpose_check;
ALTER TABLE app.ad_jurisdiction_rules ADD CONSTRAINT ad_jurisdiction_rules_purpose_check
  CHECK (purpose IN ('ads_personalization', 'ads_measurement', 'ads_cross_device', 'ads_partner_sites', 'ads_partner_cohorts'));
INSERT INTO app.ad_jurisdiction_rules (country, purpose, basis, note)
VALUES (NULL, 'ads_partner_cohorts', 'opt_in', 'Default for every country: the person must turn it on, and a lawyer must approve its use here first.')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION app.ads_permitted(person uuid, purpose text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  WITH rule AS (
    SELECT r.basis, r.legal_approved FROM app.ad_jurisdiction_rules r
    JOIN app.profiles p ON p.id = person
    WHERE r.purpose = ads_permitted.purpose AND (r.country = p.country OR r.country IS NULL)
    ORDER BY r.country IS NULL LIMIT 1
  ), choice AS (
    SELECT s.enabled FROM app.user_consent_settings s WHERE s.user_id = person AND s.category = ads_permitted.purpose
  )
  SELECT app.flag_on('ads')
     AND app.flag_on(CASE purpose
           WHEN 'ads_personalization' THEN 'ads_behavioral'
           WHEN 'ads_measurement' THEN 'ads_measurement'
           WHEN 'ads_cross_device' THEN 'ads_cross_device'
           WHEN 'ads_partner_sites' THEN 'ads_partner_sites'
           WHEN 'ads_partner_cohorts' THEN 'ads_partner_push' END)
     AND coalesce((SELECT legal_approved AND basis <> 'prohibited' FROM rule), false)
     AND CASE (SELECT basis FROM rule)
           WHEN 'opt_in' THEN coalesce((SELECT enabled FROM choice), false)
           WHEN 'opt_out' THEN coalesce((SELECT enabled FROM choice), true)
           ELSE false END
$$;

CREATE OR REPLACE FUNCTION app.consent_offered(category text) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT (category NOT LIKE 'ads\_%' OR app.flag_on('ads'))
    AND (category <> 'ads_partner_cohorts' OR app.flag_on('ads_partner_push'))
$$;

UPDATE app.schema_meta SET version = 80, applied_at = now();
