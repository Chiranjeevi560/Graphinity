-- Enterprise analytics (ADR 0033): an organization reads what people ask about a topic's products, as the commerce
-- cube already holds it (25 people or more, Laplace noise), with its own key and a daily quota. Nothing
-- about any person leaves. Off by default: turning it on needs the owner, an agreement with each organization, and
-- the privacy page saying that noised totals are shared.
INSERT INTO app.feature_flags (name, enabled, note) VALUES
  ('enterprise_analytics', false, 'Organizations read noised topic demand with their own key')
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS app.enterprise_orgs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id   uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100 AND name = btrim(name) AND name !~ '[[:cntrl:]]'),
  daily_reads integer NOT NULL DEFAULT 1000 CHECK (daily_reads BETWEEN 1 AND 100000),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.enterprise_keys (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id     bigint NOT NULL REFERENCES app.enterprise_orgs (id) ON DELETE CASCADE,
  key_hash   text NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  -- The first characters, to tell keys apart on a screen.
  prefix     text NOT NULL UNIQUE CHECK (prefix ~ '^gre_[A-Za-z0-9_-]{6}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS enterprise_keys_org ON app.enterprise_keys (org_id);

CREATE TABLE IF NOT EXISTS app.enterprise_reads (
  org_id bigint NOT NULL REFERENCES app.enterprise_orgs (id) ON DELETE CASCADE,
  day    date NOT NULL,
  reads  integer NOT NULL CHECK (reads >= 0),
  PRIMARY KEY (org_id, day)
);

ALTER TABLE app.enterprise_orgs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.enterprise_orgs FORCE ROW LEVEL SECURITY;
ALTER TABLE app.enterprise_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.enterprise_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE app.enterprise_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.enterprise_reads FORCE ROW LEVEL SECURITY;

GRANT SELECT ON app.enterprise_orgs, app.enterprise_keys, app.enterprise_reads TO app_api;
GRANT INSERT (name, daily_reads) ON app.enterprise_orgs TO app_api;
GRANT INSERT (org_id, key_hash, prefix) ON app.enterprise_keys TO app_api;
GRANT UPDATE (revoked_at) ON app.enterprise_keys TO app_api;

-- Only the platform's owner manages organizations and keys, and sees their reads. Reads are counted by the
-- function below only, so an organization can't reset its own quota.
DROP POLICY IF EXISTS enterprise_orgs_owner ON app.enterprise_orgs;
CREATE POLICY enterprise_orgs_owner ON app.enterprise_orgs FOR ALL TO app_api
  USING (app.is_owner()) WITH CHECK (app.is_owner());
DROP POLICY IF EXISTS enterprise_keys_owner ON app.enterprise_keys;
CREATE POLICY enterprise_keys_owner ON app.enterprise_keys FOR ALL TO app_api
  USING (app.is_owner()) WITH CHECK (app.is_owner());
DROP POLICY IF EXISTS enterprise_reads_owner ON app.enterprise_reads;
CREATE POLICY enterprise_reads_owner ON app.enterprise_reads FOR SELECT TO app_api USING (app.is_owner());

-- A key's read: refused (no rows, and the reason) unless the switch is on, the key is live and today's quota has room.
-- Only cube rows with 25 contributors or more, as the cube promises, whatever wrote them, and only the noised count:
-- the cube's forecasts are fitted to un-noised daily mentions, so one day's forecast against the next would give away
-- the newest day's exact count.
CREATE OR REPLACE FUNCTION app.enterprise_topic_demand(in_key_hash text, in_field text, in_days integer)
  RETURNS TABLE (outcome text, day date, product text, noisy_count double precision)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  org bigint;
  allowed integer;
  used integer;
BEGIN
  IF NOT app.flag_on('enterprise_analytics') THEN
    RETURN QUERY SELECT 'off'::text, NULL::date, NULL::text, NULL::float8;
    RETURN;
  END IF;
  SELECT o.id, o.daily_reads INTO org, allowed
    FROM app.enterprise_keys k JOIN app.enterprise_orgs o ON o.id = k.org_id
   WHERE k.key_hash = in_key_hash AND k.revoked_at IS NULL;
  IF org IS NULL THEN
    RETURN QUERY SELECT 'unknown'::text, NULL::date, NULL::text, NULL::float8;
    RETURN;
  END IF;
  -- The quota's day is the UTC day, whatever the session's time zone.
  INSERT INTO app.enterprise_reads AS r (org_id, day, reads) VALUES (org, (now() AT TIME ZONE 'UTC')::date, 1)
  ON CONFLICT (org_id, day) DO UPDATE SET reads = r.reads + 1 WHERE r.reads < allowed
  RETURNING r.reads INTO used;
  IF used IS NULL THEN
    RETURN QUERY SELECT 'quota'::text, NULL::date, NULL::text, NULL::float8;
    RETURN;
  END IF;
  RETURN QUERY
    SELECT 'ok'::text, c.day, p.label, c.dp_noisy_intent_count::float8
      FROM app.olap_daily_commerce_cube c JOIN app.products p ON p.id = c.product_entity_id
     WHERE c.field_id = in_field AND c.k_distinct_contributors >= 25
       AND c.day > (now() AT TIME ZONE 'UTC')::date - least(greatest(in_days, 1), 90)
     ORDER BY c.day DESC, c.dp_noisy_intent_count DESC
     LIMIT 500;
END
$$;
REVOKE ALL ON FUNCTION app.enterprise_topic_demand(text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.enterprise_topic_demand(text, text, integer) TO app_api;

-- The daily retrieval comparison reads the last 90 days of opens, newest first (platform/evaluations.ts).
CREATE INDEX IF NOT EXISTS search_opens_opened ON app.search_opens (opened_at);

UPDATE app.schema_meta SET version = 85, applied_at = now();
