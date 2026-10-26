-- The advertising platform's foundation (docs/adr/0022-advertising-platform.md):
-- its consent purposes, what each country's law allows them to be based on,
-- the pseudonymous identity ad systems know a person by, and the switches
-- that keep every part off until the owner turns it on. One rule, enforced
-- here and by the API: an ad system may use a person's data for a purpose
-- only when app.ads_permitted() says so.

-- Purposes, each its own choice (ADR 0003): never bundled, all off by default.
INSERT INTO app.consent_categories
  (name, purpose, data_description, retention, recipients, policy_version, required_for_service)
VALUES
  ('ads_personalization',
   'Choose the ads you see in Graphinity from what you search for and read here.',
   'Interest categories worked out from your searches and reading in Graphinity, with how strongly and how recently.',
   'Interests fade over time and are deleted after 13 months, when you turn this off, or when you delete your account.',
   'Graphinity only. Advertisers never learn who you are or what you searched; they see only totals across many people.',
   1, false),
  ('ads_measurement',
   'Count whether an ad you saw or tapped in Graphinity led to a visit or purchase with that advertiser.',
   'That you saw or tapped an ad, and whether the advertiser reported a matching visit or purchase.',
   'Up to 13 months, then deleted; removed sooner if you turn this off or delete your account.',
   'Graphinity; advertisers receive only totals across many people, never your identity.',
   1, false),
  ('ads_cross_device',
   'Use one advertising profile on every device where you are signed in to Graphinity.',
   'That your signed-in devices belong to the same Graphinity account; nothing from devices where you are signed out.',
   'While this is on and your account exists.',
   'Graphinity only.',
   1, false),
  ('ads_partner_sites',
   'Let advertisers'' websites and apps that use Graphinity''s tag tell Graphinity what you did there, so you can see related ads in Graphinity.',
   'Pages or products you viewed, and purchases, on participating partner sites, linked to your Graphinity advertising profile.',
   'Up to 180 days, then deleted; removed sooner if you turn this off or delete your account.',
   'Graphinity and the partner site where the activity happened.',
   1, false)
ON CONFLICT (name) DO NOTHING;

-- What each country's law allows each purpose to rest on. country NULL is the
-- rule for every country without its own. basis:
--   opt_in      the person must have turned the purpose on (GDPR, DPDP);
--   opt_out     on unless the person turned it off (allowed for some purposes
--               in some places, e.g. some US states);
--   prohibited  never, whatever anyone chose.
-- legal_approved: a lawyer has approved this rule for this country. Until
-- then the purpose is not used there, consent or not. Only the owner, in the
-- SQL editor, can change these rows: the API can only read them.
CREATE TABLE IF NOT EXISTS app.ad_jurisdiction_rules (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  country        text REFERENCES app.countries (code),
  purpose        text NOT NULL REFERENCES app.consent_categories (name)
                 CHECK (purpose IN ('ads_personalization', 'ads_measurement', 'ads_cross_device', 'ads_partner_sites')),
  basis          text NOT NULL CHECK (basis IN ('opt_in', 'opt_out', 'prohibited')),
  legal_approved boolean NOT NULL DEFAULT false,
  note           text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ad_jurisdiction_one_rule
  ON app.ad_jurisdiction_rules (coalesce(country, ''), purpose);
ALTER TABLE app.ad_jurisdiction_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ad_jurisdiction_rules FORCE ROW LEVEL SECURITY;
GRANT SELECT ON app.ad_jurisdiction_rules TO app_api;
DROP POLICY IF EXISTS ad_jurisdiction_read ON app.ad_jurisdiction_rules;
CREATE POLICY ad_jurisdiction_read ON app.ad_jurisdiction_rules FOR SELECT TO app_api USING (true);

-- The strictest default everywhere: opt-in, not yet approved by a lawyer.
INSERT INTO app.ad_jurisdiction_rules (country, purpose, basis, note)
SELECT NULL, p, 'opt_in', 'Default for every country: the person must turn it on, and a lawyer must approve its use here first.'
FROM unnest(ARRAY['ads_personalization', 'ads_measurement', 'ads_cross_device', 'ads_partner_sites']) AS p
ON CONFLICT DO NOTHING;

-- The identity ad systems know a person by: a random id with no link to the
-- account outside this table, which only the server's own jobs can read.
-- Ad tables (app.ad_*) hold ad_id, never profile_id (a test checks every one).
-- epoch counts rotations: turning ads_personalization off gives the person
-- a new ad_id, so nothing collected before can be joined to what comes after.
CREATE TABLE IF NOT EXISTS app.ad_identities (
  profile_id  uuid PRIMARY KEY REFERENCES app.profiles (id) ON DELETE CASCADE,
  ad_id       uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  epoch       integer NOT NULL DEFAULT 1 CHECK (epoch > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  rotated_at  timestamptz
);
ALTER TABLE app.ad_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ad_identities FORCE ROW LEVEL SECURITY;
GRANT SELECT ON app.ad_identities TO app_api;
GRANT INSERT (profile_id) ON app.ad_identities TO app_api;
DROP POLICY IF EXISTS ad_identities_system ON app.ad_identities;
CREATE POLICY ad_identities_system ON app.ad_identities FOR ALL TO app_api
  USING (app.is_system()) WITH CHECK (app.is_system());

-- The switches: every one off. "ads" is the master; each capability also has its own.
INSERT INTO app.feature_flags (name, enabled, note) VALUES
  ('ads', false, 'The advertising platform (ADR 0022). Off: no ad is selected, shown, measured or learned from.'),
  ('ads_behavioral', false, 'Ads chosen from a person''s interests (consent ads_personalization). Off: ads match only the page.'),
  ('ads_measurement', false, 'Conversion measurement and attribution (consent ads_measurement).'),
  ('ads_cross_device', false, 'One advertising profile across a person''s signed-in devices (consent ads_cross_device).'),
  ('ads_partner_sites', false, 'Partner tag and conversion API for advertisers'' sites (consent ads_partner_sites).'),
  ('ads_rtb', false, 'Real-time bidding with outside exchanges and bidders. Off: only Graphinity''s own auction runs.')
ON CONFLICT (name) DO NOTHING;

CREATE OR REPLACE FUNCTION app.flag_on(flag text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$ SELECT coalesce((SELECT f.enabled FROM app.feature_flags f WHERE f.name = flag), false) $$;
REVOKE ALL ON FUNCTION app.flag_on(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.flag_on(text) TO app_api;

-- Whether an ad system may use this person's data for this purpose now. All of:
-- the platform and the purpose's own switch are on; the rule for the person's
-- country (or the default) is approved and not prohibited; and the person
-- turned the purpose on (opt_in) or didn't turn it off (opt_out).
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
           WHEN 'ads_partner_sites' THEN 'ads_partner_sites' END)
     AND coalesce((SELECT legal_approved AND basis <> 'prohibited' FROM rule), false)
     AND CASE (SELECT basis FROM rule)
           WHEN 'opt_in' THEN coalesce((SELECT enabled FROM choice), false)
           WHEN 'opt_out' THEN coalesce((SELECT enabled FROM choice), true)
           ELSE false END
$$;
REVOKE ALL ON FUNCTION app.ads_permitted(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ads_permitted(uuid, text) TO app_api;

-- Turning ads_personalization off rotates the person's ad identity at once,
-- in the same transaction as the choice: whatever ad systems hold under the
-- old ad_id can no longer be linked to them (and is deleted as each ad table
-- arrives, by its own cascade or job). Runs as the owner: a person can't read
-- or write identities.
CREATE OR REPLACE FUNCTION app.rotate_ad_identity_on_revoke() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.category = 'ads_personalization' AND NOT NEW.enabled
     AND (TG_OP = 'INSERT' OR OLD.enabled IS DISTINCT FROM NEW.enabled) THEN
    UPDATE app.ad_identities
    SET ad_id = gen_random_uuid(), epoch = epoch + 1, rotated_at = clock_timestamp()
    WHERE profile_id = NEW.user_id;
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.rotate_ad_identity_on_revoke() FROM PUBLIC;
DROP TRIGGER IF EXISTS ad_identity_rotate ON app.user_consent_settings;
CREATE TRIGGER ad_identity_rotate AFTER INSERT OR UPDATE OF enabled ON app.user_consent_settings
  FOR EACH ROW EXECUTE FUNCTION app.rotate_ad_identity_on_revoke();

-- An ad purpose is offered only while the platform is on: nobody is asked
-- about something that doesn't run. Turning one on is refused while it isn't
-- offered; turning one off is always allowed, so anyone who said yes earlier
-- can withdraw, and keeps seeing the choice until they do.
CREATE OR REPLACE FUNCTION app.consent_offered(category text) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$ SELECT category NOT LIKE 'ads\_%' OR app.flag_on('ads') $$;
REVOKE ALL ON FUNCTION app.consent_offered(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.consent_offered(text) TO app_api;

CREATE OR REPLACE FUNCTION app.guard_offered_consent() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.enabled AND NOT app.consent_offered(NEW.category) THEN
    RAISE EXCEPTION 'this purpose is not offered' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_offered_consent() FROM PUBLIC;
DROP TRIGGER IF EXISTS consent_offered ON app.user_consent_settings;
CREATE TRIGGER consent_offered BEFORE INSERT OR UPDATE OF enabled ON app.user_consent_settings
  FOR EACH ROW EXECUTE FUNCTION app.guard_offered_consent();

UPDATE app.schema_meta SET version = 44, applied_at = now();
