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

-- ---------------------------------------------------------------------------
-- A display name can change once every 7 days, so nobody can hop between
-- names to confuse people. The database's own clock decides: it stamps when
-- the name changed (any value sent is ignored) and refuses a second change
-- within the week.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.stamp_handle_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.handle_changed_at := NULL;
    -- The join date is the database's: limits for new accounts rely on it.
    NEW.created_at := now();
  ELSIF NEW.handle IS DISTINCT FROM OLD.handle THEN
    IF OLD.handle_changed_at IS NOT NULL AND OLD.handle_changed_at + interval '7 days' > now() THEN
      RAISE EXCEPTION 'name changed too recently' USING ERRCODE = 'check_violation';
    END IF;
    NEW.handle_changed_at := now();
  ELSE
    NEW.handle_changed_at := OLD.handle_changed_at;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.stamp_handle_change() FROM PUBLIC;
DROP TRIGGER IF EXISTS profiles_handle_change ON app.profiles;
CREATE TRIGGER profiles_handle_change
  BEFORE INSERT OR UPDATE ON app.profiles
  FOR EACH ROW EXECUTE FUNCTION app.stamp_handle_change();

-- ---------------------------------------------------------------------------
-- Questions and answers. Anyone can read them; only the signed-in author
-- can write their own. Text is plain: trimmed, no control characters (a
-- question title is one line; bodies keep line breaks). Deleting an
-- account deletes its questions and answers (cascade from profiles).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.questions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  asker_id    uuid NOT NULL REFERENCES app.profiles (id) ON DELETE CASCADE,
  field       text NOT NULL REFERENCES app.fields (slug),
  -- The country the question is about, if any. Routing prefers people there.
  country     text REFERENCES app.countries (code),
  title       text NOT NULL CHECK (
                char_length(title) BETWEEN 15 AND 150
                AND title = btrim(title)
                AND title !~ '[[:cntrl:]]'
                AND title !~ '\s{2,}'),
  body        text NOT NULL DEFAULT '' CHECK (
                char_length(body) <= 5000
                AND body = btrim(body)
                AND body !~ '[\x01-\x09\x0B-\x1F\x7F]'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- What matching searches: the title counts more than the details.
  search      tsvector GENERATED ALWAYS AS (
                setweight(to_tsvector('english', title), 'A') || setweight(to_tsvector('english', body), 'B')
              ) STORED
);
CREATE INDEX IF NOT EXISTS questions_search ON app.questions USING gin (search);
CREATE INDEX IF NOT EXISTS questions_recent ON app.questions (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS questions_asker ON app.questions (asker_id);
ALTER TABLE app.questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.questions FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON app.questions TO app_api;
-- Read policy: in the moderation section below (hidden posts).
DROP POLICY IF EXISTS questions_insert_own ON app.questions;
CREATE POLICY questions_insert_own ON app.questions FOR INSERT TO app_api
  WITH CHECK (asker_id = app.current_user_id());

CREATE TABLE IF NOT EXISTS app.answers (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  question_id  bigint NOT NULL REFERENCES app.questions (id) ON DELETE CASCADE,
  answerer_id  uuid NOT NULL REFERENCES app.profiles (id) ON DELETE CASCADE,
  body         text NOT NULL CHECK (
                 char_length(body) BETWEEN 20 AND 10000
                 AND body = btrim(body)
                 AND body !~ '[\x01-\x09\x0B-\x1F\x7F]'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- One answer per person per question.
  UNIQUE (question_id, answerer_id)
);
CREATE INDEX IF NOT EXISTS answers_question ON app.answers (question_id, created_at);
CREATE INDEX IF NOT EXISTS answers_answerer ON app.answers (answerer_id);
ALTER TABLE app.answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.answers FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON app.answers TO app_api;
-- Read policy: in the moderation section below (hidden posts).
-- Your own answer, never to your own question.
DROP POLICY IF EXISTS answers_insert_own ON app.answers;
CREATE POLICY answers_insert_own ON app.answers FOR INSERT TO app_api
  WITH CHECK (
    answerer_id = app.current_user_id()
    AND NOT EXISTS (
      SELECT 1 FROM app.questions q
      WHERE q.id = answers.question_id AND q.asker_id = answers.answerer_id
    )
  );

-- ---------------------------------------------------------------------------
-- Points. The asker picks the answer that helped (+5 to its author in the
-- question's field) and may mark any answer helpful (+2), the picked one too. Points live in an
-- append-only ledger: taking points back is a new, negative row. The API
-- role writes ledger rows itself (from triggers below, running as that
-- role), and the insert policy accepts only rows that match a real
-- selection or helpful mark by the signed-in person, with the amount fixed
-- by the reason. No UPDATE or DELETE is granted on any of these tables;
-- only account deletion changes them (cascades).
--
-- Every function here runs as the caller (no SECURITY DEFINER), names
-- every table with its schema, and puts pg_temp last on its search path,
-- so a temporary table can't stand in for a real one.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.selections (
  question_id    bigint PRIMARY KEY REFERENCES app.questions (id) ON DELETE CASCADE,
  -- Empty only when the picked answer was deleted with its author's account;
  -- the count of changes survives, and picking again is free.
  answer_id      bigint REFERENCES app.answers (id) ON DELETE SET NULL,
  -- How many times the asker changed their pick (at most 2).
  changes        smallint NOT NULL DEFAULT 0 CHECK (changes BETWEEN 0 AND 2),
  -- The reason for a change, sent with that change. Always stored empty,
  -- so a change can't reuse an earlier change's reason by leaving it out.
  change_reason  text CHECK (change_reason IN ('turned_out_wrong', 'better_answer_later', 'picked_by_mistake')),
  -- The reason given for the latest change (written by the database only).
  last_change_reason text CHECK (last_change_reason IN ('turned_out_wrong', 'better_answer_later', 'picked_by_mistake')),
  selected_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS selections_answer ON app.selections (answer_id);
ALTER TABLE app.selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.selections FORCE ROW LEVEL SECURITY;
GRANT SELECT ON app.selections TO app_api;
GRANT INSERT (question_id, answer_id) ON app.selections TO app_api;
GRANT UPDATE (answer_id, change_reason) ON app.selections TO app_api;
DROP POLICY IF EXISTS selections_read ON app.selections;
CREATE POLICY selections_read ON app.selections FOR SELECT TO app_api USING (true);
DROP POLICY IF EXISTS selections_insert_asker ON app.selections;
CREATE POLICY selections_insert_asker ON app.selections FOR INSERT TO app_api
  WITH CHECK (EXISTS (SELECT 1 FROM app.questions q WHERE q.id = selections.question_id AND q.asker_id = app.current_user_id()));
DROP POLICY IF EXISTS selections_update_asker ON app.selections;
CREATE POLICY selections_update_asker ON app.selections FOR UPDATE TO app_api
  USING (EXISTS (SELECT 1 FROM app.questions q WHERE q.id = selections.question_id AND q.asker_id = app.current_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM app.questions q WHERE q.id = selections.question_id AND q.asker_id = app.current_user_id()));

-- The pick must be an answer to that question; a change needs a reason and
-- is counted by the database, whatever the caller sends.
CREATE OR REPLACE FUNCTION app.check_selection() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.answer_id IS NULL THEN
    -- Only the database's own cascade may empty a pick: foreign-key actions
    -- run as the table's owner, a role the API can't become (tested). The
    -- API emptying a pick would get a free change. Trigger depth is no
    -- proof: the API could fire a trigger of its own on a temporary table.
    IF TG_OP = 'UPDATE' AND current_user = (
      SELECT r.rolname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
      WHERE c.oid = 'app.selections'::regclass
    ) THEN
      NEW.change_reason := NULL;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'a pick needs an answer' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.answers a WHERE a.id = NEW.answer_id AND a.question_id = NEW.question_id) THEN
    RAISE EXCEPTION 'that answer is not on this question' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.changes := 0;
    NEW.last_change_reason := NULL;
    NEW.selected_at := clock_timestamp();
  ELSIF OLD.answer_id IS NULL THEN
    -- The old pick was deleted with its author: picking again doesn't count.
    NEW.changes := OLD.changes;
    NEW.last_change_reason := OLD.last_change_reason;
    NEW.selected_at := clock_timestamp();
  ELSIF NEW.answer_id = OLD.answer_id THEN
    NEW.changes := OLD.changes;
    NEW.last_change_reason := OLD.last_change_reason;
    NEW.selected_at := OLD.selected_at;
  ELSE
    IF NEW.change_reason IS NULL THEN
      RAISE EXCEPTION 'a change of pick needs a reason' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.changes >= 2 THEN
      RAISE EXCEPTION 'the pick was already changed twice' USING ERRCODE = 'check_violation';
    END IF;
    -- "It turned out wrong" is also the asker's verdict on the old pick,
    -- written now, while it is still the pick (only the pick can be rated).
    IF NEW.change_reason = 'turned_out_wrong' THEN
      INSERT INTO app.verdicts (answer_id, correct) VALUES (OLD.answer_id, false)
        ON CONFLICT (answer_id) DO UPDATE SET correct = false;
    END IF;
    NEW.changes := OLD.changes + 1;
    NEW.last_change_reason := NEW.change_reason;
    NEW.selected_at := clock_timestamp();
  END IF;
  NEW.change_reason := NULL;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.check_selection() FROM PUBLIC;
DROP TRIGGER IF EXISTS selections_check ON app.selections;
CREATE TRIGGER selections_check BEFORE INSERT OR UPDATE ON app.selections
  FOR EACH ROW EXECUTE FUNCTION app.check_selection();

-- Answers the asker found helpful. Permanent: there is no "unmark".
CREATE TABLE IF NOT EXISTS app.helpful_marks (
  answer_id  bigint PRIMARY KEY REFERENCES app.answers (id) ON DELETE CASCADE,
  marked_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.helpful_marks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.helpful_marks FORCE ROW LEVEL SECURITY;
GRANT SELECT ON app.helpful_marks TO app_api;
GRANT INSERT (answer_id) ON app.helpful_marks TO app_api;
DROP POLICY IF EXISTS helpful_read ON app.helpful_marks;
CREATE POLICY helpful_read ON app.helpful_marks FOR SELECT TO app_api USING (true);
DROP POLICY IF EXISTS helpful_insert_asker ON app.helpful_marks;
CREATE POLICY helpful_insert_asker ON app.helpful_marks FOR INSERT TO app_api
  WITH CHECK (EXISTS (
    SELECT 1 FROM app.answers a JOIN app.questions q ON q.id = a.question_id
    WHERE a.id = helpful_marks.answer_id AND q.asker_id = app.current_user_id()
  ));

CREATE TABLE IF NOT EXISTS app.points_ledger (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipient_id  uuid NOT NULL REFERENCES app.profiles (id) ON DELETE CASCADE,
  -- Set to null when the giver deletes their account: points earned stay,
  -- with no link back to them.
  giver_id      uuid REFERENCES app.profiles (id) ON DELETE SET NULL,
  field         text NOT NULL REFERENCES app.fields (slug),
  amount        smallint NOT NULL,
  reason        text NOT NULL,
  question_id   bigint REFERENCES app.questions (id) ON DELETE SET NULL,
  answer_id     bigint REFERENCES app.answers (id) ON DELETE SET NULL,
  -- A take-back names the award it cancels; each award at most once.
  reverses      bigint UNIQUE REFERENCES app.points_ledger (id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- 0 is an award the pair cap stopped: kept, so it can't be paid out later.
  CONSTRAINT points_amount_matches_reason CHECK (
    (reason = 'selected' AND amount IN (5, 0) AND reverses IS NULL)
    OR (reason = 'helpful' AND amount IN (2, 0) AND reverses IS NULL)
    OR (reason = 'selection_changed' AND amount IN (-5, 0) AND reverses IS NOT NULL)),
  CONSTRAINT points_not_to_self CHECK (giver_id IS DISTINCT FROM recipient_id)
);
CREATE INDEX IF NOT EXISTS points_recipient ON app.points_ledger (recipient_id, field);
CREATE INDEX IF NOT EXISTS points_pair ON app.points_ledger (giver_id, recipient_id, created_at);
CREATE INDEX IF NOT EXISTS points_question ON app.points_ledger (question_id) WHERE reason = 'selected';
-- One helpful award per answer.
CREATE UNIQUE INDEX IF NOT EXISTS points_helpful_once ON app.points_ledger (answer_id) WHERE reason = 'helpful';
ALTER TABLE app.points_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.points_ledger FORCE ROW LEVEL SECURITY;
GRANT SELECT ON app.points_ledger TO app_api;
GRANT INSERT (recipient_id, giver_id, field, amount, reason, question_id, answer_id, reverses) ON app.points_ledger TO app_api;
DROP POLICY IF EXISTS points_read ON app.points_ledger;
CREATE POLICY points_read ON app.points_ledger FOR SELECT TO app_api USING (true);
-- A row is accepted only if it matches what really happened, given by the
-- signed-in person: the current pick, a helpful mark, or taking back an
-- award whose answer is no longer the pick.
DROP POLICY IF EXISTS points_insert_real ON app.points_ledger;
CREATE POLICY points_insert_real ON app.points_ledger FOR INSERT TO app_api
  WITH CHECK (
    giver_id = app.current_user_id()
    AND (
      (reason = 'selected' AND EXISTS (
        SELECT 1 FROM app.selections s
        JOIN app.answers a ON a.id = s.answer_id
        JOIN app.questions q ON q.id = s.question_id
        WHERE s.question_id = points_ledger.question_id AND s.answer_id = points_ledger.answer_id
          AND a.answerer_id = points_ledger.recipient_id AND q.asker_id = points_ledger.giver_id
          AND q.field = points_ledger.field))
      OR (reason = 'helpful' AND EXISTS (
        SELECT 1 FROM app.helpful_marks h
        JOIN app.answers a ON a.id = h.answer_id
        JOIN app.questions q ON q.id = a.question_id
        WHERE h.answer_id = points_ledger.answer_id AND a.question_id = points_ledger.question_id
          AND a.answerer_id = points_ledger.recipient_id AND q.asker_id = points_ledger.giver_id
          AND q.field = points_ledger.field))
      OR (reason = 'selection_changed' AND EXISTS (
        SELECT 1 FROM app.points_ledger l
        JOIN app.selections s ON s.question_id = l.question_id
        WHERE l.id = points_ledger.reverses AND l.reason = 'selected'
          AND l.recipient_id = points_ledger.recipient_id AND l.giver_id = points_ledger.giver_id
          AND l.field = points_ledger.field AND l.question_id = points_ledger.question_id
          AND l.answer_id = points_ledger.answer_id AND points_ledger.amount = -l.amount
          AND s.answer_id IS DISTINCT FROM l.answer_id))
    )
  );

-- Pair cap: the same asker can give the same person points 3 times in 30
-- days; after that the pick or mark still counts, but no points move.
-- Every ledger write for a pair takes the same lock, so two requests at
-- once can't both squeeze under the cap. (Requests run at READ COMMITTED,
-- so the count after the lock sees the other's committed row.)
CREATE OR REPLACE FUNCTION app.guard_points() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- A null would make the lock key null, and the lock silently not taken.
  IF NEW.giver_id IS NULL OR NEW.recipient_id IS NULL OR NEW.question_id IS NULL THEN
    RAISE EXCEPTION 'points need a giver, a recipient and a question' USING ERRCODE = 'not_null_violation';
  END IF;
  -- The cap count below must see what others just committed: only true at
  -- READ COMMITTED, which a caller could otherwise change for itself.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'points can only move at READ COMMITTED' USING ERRCODE = 'invalid_transaction_state';
  END IF;
  -- One question's pick at a time, then one pair at a time (always this order).
  PERFORM pg_advisory_xact_lock(hashtext('graphinity.pick'), hashtext(NEW.question_id::text));
  PERFORM pg_advisory_xact_lock(hashtext('graphinity.points'), hashtext(NEW.giver_id::text || ':' || NEW.recipient_id::text));
  -- The real time, not the transaction's start: a transaction held open
  -- for a month must not backdate its awards out of the cap's window.
  NEW.created_at := clock_timestamp();
  IF NEW.reason = 'selected' AND EXISTS (
    SELECT 1 FROM app.points_ledger l
    WHERE l.question_id = NEW.question_id AND l.reason = 'selected'
      AND NOT EXISTS (SELECT 1 FROM app.points_ledger r WHERE r.reverses = l.id)
  ) THEN
    RAISE EXCEPTION 'this question''s pick already has its points' USING ERRCODE = 'unique_violation';
  END IF;
  IF NEW.amount > 0 AND (
    SELECT count(*) FROM app.points_ledger l
    WHERE l.giver_id = NEW.giver_id AND l.recipient_id = NEW.recipient_id
      AND l.amount > 0 AND l.created_at > clock_timestamp() - interval '30 days'
      AND NOT EXISTS (SELECT 1 FROM app.points_ledger r WHERE r.reverses = l.id)
  ) >= 3 THEN
    NEW.amount := 0;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_points() FROM PUBLIC;
DROP TRIGGER IF EXISTS points_guard ON app.points_ledger;
CREATE TRIGGER points_guard BEFORE INSERT ON app.points_ledger
  FOR EACH ROW EXECUTE FUNCTION app.guard_points();

-- Picking and marking move points by themselves, in the same transaction.
CREATE OR REPLACE FUNCTION app.award_selection() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  k bigint;
BEGIN
  -- Emptied by the cascade when the picked answer's author left: their
  -- points left with them; nothing to move.
  IF NEW.answer_id IS NULL THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.answer_id IS NOT DISTINCT FROM OLD.answer_id THEN RETURN NULL; END IF;
    -- Lock order: the question, then every pair involved, smallest key first,
    -- so two changes in opposite directions can't deadlock.
    PERFORM pg_advisory_xact_lock(hashtext('graphinity.pick'), hashtext(NEW.question_id::text));
    FOR k IN
      SELECT DISTINCT hashtext(q.asker_id::text || ':' || a.answerer_id::text)
      FROM app.answers a JOIN app.questions q ON q.id = a.question_id
      WHERE a.id IN (OLD.answer_id, NEW.answer_id)
      ORDER BY 1
    LOOP
      PERFORM pg_advisory_xact_lock(hashtext('graphinity.points'), k::int);
    END LOOP;
    INSERT INTO app.points_ledger (recipient_id, giver_id, field, amount, reason, question_id, answer_id, reverses)
      SELECT l.recipient_id, l.giver_id, l.field, -l.amount, 'selection_changed', l.question_id, l.answer_id, l.id
      FROM app.points_ledger l
      WHERE l.question_id = NEW.question_id AND l.reason = 'selected'
        AND NOT EXISTS (SELECT 1 FROM app.points_ledger r WHERE r.reverses = l.id);
  END IF;
  INSERT INTO app.points_ledger (recipient_id, giver_id, field, amount, reason, question_id, answer_id)
    SELECT a.answerer_id, q.asker_id, q.field, 5, 'selected', q.id, a.id
    FROM app.answers a JOIN app.questions q ON q.id = a.question_id
    WHERE a.id = NEW.answer_id;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.award_selection() FROM PUBLIC;
DROP TRIGGER IF EXISTS selections_award ON app.selections;
CREATE TRIGGER selections_award AFTER INSERT OR UPDATE ON app.selections
  FOR EACH ROW EXECUTE FUNCTION app.award_selection();

CREATE OR REPLACE FUNCTION app.award_helpful() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO app.points_ledger (recipient_id, giver_id, field, amount, reason, question_id, answer_id)
    SELECT a.answerer_id, q.asker_id, q.field, 2, 'helpful', q.id, a.id
    FROM app.answers a JOIN app.questions q ON q.id = a.question_id
    WHERE a.id = NEW.answer_id;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.award_helpful() FROM PUBLIC;
DROP TRIGGER IF EXISTS helpful_award ON app.helpful_marks;
CREATE TRIGGER helpful_award AFTER INSERT ON app.helpful_marks
  FOR EACH ROW EXECUTE FUNCTION app.award_helpful();

-- Later, the asker says whether the picked answer turned out right. Only
-- the current pick can be rated; who rated whom is worked out from the
-- answer and question, never sent. Trust counts each asker once.
CREATE TABLE IF NOT EXISTS app.verdicts (
  answer_id  bigint PRIMARY KEY REFERENCES app.answers (id) ON DELETE CASCADE,
  correct    boolean NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.verdicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.verdicts FORCE ROW LEVEL SECURITY;
GRANT SELECT ON app.verdicts TO app_api;
GRANT INSERT (answer_id, correct), UPDATE (correct) ON app.verdicts TO app_api;
DROP POLICY IF EXISTS verdicts_read ON app.verdicts;
CREATE POLICY verdicts_read ON app.verdicts FOR SELECT TO app_api USING (true);
DROP POLICY IF EXISTS verdicts_insert_asker ON app.verdicts;
CREATE POLICY verdicts_insert_asker ON app.verdicts FOR INSERT TO app_api
  WITH CHECK (EXISTS (
    SELECT 1 FROM app.selections s JOIN app.questions q ON q.id = s.question_id
    WHERE s.answer_id = verdicts.answer_id AND q.asker_id = app.current_user_id()
  ));
DROP POLICY IF EXISTS verdicts_update_asker ON app.verdicts;
CREATE POLICY verdicts_update_asker ON app.verdicts FOR UPDATE TO app_api
  USING (EXISTS (
    SELECT 1 FROM app.selections s JOIN app.questions q ON q.id = s.question_id
    WHERE s.answer_id = verdicts.answer_id AND q.asker_id = app.current_user_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM app.selections s JOIN app.questions q ON q.id = s.question_id
    WHERE s.answer_id = verdicts.answer_id AND q.asker_id = app.current_user_id()
  ));

CREATE OR REPLACE FUNCTION app.stamp_verdict() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.at := clock_timestamp();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.stamp_verdict() FROM PUBLIC;
DROP TRIGGER IF EXISTS verdicts_stamp ON app.verdicts;
CREATE TRIGGER verdicts_stamp BEFORE INSERT OR UPDATE ON app.verdicts
  FOR EACH ROW EXECUTE FUNCTION app.stamp_verdict();

-- ---------------------------------------------------------------------------
-- Routing: who a question was put to, in waves. Who was asked is private:
-- each person sees only their own routes. Only the server's routing job
-- (app.is_system(), set by its own transactions, never by a request) may
-- create them. A person gets at most 3 a day (docs/GRAPHINITY_BIBLE.md
-- §3.2: expert attention is scarce), and never their own question.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.is_system() RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog
AS $$ SELECT coalesce(current_setting('app.system', true), '') = 'on' $$;
REVOKE ALL ON FUNCTION app.is_system() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_system() TO app_api;

CREATE TABLE IF NOT EXISTS app.routes (
  question_id  bigint NOT NULL REFERENCES app.questions (id) ON DELETE CASCADE,
  profile_id   uuid NOT NULL REFERENCES app.profiles (id) ON DELETE CASCADE,
  wave         smallint NOT NULL CHECK (wave BETWEEN 1 AND 3),
  routed_at    timestamptz NOT NULL DEFAULT now(),
  seen_at      timestamptz,
  PRIMARY KEY (question_id, profile_id)
);
CREATE INDEX IF NOT EXISTS routes_inbox ON app.routes (profile_id, routed_at DESC);
ALTER TABLE app.routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.routes FORCE ROW LEVEL SECURITY;
GRANT SELECT ON app.routes TO app_api;
GRANT INSERT (question_id, profile_id, wave) ON app.routes TO app_api;
GRANT UPDATE (seen_at) ON app.routes TO app_api;
DROP POLICY IF EXISTS routes_read_own ON app.routes;
CREATE POLICY routes_read_own ON app.routes FOR SELECT TO app_api
  USING (profile_id = app.current_user_id() OR app.is_system());
DROP POLICY IF EXISTS routes_insert_system ON app.routes;
CREATE POLICY routes_insert_system ON app.routes FOR INSERT TO app_api
  WITH CHECK (app.is_system());
DROP POLICY IF EXISTS routes_seen_own ON app.routes;
CREATE POLICY routes_seen_own ON app.routes FOR UPDATE TO app_api
  USING (profile_id = app.current_user_id())
  WITH CHECK (profile_id = app.current_user_id());

CREATE OR REPLACE FUNCTION app.guard_route() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Seen once, seen for good; the time is the database's.
    NEW.seen_at := coalesce(OLD.seen_at, CASE WHEN NEW.seen_at IS NOT NULL THEN clock_timestamp() END);
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM app.questions q WHERE q.id = NEW.question_id AND q.asker_id = NEW.profile_id) THEN
    RAISE EXCEPTION 'a question is never put to its own asker' USING ERRCODE = 'check_violation';
  END IF;
  NEW.routed_at := clock_timestamp();
  NEW.seen_at := NULL;
  -- The daily budget: past it, the route is quietly not made.
  IF (SELECT count(*) FROM app.routes r
      WHERE r.profile_id = NEW.profile_id AND r.routed_at > clock_timestamp() - interval '1 day') >= 3 THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_route() FROM PUBLIC;
DROP TRIGGER IF EXISTS routes_guard ON app.routes;
CREATE TRIGGER routes_guard BEFORE INSERT OR UPDATE ON app.routes
  FOR EACH ROW EXECUTE FUNCTION app.guard_route();

-- ---------------------------------------------------------------------------
-- Web push: where to send notifications for each person's devices. Each
-- person sees and removes only their own; the server's job (is_system)
-- reads them to send, and removes ones the push service says are gone.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.push_subscriptions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  profile_id  uuid NOT NULL REFERENCES app.profiles (id) ON DELETE CASCADE,
  -- The API also checks it is one of the browsers' push services.
  endpoint    text NOT NULL UNIQUE CHECK (endpoint ~ '^https://' AND char_length(endpoint) <= 1000),
  -- The browser's public key and auth secret, base64url.
  p256dh      text NOT NULL CHECK (p256dh ~ '^[A-Za-z0-9_-]{87}$'),
  auth        text NOT NULL CHECK (auth ~ '^[A-Za-z0-9_-]{22}$'),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_subscriptions_profile ON app.push_subscriptions (profile_id);
ALTER TABLE app.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.push_subscriptions FORCE ROW LEVEL SECURITY;
GRANT SELECT, DELETE ON app.push_subscriptions TO app_api;
GRANT INSERT (profile_id, endpoint, p256dh, auth) ON app.push_subscriptions TO app_api;
DROP POLICY IF EXISTS push_read ON app.push_subscriptions;
CREATE POLICY push_read ON app.push_subscriptions FOR SELECT TO app_api
  USING (profile_id = app.current_user_id() OR app.is_system());
DROP POLICY IF EXISTS push_insert_own ON app.push_subscriptions;
CREATE POLICY push_insert_own ON app.push_subscriptions FOR INSERT TO app_api
  WITH CHECK (profile_id = app.current_user_id());
DROP POLICY IF EXISTS push_delete ON app.push_subscriptions;
CREATE POLICY push_delete ON app.push_subscriptions FOR DELETE TO app_api
  USING (profile_id = app.current_user_id() OR app.is_system());

-- At most 10 devices per person: enough for anyone, and a cap on how much
-- one account can make the server send.
CREATE OR REPLACE FUNCTION app.check_push_count() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (SELECT count(*) FROM app.push_subscriptions WHERE profile_id = NEW.profile_id) >= 10 THEN
    RAISE EXCEPTION 'at most 10 devices' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.check_push_count() FROM PUBLIC;
DROP TRIGGER IF EXISTS push_count ON app.push_subscriptions;
CREATE TRIGGER push_count BEFORE INSERT ON app.push_subscriptions
  FOR EACH ROW EXECUTE FUNCTION app.check_push_count();

-- ---------------------------------------------------------------------------
-- Moderation. People report posts; a post 3 people report is hidden until
-- the owner reviews it (keep or remove). The owner can block a person from
-- posting. Moderators are only ever added by the owner, in the SQL editor:
--   INSERT INTO app.moderators (profile_id) SELECT id FROM app.profiles WHERE handle = 'yourname';
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.moderators (
  profile_id  uuid PRIMARY KEY REFERENCES app.profiles (id) ON DELETE CASCADE,
  added_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.moderators ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.moderators FORCE ROW LEVEL SECURITY;
GRANT SELECT ON app.moderators TO app_api;
DROP POLICY IF EXISTS moderators_self ON app.moderators;
CREATE POLICY moderators_self ON app.moderators FOR SELECT TO app_api
  USING (profile_id = app.current_user_id());


-- A block. The blocked person can see that they are blocked, not by whom
-- or why (that's in block_details, for moderators only).
CREATE TABLE IF NOT EXISTS app.blocks (
  profile_id  uuid PRIMARY KEY REFERENCES app.profiles (id) ON DELETE CASCADE,
  blocked_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.blocks FORCE ROW LEVEL SECURITY;
GRANT SELECT, DELETE ON app.blocks TO app_api;
GRANT INSERT (profile_id) ON app.blocks TO app_api;

CREATE OR REPLACE FUNCTION app.is_moderator() RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM app.moderators m WHERE m.profile_id = app.current_user_id())
     AND NOT EXISTS (SELECT 1 FROM app.blocks b WHERE b.profile_id = app.current_user_id())
$$;
REVOKE ALL ON FUNCTION app.is_moderator() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_moderator() TO app_api;

DROP POLICY IF EXISTS blocks_read ON app.blocks;
CREATE POLICY blocks_read ON app.blocks FOR SELECT TO app_api
  USING (profile_id = (SELECT app.current_user_id()) OR (SELECT app.is_moderator()));
DROP POLICY IF EXISTS blocks_write ON app.blocks;
CREATE POLICY blocks_write ON app.blocks FOR INSERT TO app_api
  WITH CHECK ((SELECT app.is_moderator()) AND profile_id <> (SELECT app.current_user_id()));
DROP POLICY IF EXISTS blocks_lift ON app.blocks;
CREATE POLICY blocks_lift ON app.blocks FOR DELETE TO app_api USING ((SELECT app.is_moderator()));

CREATE TABLE IF NOT EXISTS app.block_details (
  profile_id  uuid PRIMARY KEY REFERENCES app.blocks (profile_id) ON DELETE CASCADE,
  blocked_by  uuid REFERENCES app.profiles (id) ON DELETE SET NULL,
  reason      text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500)
);
ALTER TABLE app.block_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.block_details FORCE ROW LEVEL SECURITY;
GRANT SELECT ON app.block_details TO app_api;
GRANT INSERT (profile_id, blocked_by, reason) ON app.block_details TO app_api;
DROP POLICY IF EXISTS block_details_moderators ON app.block_details;
CREATE POLICY block_details_moderators ON app.block_details FOR SELECT TO app_api USING ((SELECT app.is_moderator()));
DROP POLICY IF EXISTS block_details_write ON app.block_details;
CREATE POLICY block_details_write ON app.block_details FOR INSERT TO app_api
  WITH CHECK ((SELECT app.is_moderator()) AND blocked_by = (SELECT app.current_user_id()));

-- True for the signed-in person if they are blocked (they can see their own block).
CREATE OR REPLACE FUNCTION app.is_blocked() RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$ SELECT EXISTS (SELECT 1 FROM app.blocks b WHERE b.profile_id = app.current_user_id()) $$;
REVOKE ALL ON FUNCTION app.is_blocked() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_blocked() TO app_api;

CREATE TABLE IF NOT EXISTS app.reports (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Deleting an account deletes its reports, so one person can't delete,
  -- rejoin and report the same post again.
  reporter_id  uuid NOT NULL REFERENCES app.profiles (id) ON DELETE CASCADE,
  question_id  bigint REFERENCES app.questions (id) ON DELETE CASCADE,
  answer_id    bigint REFERENCES app.answers (id) ON DELETE CASCADE,
  reason       text NOT NULL CHECK (reason IN ('spam', 'abuse', 'private_info', 'misleading', 'other')),
  note         text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500 AND note = btrim(note) AND note !~ '[\x01-\x09\x0B-\x1F\x7F]'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Set by the database: whether the reporter's account was over a day
  -- old. Only those count towards hiding (new accounts still reach review).
  counts       boolean NOT NULL DEFAULT false,
  CONSTRAINT reports_one_target CHECK (num_nonnulls(question_id, answer_id) = 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS reports_once_question ON app.reports (reporter_id, question_id) WHERE question_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS reports_once_answer ON app.reports (reporter_id, answer_id) WHERE answer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS reports_question ON app.reports (question_id) WHERE question_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS reports_answer ON app.reports (answer_id) WHERE answer_id IS NOT NULL;
ALTER TABLE app.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.reports FORCE ROW LEVEL SECURITY;
GRANT SELECT ON app.reports TO app_api;
GRANT INSERT (reporter_id, question_id, answer_id, reason, note) ON app.reports TO app_api;

CREATE TABLE IF NOT EXISTS app.decisions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  question_id  bigint REFERENCES app.questions (id) ON DELETE CASCADE,
  answer_id    bigint REFERENCES app.answers (id) ON DELETE CASCADE,
  decision     text NOT NULL CHECK (decision IN ('keep', 'remove')),
  decided_by   uuid REFERENCES app.profiles (id) ON DELETE SET NULL,
  decided_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT decisions_one_target CHECK (num_nonnulls(question_id, answer_id) = 1)
);
CREATE INDEX IF NOT EXISTS decisions_question ON app.decisions (question_id) WHERE question_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS decisions_answer ON app.decisions (answer_id) WHERE answer_id IS NOT NULL;
ALTER TABLE app.decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.decisions FORCE ROW LEVEL SECURITY;
GRANT SELECT ON app.decisions TO app_api;
GRANT INSERT (question_id, answer_id, decision, decided_by) ON app.decisions TO app_api;
DROP POLICY IF EXISTS decisions_read ON app.decisions;
CREATE POLICY decisions_read ON app.decisions FOR SELECT TO app_api USING (app.is_moderator());
DROP POLICY IF EXISTS decisions_write ON app.decisions;
CREATE POLICY decisions_write ON app.decisions FOR INSERT TO app_api
  WITH CHECK (
    (SELECT app.is_moderator()) AND decided_by = (SELECT app.current_user_id())
    AND NOT EXISTS (SELECT 1 FROM app.questions q WHERE q.id = decisions.question_id AND q.asker_id = decisions.decided_by)
    AND NOT EXISTS (SELECT 1 FROM app.answers a WHERE a.id = decisions.answer_id AND a.answerer_id = decisions.decided_by)
  );

-- Whether a post is hidden: removed by a moderator, or reported by 3 people
-- since the last "keep". Counting needs everyone's reports, which people
-- can't read, so these two run as the schema owner (SECURITY DEFINER), take
-- only an id and return only yes or no. Names are schema-qualified and
-- pg_temp comes last, so nothing the caller creates can stand in.
-- They see every report and decision because the schema owner bypasses
-- row-level security (it must: this file seeds tables under FORCE RLS).
DROP POLICY IF EXISTS reports_owner ON app.reports;
DROP POLICY IF EXISTS decisions_owner ON app.decisions;

CREATE OR REPLACE FUNCTION app.is_question_hidden(target bigint) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  -- The latest decision (by id, so two at the same instant still have an order).
  SELECT coalesce((SELECT d.decision = 'remove' FROM app.decisions d WHERE d.question_id = target ORDER BY d.id DESC LIMIT 1), false)
      OR (SELECT count(*) FROM app.reports r
          WHERE r.question_id = target AND r.counts
            AND r.created_at > coalesce((SELECT max(d.decided_at) FROM app.decisions d WHERE d.question_id = target AND d.decision = 'keep'), '-infinity')
         ) >= 3
$$;
REVOKE ALL ON FUNCTION app.is_question_hidden(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_question_hidden(bigint) TO app_api;

CREATE OR REPLACE FUNCTION app.is_answer_hidden(target bigint) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  -- The latest decision (by id, so two at the same instant still have an order).
  SELECT coalesce((SELECT d.decision = 'remove' FROM app.decisions d WHERE d.answer_id = target ORDER BY d.id DESC LIMIT 1), false)
      OR (SELECT count(*) FROM app.reports r
          WHERE r.answer_id = target AND r.counts
            AND r.created_at > coalesce((SELECT max(d.decided_at) FROM app.decisions d WHERE d.answer_id = target AND d.decision = 'keep'), '-infinity')
         ) >= 3
$$;
REVOKE ALL ON FUNCTION app.is_answer_hidden(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_answer_hidden(bigint) TO app_api;

-- Hidden posts: visible only to their author (with a note) and moderators.
DROP POLICY IF EXISTS questions_read ON app.questions;
CREATE POLICY questions_read ON app.questions FOR SELECT TO app_api
  USING (asker_id = (SELECT app.current_user_id()) OR (SELECT app.is_moderator()) OR NOT app.is_question_hidden(id));
DROP POLICY IF EXISTS answers_read ON app.answers;
CREATE POLICY answers_read ON app.answers FOR SELECT TO app_api
  USING (answerer_id = (SELECT app.current_user_id()) OR (SELECT app.is_moderator()) OR NOT app.is_answer_hidden(id));

-- Reporting: your own report, once per post, never your own post, not while blocked.
DROP POLICY IF EXISTS reports_read ON app.reports;
CREATE POLICY reports_read ON app.reports FOR SELECT TO app_api
  USING (reporter_id = app.current_user_id() OR app.is_moderator());
DROP POLICY IF EXISTS reports_insert ON app.reports;
CREATE POLICY reports_insert ON app.reports FOR INSERT TO app_api
  WITH CHECK (
    reporter_id = app.current_user_id()
    AND NOT app.is_blocked()
    AND NOT EXISTS (SELECT 1 FROM app.questions q WHERE q.id = reports.question_id AND q.asker_id = reports.reporter_id)
    AND NOT EXISTS (SELECT 1 FROM app.answers a WHERE a.id = reports.answer_id AND a.answerer_id = reports.reporter_id)
  );

CREATE OR REPLACE FUNCTION app.stamp_moderation() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME = 'reports' THEN
    NEW.created_at := clock_timestamp();
    NEW.counts := EXISTS (SELECT 1 FROM app.profiles p WHERE p.id = NEW.reporter_id AND p.created_at < now() - interval '1 day');
  ELSE
    NEW.decided_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.stamp_moderation() FROM PUBLIC;
DROP TRIGGER IF EXISTS reports_stamp ON app.reports;
CREATE TRIGGER reports_stamp BEFORE INSERT ON app.reports FOR EACH ROW EXECUTE FUNCTION app.stamp_moderation();
DROP TRIGGER IF EXISTS decisions_stamp ON app.decisions;
CREATE TRIGGER decisions_stamp BEFORE INSERT ON app.decisions FOR EACH ROW EXECUTE FUNCTION app.stamp_moderation();

-- Blocked people can't post; new accounts post a little at first: 3
-- questions and 10 answers in their first day.
DROP POLICY IF EXISTS questions_insert_own ON app.questions;
CREATE POLICY questions_insert_own ON app.questions FOR INSERT TO app_api
  WITH CHECK (asker_id = app.current_user_id() AND NOT app.is_blocked());
DROP POLICY IF EXISTS answers_insert_own ON app.answers;
CREATE POLICY answers_insert_own ON app.answers FOR INSERT TO app_api
  WITH CHECK (
    answerer_id = app.current_user_id()
    AND NOT app.is_blocked()
    -- Only to a question you can see: not a hidden or removed one.
    AND EXISTS (SELECT 1 FROM app.questions q WHERE q.id = answers.question_id)
    AND NOT EXISTS (
      SELECT 1 FROM app.questions q
      WHERE q.id = answers.question_id AND q.asker_id = answers.answerer_id
    )
  );

CREATE OR REPLACE FUNCTION app.limit_new_accounts() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  author uuid;
  allowed int;
  posted int;
BEGIN
  -- Separate branches: each table has only its own author column.
  IF TG_TABLE_NAME = 'questions' THEN
    author := NEW.asker_id;
    allowed := 3;
  ELSE
    author := NEW.answerer_id;
    allowed := 10;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.profiles p WHERE p.id = author AND p.created_at > clock_timestamp() - interval '1 day') THEN
    RETURN NEW;
  END IF;
  -- One at a time per author, or parallel posts would all count the same total.
  PERFORM pg_advisory_xact_lock(hashtext('graphinity.new-account'), hashtext(author::text));
  IF TG_TABLE_NAME = 'questions' THEN
    SELECT count(*) INTO posted FROM app.questions WHERE asker_id = author;
  ELSE
    SELECT count(*) INTO posted FROM app.answers WHERE answerer_id = author;
  END IF;
  IF posted >= allowed THEN
    RAISE EXCEPTION 'new account limit' USING ERRCODE = 'check_violation', HINT = 'new_account_limit';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.limit_new_accounts() FROM PUBLIC;
DROP TRIGGER IF EXISTS questions_new_account ON app.questions;
CREATE TRIGGER questions_new_account BEFORE INSERT ON app.questions FOR EACH ROW EXECUTE FUNCTION app.limit_new_accounts();
DROP TRIGGER IF EXISTS answers_new_account ON app.answers;
CREATE TRIGGER answers_new_account BEFORE INSERT ON app.answers FOR EACH ROW EXECUTE FUNCTION app.limit_new_accounts();

-- Shared networks: which keyed network hashes a person wrote from, by day,
-- for 30 days. Only moderators read it (pairs exchanging points from the
-- same network are shown for review, never blocked automatically).
CREATE TABLE IF NOT EXISTS app.network_marks (
  profile_id    uuid NOT NULL REFERENCES app.profiles (id) ON DELETE CASCADE,
  network_hash  text NOT NULL CHECK (network_hash ~ '^[A-Za-z0-9_-]{16,64}$'),
  day           date NOT NULL DEFAULT current_date,
  PRIMARY KEY (profile_id, network_hash, day)
);
CREATE INDEX IF NOT EXISTS network_marks_hash ON app.network_marks (network_hash, day);
ALTER TABLE app.network_marks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.network_marks FORCE ROW LEVEL SECURITY;
GRANT SELECT, DELETE ON app.network_marks TO app_api;
GRANT INSERT (profile_id, network_hash) ON app.network_marks TO app_api;
DROP POLICY IF EXISTS network_insert_own ON app.network_marks;
CREATE POLICY network_insert_own ON app.network_marks FOR INSERT TO app_api
  WITH CHECK (profile_id = app.current_user_id());
DROP POLICY IF EXISTS network_read ON app.network_marks;
CREATE POLICY network_read ON app.network_marks FOR SELECT TO app_api
  USING (app.is_moderator() OR app.is_system() OR profile_id = app.current_user_id());
DROP POLICY IF EXISTS network_expire ON app.network_marks;
CREATE POLICY network_expire ON app.network_marks FOR DELETE TO app_api
  USING (app.is_system() AND day < current_date - 30);

-- ---------------------------------------------------------------------------
-- No hidden characters that change how text reads: C1 controls, and the
-- direction overrides and isolates (U+202A-202E, U+2066-2069) that can make
-- a title show as something other than what it is ("Trojan Source"). The
-- API refuses them first (src/text.ts); these repeat it. Added as named
-- constraints so running this file again, or on an older database, adds
-- them once.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.has_hidden_marks(t text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  SET search_path = pg_catalog
  AS $$ SELECT t ~ '[\u0080-\u009F\u202A-\u202E\u2066-\u2069]' $$;
REVOKE ALL ON FUNCTION app.has_hidden_marks(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.has_hidden_marks(text) TO app_api;

DO $$
DECLARE
  rule record;
BEGIN
  FOR rule IN SELECT * FROM (VALUES
    ('questions', 'questions_title_plain', 'title'),
    ('questions', 'questions_body_plain', 'body'),
    ('answers', 'answers_body_plain', 'body'),
    ('reports', 'reports_note_plain', 'note'),
    ('block_details', 'block_details_reason_plain', 'reason')
  ) AS r (tbl, name, col)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = rule.name AND conrelid = format('app.%I', rule.tbl)::regclass) THEN
      EXECUTE format('ALTER TABLE app.%I ADD CONSTRAINT %I CHECK (NOT app.has_hidden_marks(%I))', rule.tbl, rule.name, rule.col);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Why each person was asked, as it stood at that moment: shown only to that
-- person ("Why you got this"). Null on routes made before this was kept.
-- ---------------------------------------------------------------------------
ALTER TABLE app.routes ADD COLUMN IF NOT EXISTS same_country boolean;
ALTER TABLE app.routes ADD COLUMN IF NOT EXISTS field_points integer CHECK (field_points >= 0);
ALTER TABLE app.routes ADD COLUMN IF NOT EXISTS trust_pct smallint CHECK (trust_pct BETWEEN 0 AND 100);
ALTER TABLE app.routes ADD COLUMN IF NOT EXISTS answered_pct smallint CHECK (answered_pct BETWEEN 0 AND 100);
ALTER TABLE app.routes ADD COLUMN IF NOT EXISTS newcomer boolean;
GRANT INSERT (same_country, field_points, trust_pct, answered_pct, newcomer) ON app.routes TO app_api;

-- How far the asker's question went, in numbers only: never who, and
-- nothing for anyone but the asker (routes stay readable only by the person
-- asked). Fewer than 5 is given as null ("a few"): in a small field an exact
-- count, set against public profiles, could tell the asker who was asked.
-- No count of who answered, for the same reason.
DROP FUNCTION IF EXISTS app.routing_summary(bigint);
CREATE FUNCTION app.routing_summary(target bigint)
  RETURNS TABLE (waves integer, asked integer, in_country integer)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT max(r.wave)::int,
         CASE WHEN count(*) >= 5 THEN count(*)::int END,
         CASE WHEN count(*) FILTER (WHERE r.same_country) >= 5 THEN (count(*) FILTER (WHERE r.same_country))::int END
  FROM app.routes r JOIN app.questions q ON q.id = r.question_id
  WHERE r.question_id = target AND q.asker_id = app.current_user_id()
  HAVING count(*) > 0
$$;
REVOKE ALL ON FUNCTION app.routing_summary(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.routing_summary(bigint) TO app_api;

-- Bump on every change to this file.
INSERT INTO app.schema_meta (id, version) VALUES (true, 12)
  ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, applied_at = now();

COMMIT;
