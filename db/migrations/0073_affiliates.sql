-- Affiliate referrals (ADR 0036): the owner adds a program (a shop or network, the host its links go to, and the tag
-- that earns commission) and attaches labelled links to questions; a click goes through Graphinity's redirect, which
-- adds the tag. Counts are per link per day with no person in them. With the reader's yes to affiliate_optimization,
-- the click also gets a random token the network reports back with a sale; still no person. Off by default.
INSERT INTO app.feature_flags (name, enabled, note) VALUES
  ('affiliates', false, 'Labelled affiliate links on questions, through Graphinity''s redirect')
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS app.affiliate_programs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id   uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100 AND name = btrim(name) AND name !~ '[[:cntrl:]]'),
  -- Links may go only to this host (or its subdomains), over https.
  host        text NOT NULL CHECK (host ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'),
  tag_param   text NOT NULL CHECK (tag_param ~ '^[A-Za-z][A-Za-z0-9_]{0,31}$'),
  tag_value   text NOT NULL CHECK (tag_value ~ '^[A-Za-z0-9_.-]{1,64}$'),
  -- The query parameter the network echoes back with a sale, if it supports one.
  click_param text CHECK (click_param ~ '^[A-Za-z][A-Za-z0-9_]{0,31}$'),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.affiliate_links (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token       uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  program_id  bigint NOT NULL REFERENCES app.affiliate_programs (id) ON DELETE CASCADE,
  question_id bigint NOT NULL REFERENCES app.questions (id) ON DELETE CASCADE,
  label       text NOT NULL CHECK (char_length(label) BETWEEN 2 AND 80 AND label = btrim(label) AND label !~ '[[:cntrl:]]'),
  destination text NOT NULL CHECK (char_length(destination) <= 500 AND destination ~ '^https://[^/?#\s]+(/[^\s]*)?$'),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS affiliate_links_question ON app.affiliate_links (question_id);

-- Clicks per link per day: no person, no address, no time of day.
CREATE TABLE IF NOT EXISTS app.affiliate_clicks (
  link_id bigint NOT NULL REFERENCES app.affiliate_links (id) ON DELETE CASCADE,
  day     date NOT NULL,
  clicks  integer NOT NULL CHECK (clicks >= 0),
  PRIMARY KEY (link_id, day)
);

-- A click token, made only with the reader's yes to affiliate_optimization: random, tied to the link, never a person.
CREATE TABLE IF NOT EXISTS app.affiliate_click_tokens (
  token      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id    bigint NOT NULL REFERENCES app.affiliate_links (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS affiliate_click_tokens_age ON app.affiliate_click_tokens (created_at);

-- A sale the network reports for a click token, once per network order id.
CREATE TABLE IF NOT EXISTS app.affiliate_conversions (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  program_id        bigint NOT NULL REFERENCES app.affiliate_programs (id) ON DELETE CASCADE,
  link_id           bigint REFERENCES app.affiliate_links (id) ON DELETE SET NULL,
  order_ref         text NOT NULL CHECK (char_length(order_ref) BETWEEN 1 AND 100),
  commission_paise  integer NOT NULL CHECK (commission_paise BETWEEN 0 AND 100000000),
  reported_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (program_id, order_ref)
);

ALTER TABLE app.affiliate_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.affiliate_programs FORCE ROW LEVEL SECURITY;
ALTER TABLE app.affiliate_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.affiliate_links FORCE ROW LEVEL SECURITY;
ALTER TABLE app.affiliate_clicks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.affiliate_clicks FORCE ROW LEVEL SECURITY;
ALTER TABLE app.affiliate_click_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.affiliate_click_tokens FORCE ROW LEVEL SECURITY;
ALTER TABLE app.affiliate_conversions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.affiliate_conversions FORCE ROW LEVEL SECURITY;

GRANT SELECT ON app.affiliate_programs, app.affiliate_links, app.affiliate_clicks, app.affiliate_click_tokens,
  app.affiliate_conversions TO app_api;
GRANT INSERT (name, host, tag_param, tag_value, click_param) ON app.affiliate_programs TO app_api;
GRANT UPDATE (active) ON app.affiliate_programs TO app_api;
GRANT INSERT (program_id, question_id, label, destination) ON app.affiliate_links TO app_api;
GRANT DELETE ON app.affiliate_links TO app_api;
GRANT INSERT, UPDATE (clicks) ON app.affiliate_clicks TO app_api;
GRANT INSERT (link_id), DELETE ON app.affiliate_click_tokens TO app_api;
GRANT INSERT (program_id, link_id, order_ref, commission_paise) ON app.affiliate_conversions TO app_api;

-- Programs and links: the owner manages them, while the switch is on; anyone may read a live program's links (they
-- are shown on public questions). Counts, tokens and sales: the server's own system context, and the owner reads.
DROP POLICY IF EXISTS affiliate_programs_owner ON app.affiliate_programs;
CREATE POLICY affiliate_programs_owner ON app.affiliate_programs FOR ALL TO app_api
  USING (app.is_system() OR app.is_owner() OR active)
  WITH CHECK (app.flag_on('affiliates') AND app.is_owner());
DROP POLICY IF EXISTS affiliate_links_read ON app.affiliate_links;
CREATE POLICY affiliate_links_read ON app.affiliate_links FOR SELECT TO app_api USING (true);
DROP POLICY IF EXISTS affiliate_links_make ON app.affiliate_links;
CREATE POLICY affiliate_links_make ON app.affiliate_links FOR INSERT TO app_api
  WITH CHECK (app.flag_on('affiliates') AND app.is_owner());
DROP POLICY IF EXISTS affiliate_links_remove ON app.affiliate_links;
CREATE POLICY affiliate_links_remove ON app.affiliate_links FOR DELETE TO app_api USING (app.is_owner());
DROP POLICY IF EXISTS affiliate_clicks_system ON app.affiliate_clicks;
CREATE POLICY affiliate_clicks_system ON app.affiliate_clicks FOR ALL TO app_api
  USING (app.is_system() OR app.is_owner()) WITH CHECK (app.is_system());
DROP POLICY IF EXISTS affiliate_click_tokens_system ON app.affiliate_click_tokens;
CREATE POLICY affiliate_click_tokens_system ON app.affiliate_click_tokens FOR ALL TO app_api
  USING (app.is_system()) WITH CHECK (app.is_system());
DROP POLICY IF EXISTS affiliate_conversions_system ON app.affiliate_conversions;
CREATE POLICY affiliate_conversions_system ON app.affiliate_conversions FOR ALL TO app_api
  USING (app.is_system() OR app.is_owner()) WITH CHECK (app.is_system());

-- A link may only go to its program's host or a subdomain of it: no open redirect, whoever writes the row.
CREATE OR REPLACE FUNCTION app.affiliate_link_host() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  allowed text;
  dest_host text;
BEGIN
  SELECT host INTO allowed FROM app.affiliate_programs WHERE id = NEW.program_id;
  dest_host := lower(substring(NEW.destination FROM '^https://([^/?#:@\s]+)'));
  IF dest_host IS NULL OR NOT (dest_host = allowed OR dest_host LIKE '%.' || allowed) THEN
    RAISE EXCEPTION 'an affiliate link goes only to its program''s host' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.affiliate_link_host() FROM PUBLIC;
DROP TRIGGER IF EXISTS affiliate_link_host ON app.affiliate_links;
CREATE TRIGGER affiliate_link_host BEFORE INSERT ON app.affiliate_links FOR EACH ROW EXECUTE FUNCTION app.affiliate_link_host();

UPDATE app.schema_meta SET version = 88, applied_at = now();
