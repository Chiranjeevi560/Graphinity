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

-- Bump on every change to this file.
INSERT INTO app.schema_meta (id, version) VALUES (true, 1)
  ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, applied_at = now();

COMMIT;
