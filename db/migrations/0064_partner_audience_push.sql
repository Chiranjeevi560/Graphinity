-- Sending a partner lists of people interested in a topic (ADR 0022 part 9). Off by default, and a partner receives
-- nothing until the owner gives it a push address, which needs a contract and a lawyer. The ledger names no person:
-- it says a topic went to a partner on a day and to how many, and makes that at most once a day.
INSERT INTO app.feature_flags (name, enabled, note) VALUES
  ('ads_partner_push', false, 'Send partners cohorts of consenting people, 100 or more per topic')
ON CONFLICT (name) DO NOTHING;

ALTER TABLE app.ad_partners ADD COLUMN IF NOT EXISTS push_endpoint text CHECK (
  char_length(push_endpoint) <= 500
  AND push_endpoint ~ '^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(/[A-Za-z0-9._~/-]*)?$'
  AND push_endpoint !~ '^https://([^/]*\.)?(localhost|local|internal|localdomain|home\.arpa)(/|$)');

CREATE TABLE IF NOT EXISTS app.ad_partner_pushes (
  partner_id bigint NOT NULL REFERENCES app.ad_partners (id) ON DELETE CASCADE,
  field      text NOT NULL REFERENCES app.fields (slug) ON DELETE CASCADE,
  day        date NOT NULL,
  people     integer NOT NULL CHECK (people >= 100),
  delivered  boolean NOT NULL DEFAULT false,
  PRIMARY KEY (partner_id, field, day)
);
ALTER TABLE app.ad_partner_pushes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ad_partner_pushes FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE (delivered) ON app.ad_partner_pushes TO app_api;
DROP POLICY IF EXISTS ad_partner_pushes_system ON app.ad_partner_pushes;
CREATE POLICY ad_partner_pushes_system ON app.ad_partner_pushes FOR ALL TO app_api
  USING (app.is_system()) WITH CHECK (app.is_system());

UPDATE app.schema_meta SET version = 79, applied_at = now();
