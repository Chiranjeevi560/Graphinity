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
DROP POLICY IF EXISTS questions_read ON app.questions;
CREATE POLICY questions_read ON app.questions FOR SELECT TO app_api USING (true);
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
DROP POLICY IF EXISTS answers_read ON app.answers;
CREATE POLICY answers_read ON app.answers FOR SELECT TO app_api USING (true);
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

-- Bump on every change to this file.
INSERT INTO app.schema_meta (id, version) VALUES (true, 6)
  ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, applied_at = now();

COMMIT;
