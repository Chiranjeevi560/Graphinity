-- Graphinity database schema.
--
-- Rules for this file:
--   * Safe to run twice. Apply it in full every time; never hand-pick parts.
--   * Changes are additive only (new tables, new columns with defaults, new
--     constraints validated separately), so an older server keeps working
--     against a newer database during a deploy.
--   * Every rule the API validates is repeated here as a constraint: the API
--     can have bugs, the database is the last line.
--   * Plain SQL only, no psql meta-commands, so it can be pasted into the
--     Supabase SQL editor or applied by a script.

BEGIN;

-- "already exists, skipping" notices are expected on every re-run.
SET LOCAL client_min_messages = warning;

-- Our tables live in their own schema. Supabase's public data API only
-- exposes the "public" schema, so nothing here is reachable with the
-- website's public key, even by mistake.
CREATE SCHEMA IF NOT EXISTS app;
REVOKE ALL ON SCHEMA app FROM PUBLIC;

-- The API's privileges are granted to this group role, which cannot log in.
-- The real login role (created once per environment, password kept out of
-- git; see docs/RUNBOOK.md) is a member of it. The API never owns tables, so
-- row-level security always applies to it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_api') THEN
    CREATE ROLE app_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA app TO app_api;

-- On Supabase these roles exist and receive broad default grants in other
-- schemas. Make sure they never get anything here.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA app FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA app FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA app FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM %I', r);
    END IF;
  END LOOP;
END
$$;

-- Functions are executable by PUBLIC by default; ours should not be.
ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- The signed-in person for the current transaction. The API sets it with
-- set_config('app.user_id', <id>, true) inside each transaction, and
-- row-level security policies compare against it. Empty means anonymous.
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  SET search_path = pg_catalog
AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

REVOKE ALL ON FUNCTION app.current_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_user_id() TO app_api;

-- Records which version of this file was last applied, so the runbook can
-- confirm a deploy reached the database.
CREATE TABLE IF NOT EXISTS app.schema_meta (
  id          boolean PRIMARY KEY DEFAULT true CHECK (id),
  version     integer NOT NULL CHECK (version > 0),
  applied_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.schema_meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.schema_meta FORCE ROW LEVEL SECURITY;
GRANT SELECT ON app.schema_meta TO app_api;
DROP POLICY IF EXISTS schema_meta_read ON app.schema_meta;
CREATE POLICY schema_meta_read ON app.schema_meta FOR SELECT TO app_api USING (true);

-- ---------------------------------------------------------------------------
-- Reference data: countries and fields. Readable by everyone, changed only by
-- this file.
-- ---------------------------------------------------------------------------

-- ISO 3166-1 alpha-2 (249 countries) plus XK for Kosovo. English names from
-- the Unicode CLDR data built into Node; retired codes (SU, YU, ...) removed.
CREATE TABLE IF NOT EXISTS app.countries (
  code  text PRIMARY KEY CHECK (code ~ '^[A-Z]{2}$'),
  name  text NOT NULL CHECK (length(name) BETWEEN 2 AND 60)
);
ALTER TABLE app.countries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.countries FORCE ROW LEVEL SECURITY;
GRANT SELECT ON app.countries TO app_api;
DROP POLICY IF EXISTS countries_read ON app.countries;
CREATE POLICY countries_read ON app.countries FOR SELECT TO app_api USING (true);

INSERT INTO app.countries (code, name) VALUES
  ('AD', 'Andorra'),
  ('AE', 'United Arab Emirates'),
  ('AF', 'Afghanistan'),
  ('AG', 'Antigua & Barbuda'),
  ('AI', 'Anguilla'),
  ('AL', 'Albania'),
  ('AM', 'Armenia'),
  ('AO', 'Angola'),
  ('AQ', 'Antarctica'),
  ('AR', 'Argentina'),
  ('AS', 'American Samoa'),
  ('AT', 'Austria'),
  ('AU', 'Australia'),
  ('AW', 'Aruba'),
  ('AX', 'Åland Islands'),
  ('AZ', 'Azerbaijan'),
  ('BA', 'Bosnia & Herzegovina'),
  ('BB', 'Barbados'),
  ('BD', 'Bangladesh'),
  ('BE', 'Belgium'),
  ('BF', 'Burkina Faso'),
  ('BG', 'Bulgaria'),
  ('BH', 'Bahrain'),
  ('BI', 'Burundi'),
  ('BJ', 'Benin'),
  ('BL', 'St. Barthélemy'),
  ('BM', 'Bermuda'),
  ('BN', 'Brunei'),
  ('BO', 'Bolivia'),
  ('BQ', 'Caribbean Netherlands'),
  ('BR', 'Brazil'),
  ('BS', 'Bahamas'),
  ('BT', 'Bhutan'),
  ('BV', 'Bouvet Island'),
  ('BW', 'Botswana'),
  ('BY', 'Belarus'),
  ('BZ', 'Belize'),
  ('CA', 'Canada'),
  ('CC', 'Cocos (Keeling) Islands'),
  ('CD', 'Congo - Kinshasa'),
  ('CF', 'Central African Republic'),
  ('CG', 'Congo - Brazzaville'),
  ('CH', 'Switzerland'),
  ('CI', 'Côte d’Ivoire'),
  ('CK', 'Cook Islands'),
  ('CL', 'Chile'),
  ('CM', 'Cameroon'),
  ('CN', 'China'),
  ('CO', 'Colombia'),
  ('CR', 'Costa Rica'),
  ('CU', 'Cuba'),
  ('CV', 'Cape Verde'),
  ('CW', 'Curaçao'),
  ('CX', 'Christmas Island'),
  ('CY', 'Cyprus'),
  ('CZ', 'Czechia'),
  ('DE', 'Germany'),
  ('DJ', 'Djibouti'),
  ('DK', 'Denmark'),
  ('DM', 'Dominica'),
  ('DO', 'Dominican Republic'),
  ('DZ', 'Algeria'),
  ('EC', 'Ecuador'),
  ('EE', 'Estonia'),
  ('EG', 'Egypt'),
  ('EH', 'Western Sahara'),
  ('ER', 'Eritrea'),
  ('ES', 'Spain'),
  ('ET', 'Ethiopia'),
  ('FI', 'Finland'),
  ('FJ', 'Fiji'),
  ('FK', 'Falkland Islands'),
  ('FM', 'Micronesia'),
  ('FO', 'Faroe Islands'),
  ('FR', 'France'),
  ('GA', 'Gabon'),
  ('GB', 'United Kingdom'),
  ('GD', 'Grenada'),
  ('GE', 'Georgia'),
  ('GF', 'French Guiana'),
  ('GG', 'Guernsey'),
  ('GH', 'Ghana'),
  ('GI', 'Gibraltar'),
  ('GL', 'Greenland'),
  ('GM', 'Gambia'),
  ('GN', 'Guinea'),
  ('GP', 'Guadeloupe'),
  ('GQ', 'Equatorial Guinea'),
  ('GR', 'Greece'),
  ('GS', 'South Georgia & South Sandwich Islands'),
  ('GT', 'Guatemala'),
  ('GU', 'Guam'),
  ('GW', 'Guinea-Bissau'),
  ('GY', 'Guyana'),
  ('HK', 'Hong Kong SAR China'),
  ('HM', 'Heard & McDonald Islands'),
  ('HN', 'Honduras'),
  ('HR', 'Croatia'),
  ('HT', 'Haiti'),
  ('HU', 'Hungary'),
  ('ID', 'Indonesia'),
  ('IE', 'Ireland'),
  ('IL', 'Israel'),
  ('IM', 'Isle of Man'),
  ('IN', 'India'),
  ('IO', 'British Indian Ocean Territory'),
  ('IQ', 'Iraq'),
  ('IR', 'Iran'),
  ('IS', 'Iceland'),
  ('IT', 'Italy'),
  ('JE', 'Jersey'),
  ('JM', 'Jamaica'),
  ('JO', 'Jordan'),
  ('JP', 'Japan'),
  ('KE', 'Kenya'),
  ('KG', 'Kyrgyzstan'),
  ('KH', 'Cambodia'),
  ('KI', 'Kiribati'),
  ('KM', 'Comoros'),
  ('KN', 'St. Kitts & Nevis'),
  ('KP', 'North Korea'),
  ('KR', 'South Korea'),
  ('KW', 'Kuwait'),
  ('KY', 'Cayman Islands'),
  ('KZ', 'Kazakhstan'),
  ('LA', 'Laos'),
  ('LB', 'Lebanon'),
  ('LC', 'St. Lucia'),
  ('LI', 'Liechtenstein'),
  ('LK', 'Sri Lanka'),
  ('LR', 'Liberia'),
  ('LS', 'Lesotho'),
  ('LT', 'Lithuania'),
  ('LU', 'Luxembourg'),
  ('LV', 'Latvia'),
  ('LY', 'Libya'),
  ('MA', 'Morocco'),
  ('MC', 'Monaco'),
  ('MD', 'Moldova'),
  ('ME', 'Montenegro'),
  ('MF', 'St. Martin'),
  ('MG', 'Madagascar'),
  ('MH', 'Marshall Islands'),
  ('MK', 'North Macedonia'),
  ('ML', 'Mali'),
  ('MM', 'Myanmar (Burma)'),
  ('MN', 'Mongolia'),
  ('MO', 'Macao SAR China'),
  ('MP', 'Northern Mariana Islands'),
  ('MQ', 'Martinique'),
  ('MR', 'Mauritania'),
  ('MS', 'Montserrat'),
  ('MT', 'Malta'),
  ('MU', 'Mauritius'),
  ('MV', 'Maldives'),
  ('MW', 'Malawi'),
  ('MX', 'Mexico'),
  ('MY', 'Malaysia'),
  ('MZ', 'Mozambique'),
  ('NA', 'Namibia'),
  ('NC', 'New Caledonia'),
  ('NE', 'Niger'),
  ('NF', 'Norfolk Island'),
  ('NG', 'Nigeria'),
  ('NI', 'Nicaragua'),
  ('NL', 'Netherlands'),
  ('NO', 'Norway'),
  ('NP', 'Nepal'),
  ('NR', 'Nauru'),
  ('NU', 'Niue'),
  ('NZ', 'New Zealand'),
  ('OM', 'Oman'),
  ('PA', 'Panama'),
  ('PE', 'Peru'),
  ('PF', 'French Polynesia'),
  ('PG', 'Papua New Guinea'),
  ('PH', 'Philippines'),
  ('PK', 'Pakistan'),
  ('PL', 'Poland'),
  ('PM', 'St. Pierre & Miquelon'),
  ('PN', 'Pitcairn Islands'),
  ('PR', 'Puerto Rico'),
  ('PS', 'Palestinian Territories'),
  ('PT', 'Portugal'),
  ('PW', 'Palau'),
  ('PY', 'Paraguay'),
  ('QA', 'Qatar'),
  ('RE', 'Réunion'),
  ('RO', 'Romania'),
  ('RS', 'Serbia'),
  ('RU', 'Russia'),
  ('RW', 'Rwanda'),
  ('SA', 'Saudi Arabia'),
  ('SB', 'Solomon Islands'),
  ('SC', 'Seychelles'),
  ('SD', 'Sudan'),
  ('SE', 'Sweden'),
  ('SG', 'Singapore'),
  ('SH', 'St. Helena'),
  ('SI', 'Slovenia'),
  ('SJ', 'Svalbard & Jan Mayen'),
  ('SK', 'Slovakia'),
  ('SL', 'Sierra Leone'),
  ('SM', 'San Marino'),
  ('SN', 'Senegal'),
  ('SO', 'Somalia'),
  ('SR', 'Suriname'),
  ('SS', 'South Sudan'),
  ('ST', 'São Tomé & Príncipe'),
  ('SV', 'El Salvador'),
  ('SX', 'Sint Maarten'),
  ('SY', 'Syria'),
  ('SZ', 'Eswatini'),
  ('TC', 'Turks & Caicos Islands'),
  ('TD', 'Chad'),
  ('TF', 'French Southern Territories'),
  ('TG', 'Togo'),
  ('TH', 'Thailand'),
  ('TJ', 'Tajikistan'),
  ('TK', 'Tokelau'),
  ('TL', 'Timor-Leste'),
  ('TM', 'Turkmenistan'),
  ('TN', 'Tunisia'),
  ('TO', 'Tonga'),
  ('TR', 'Türkiye'),
  ('TT', 'Trinidad & Tobago'),
  ('TV', 'Tuvalu'),
  ('TW', 'Taiwan'),
  ('TZ', 'Tanzania'),
  ('UA', 'Ukraine'),
  ('UG', 'Uganda'),
  ('UM', 'U.S. Outlying Islands'),
  ('US', 'United States'),
  ('UY', 'Uruguay'),
  ('UZ', 'Uzbekistan'),
  ('VA', 'Vatican City'),
  ('VC', 'St. Vincent & Grenadines'),
  ('VE', 'Venezuela'),
  ('VG', 'British Virgin Islands'),
  ('VI', 'U.S. Virgin Islands'),
  ('VN', 'Vietnam'),
  ('VU', 'Vanuatu'),
  ('WF', 'Wallis & Futuna'),
  ('WS', 'Samoa'),
  ('XK', 'Kosovo'),
  ('YE', 'Yemen'),
  ('YT', 'Mayotte'),
  ('ZA', 'South Africa'),
  ('ZM', 'Zambia'),
  ('ZW', 'Zimbabwe')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;

CREATE TABLE IF NOT EXISTS app.fields (
  slug      text PRIMARY KEY CHECK (slug ~ '^[a-z]+(-[a-z]+)*$' AND length(slug) <= 40),
  name      text NOT NULL CHECK (length(name) BETWEEN 2 AND 40),
  position  smallint NOT NULL
);
ALTER TABLE app.fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.fields FORCE ROW LEVEL SECURITY;
GRANT SELECT ON app.fields TO app_api;
DROP POLICY IF EXISTS fields_read ON app.fields;
CREATE POLICY fields_read ON app.fields FOR SELECT TO app_api USING (true);

INSERT INTO app.fields (slug, name, position) VALUES
  ('imports-customs', 'Imports & Customs', 1),
  ('study-abroad', 'Study Abroad', 2),
  ('visas-immigration', 'Visas & Immigration', 3),
  ('jobs-careers', 'Jobs & Careers', 4),
  ('cars-vehicles', 'Cars & Vehicles', 5),
  ('housing-renting', 'Housing & Renting', 6),
  ('money-tax', 'Money & Tax', 7),
  ('health-hospitals', 'Health & Hospitals', 8),
  ('travel', 'Travel', 9),
  ('phones-gadgets', 'Phones & Gadgets', 10),
  ('software-programming', 'Software & Programming', 11),
  ('business-startups', 'Business & Startups', 12),
  ('legal-matters', 'Legal Matters', 13),
  ('parenting-schools', 'Parenting & Schools', 14),
  ('food-cooking', 'Food & Cooking', 15),
  ('fitness', 'Fitness', 16),
  ('watches-luxury', 'Watches & Luxury', 17),
  ('shopping', 'Shopping', 18),
  ('government-services', 'Government Services', 19),
  ('everything-else', 'Everything Else', 20)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, position = EXCLUDED.position;

-- ---------------------------------------------------------------------------
-- Profiles. The id is the sign-in provider's user id (the token's "sub").
-- Nothing from the Google account is copied here: the person chooses their
-- display name, and their email stays inside Supabase Auth.
-- ---------------------------------------------------------------------------

-- Display names: 3-24 characters of a-z, 0-9, "_" and ".", starting and
-- ending with a letter or digit, no "..", not all digits (so a name can't pose
-- as an id), and not one that impersonates the service. The API applies the
-- same rule (apps/api/src/handles.ts); a test checks the two agree.
CREATE OR REPLACE FUNCTION app.is_valid_handle(h text) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog
AS $$
  SELECT h ~ '^[a-z0-9][a-z0-9._]{1,22}[a-z0-9]$'
     AND h !~ '\.\.'
     AND h !~ '^[0-9]+$'
     AND h !~ '^graphinity'
     AND NOT (h = ANY (ARRAY[
       'about', 'admin', 'administrator', 'anonymous', 'api', 'deleted', 'everyone',
       'help', 'here', 'me', 'mod', 'moderator', 'null', 'official', 'privacy', 'root',
       'security', 'settings', 'staff', 'support', 'system', 'team', 'terms',
       'undefined', 'www'
     ]))
$$;
REVOKE ALL ON FUNCTION app.is_valid_handle(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_valid_handle(text) TO app_api;

CREATE TABLE IF NOT EXISTS app.profiles (
  id                  uuid PRIMARY KEY,
  handle              text NOT NULL CHECK (app.is_valid_handle(handle)),
  country             text NOT NULL REFERENCES app.countries (code),
  -- When the person confirmed they are 18 or older. Required to exist.
  adult_confirmed_at  timestamptz NOT NULL,
  handle_changed_at   timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
-- Handles are lowercase by the check above, so this is case-insensitive.
CREATE UNIQUE INDEX IF NOT EXISTS profiles_handle_key ON app.profiles (handle);
ALTER TABLE app.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.profiles FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON app.profiles TO app_api;
GRANT UPDATE (handle, country, handle_changed_at, updated_at) ON app.profiles TO app_api;
DROP POLICY IF EXISTS profiles_read ON app.profiles;
CREATE POLICY profiles_read ON app.profiles FOR SELECT TO app_api USING (true);
DROP POLICY IF EXISTS profiles_insert_own ON app.profiles;
CREATE POLICY profiles_insert_own ON app.profiles FOR INSERT TO app_api
  WITH CHECK (id = app.current_user_id());
DROP POLICY IF EXISTS profiles_update_own ON app.profiles;
CREATE POLICY profiles_update_own ON app.profiles FOR UPDATE TO app_api
  USING (id = app.current_user_id()) WITH CHECK (id = app.current_user_id());
DROP POLICY IF EXISTS profiles_delete_own ON app.profiles;
CREATE POLICY profiles_delete_own ON app.profiles FOR DELETE TO app_api
  USING (id = app.current_user_id());

CREATE TABLE IF NOT EXISTS app.profile_fields (
  profile_id  uuid NOT NULL REFERENCES app.profiles (id) ON DELETE CASCADE,
  field       text NOT NULL REFERENCES app.fields (slug),
  PRIMARY KEY (profile_id, field)
);
ALTER TABLE app.profile_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.profile_fields FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON app.profile_fields TO app_api;
DROP POLICY IF EXISTS profile_fields_read ON app.profile_fields;
CREATE POLICY profile_fields_read ON app.profile_fields FOR SELECT TO app_api USING (true);
DROP POLICY IF EXISTS profile_fields_insert_own ON app.profile_fields;
CREATE POLICY profile_fields_insert_own ON app.profile_fields FOR INSERT TO app_api
  WITH CHECK (profile_id = app.current_user_id());
DROP POLICY IF EXISTS profile_fields_delete_own ON app.profile_fields;
CREATE POLICY profile_fields_delete_own ON app.profile_fields FOR DELETE TO app_api
  USING (profile_id = app.current_user_id());

-- Every profile has 1 to 8 fields. Checked when the transaction commits, so
-- the API can replace the whole set in one go.
CREATE OR REPLACE FUNCTION app.check_profile_field_count() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  pid uuid;
  n integer;
BEGIN
  -- Separate branches: PL/pgSQL resolves every field reference in an
  -- expression against the firing table, so a single CASE over NEW.id and
  -- OLD.profile_id fails ("record old has no field profile_id").
  IF TG_TABLE_NAME = 'profiles' THEN
    pid := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    pid := OLD.profile_id;
  ELSE
    pid := NEW.profile_id;
  END IF;
  -- A profile deleted in the same transaction takes its fields with it.
  IF NOT EXISTS (SELECT 1 FROM app.profiles WHERE id = pid) THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO n FROM app.profile_fields WHERE profile_id = pid;
  IF n < 1 OR n > 8 THEN
    RAISE EXCEPTION 'a profile needs between 1 and 8 fields' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.check_profile_field_count() FROM PUBLIC;

DROP TRIGGER IF EXISTS profiles_field_count ON app.profiles;
CREATE CONSTRAINT TRIGGER profiles_field_count
  AFTER INSERT ON app.profiles
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_profile_field_count();
DROP TRIGGER IF EXISTS profile_fields_count ON app.profile_fields;
CREATE CONSTRAINT TRIGGER profile_fields_count
  AFTER INSERT OR DELETE ON app.profile_fields
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_profile_field_count();

-- ---------------------------------------------------------------------------
-- Deleted accounts. A sign-in token stays valid for up to an hour after the
-- account behind it is deleted. Until then its holder must not be able to
-- recreate a profile under the same id. Only a keyed hash of the id is kept,
-- and only until every token issued before deletion has expired.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.revoked_subjects (
  subject_hash  text PRIMARY KEY CHECK (subject_hash ~ '^[A-Za-z0-9_-]{22,64}$'),
  until         timestamptz NOT NULL
);
ALTER TABLE app.revoked_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.revoked_subjects FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON app.revoked_subjects TO app_api;
DROP POLICY IF EXISTS revoked_read ON app.revoked_subjects;
CREATE POLICY revoked_read ON app.revoked_subjects FOR SELECT TO app_api USING (true);
DROP POLICY IF EXISTS revoked_insert ON app.revoked_subjects;
CREATE POLICY revoked_insert ON app.revoked_subjects FOR INSERT TO app_api
  WITH CHECK (until <= now() + interval '1 day');
DROP POLICY IF EXISTS revoked_cleanup ON app.revoked_subjects;
CREATE POLICY revoked_cleanup ON app.revoked_subjects FOR DELETE TO app_api
  USING (until < now());

-- ---------------------------------------------------------------------------
-- Sign-ins still to be removed from Supabase after an account was deleted.
-- Deleting an account deletes the profile at once, then asks Supabase to
-- delete the sign-in (which holds the email). If that call fails, the user id
-- is kept here, and only here, until a retry succeeds: it is the one piece of
-- data needed to finish the deletion. The row is removed as soon as Supabase
-- confirms.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.pending_auth_deletions (
  user_id          uuid PRIMARY KEY,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.pending_auth_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.pending_auth_deletions FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON app.pending_auth_deletions TO app_api;
GRANT UPDATE (attempts, next_attempt_at) ON app.pending_auth_deletions TO app_api;
-- A person may only queue their own deletion. The retry job runs without a
-- signed-in identity and may read, update and clear every row.
DROP POLICY IF EXISTS pending_insert_own ON app.pending_auth_deletions;
CREATE POLICY pending_insert_own ON app.pending_auth_deletions FOR INSERT TO app_api
  WITH CHECK (user_id = app.current_user_id());
DROP POLICY IF EXISTS pending_read ON app.pending_auth_deletions;
CREATE POLICY pending_read ON app.pending_auth_deletions FOR SELECT TO app_api
  USING (app.current_user_id() IS NULL OR user_id = app.current_user_id());
DROP POLICY IF EXISTS pending_update_job ON app.pending_auth_deletions;
CREATE POLICY pending_update_job ON app.pending_auth_deletions FOR UPDATE TO app_api
  USING (app.current_user_id() IS NULL) WITH CHECK (app.current_user_id() IS NULL);
DROP POLICY IF EXISTS pending_delete ON app.pending_auth_deletions;
CREATE POLICY pending_delete ON app.pending_auth_deletions FOR DELETE TO app_api
  USING (app.current_user_id() IS NULL OR user_id = app.current_user_id());
CREATE INDEX IF NOT EXISTS pending_auth_deletions_due ON app.pending_auth_deletions (next_attempt_at);

-- No profile may exist for a sign-in that is being deleted. Checked when the
-- transaction commits, so it also catches a "create profile" that raced a
-- "delete account" and waited on its lock.
CREATE OR REPLACE FUNCTION app.check_profile_not_pending_deletion() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM app.pending_auth_deletions WHERE user_id = NEW.id) THEN
    RAISE EXCEPTION 'this account is being deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.check_profile_not_pending_deletion() FROM PUBLIC;
DROP TRIGGER IF EXISTS profiles_not_pending_deletion ON app.profiles;
CREATE CONSTRAINT TRIGGER profiles_not_pending_deletion
  AFTER INSERT ON app.profiles
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_profile_not_pending_deletion();

-- The retry job refreshes the lockout when it finishes a deletion, so it may
-- move an expiry later (never beyond a day).
GRANT UPDATE (until) ON app.revoked_subjects TO app_api;
DROP POLICY IF EXISTS revoked_extend ON app.revoked_subjects;
CREATE POLICY revoked_extend ON app.revoked_subjects FOR UPDATE TO app_api
  USING (true) WITH CHECK (until <= now() + interval '1 day');

-- Bump on every change to this file.
INSERT INTO app.schema_meta (id, version) VALUES (true, 3)
  ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, applied_at = now();

COMMIT;
