-- Three-tier memory (charter §10.3), consent-gated, and governance: the audit chain, complaint
-- clocks, statements of reasons, and legal holds (for a lawyer to confirm before launch).

INSERT INTO app.consent_categories (name, purpose, data_description, retention, recipients, policy_version, required_for_service)
SELECT 'memory_personalization',
  'Remember what you look at and how you like things, to make Graphinity quicker for you.',
  'Topics you recently looked at, topics you keep coming back to, and preferences such as units or currency.',
  'Recent topics fade within days. All of it goes when you turn this off or delete your account.',
  'Nobody outside Graphinity.', c.policy_version, false
FROM app.consent_categories c ORDER BY c.policy_version DESC LIMIT 1
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS app.memory_entries (
  user_id   uuid NOT NULL REFERENCES app.profiles (id) ON DELETE CASCADE,
  tier      text NOT NULL CHECK (tier IN ('episodic', 'semantic', 'procedural')),
  key       text NOT NULL CHECK (key ~ '^[a-z0-9_-]{1,80}$'),
  value     text CHECK (char_length(value) <= 40),
  strength  real NOT NULL DEFAULT 1 CHECK (strength >= 0),
  reviews   integer NOT NULL DEFAULT 0 CHECK (reviews >= 0),
  seen_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tier, key)
);
ALTER TABLE app.memory_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memory_entries FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.memory_entries TO app_api;
DROP POLICY IF EXISTS memory_own ON app.memory_entries;
CREATE POLICY memory_own ON app.memory_entries FOR ALL TO app_api
  USING (app.is_system() OR user_id = app.current_user_id())
  WITH CHECK (app.is_system() OR (user_id = app.current_user_id() AND EXISTS (
    SELECT 1 FROM app.user_consent_settings s
    WHERE s.user_id = app.current_user_id() AND s.category = 'memory_personalization' AND s.enabled)));

-- Withdrawn: forgotten in the same transaction.
CREATE OR REPLACE FUNCTION app.memory_forget_on_revoke() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.category = 'memory_personalization' AND NOT NEW.enabled THEN
    DELETE FROM app.memory_entries WHERE user_id = NEW.user_id;
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.memory_forget_on_revoke() FROM PUBLIC;
DROP TRIGGER IF EXISTS memory_forget ON app.user_consent_settings;
CREATE TRIGGER memory_forget AFTER INSERT OR UPDATE ON app.user_consent_settings
  FOR EACH ROW EXECUTE FUNCTION app.memory_forget_on_revoke();

CREATE TABLE IF NOT EXISTS app.audit_log (
  seq       bigint PRIMARY KEY,
  action    text NOT NULL CHECK (action ~ '^[a-z_.]{1,60}$'),
  actor     text NOT NULL CHECK (char_length(actor) <= 80),
  subject   text NOT NULL CHECK (char_length(subject) <= 200),
  detail    jsonb NOT NULL DEFAULT '{}',
  at        timestamptz NOT NULL,
  prev_hash text NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  hash      text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$')
);
-- Append-only, even for the schema owner short of disabling this on purpose.
CREATE OR REPLACE FUNCTION app.audit_log_immutable() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'the audit log is append-only' USING ERRCODE = 'check_violation';
END
$$;
REVOKE ALL ON FUNCTION app.audit_log_immutable() FROM PUBLIC;
DROP TRIGGER IF EXISTS audit_log_no_change ON app.audit_log;
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON app.audit_log
  FOR EACH ROW EXECUTE FUNCTION app.audit_log_immutable();
ALTER TABLE app.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_log FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON app.audit_log TO app_api;
DROP POLICY IF EXISTS audit_log_read ON app.audit_log;
CREATE POLICY audit_log_read ON app.audit_log FOR SELECT TO app_api USING (app.is_system() OR app.is_owner());
DROP POLICY IF EXISTS audit_log_write ON app.audit_log;
CREATE POLICY audit_log_write ON app.audit_log FOR INSERT TO app_api WITH CHECK (app.is_system());

CREATE TABLE IF NOT EXISTS app.grievances (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id       uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  user_id         uuid REFERENCES app.profiles (id) ON DELETE SET NULL,
  kind            text NOT NULL CHECK (kind IN ('general', 'unlawful_content', 'personal_data', 'copyright')),
  body            text NOT NULL CHECK (char_length(body) BETWEEN 10 AND 4000),
  question_id     bigint REFERENCES app.questions (id) ON DELETE SET NULL,
  received_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  acknowledged_at timestamptz,
  resolved_at     timestamptz,
  outcome         text CHECK (char_length(outcome) <= 2000),
  acknowledge_by  timestamptz NOT NULL,
  resolve_by      timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS grievances_open ON app.grievances (resolve_by) WHERE resolved_at IS NULL;

CREATE OR REPLACE FUNCTION app.grievance_clock() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- From the database's clock and the kind, never from what was sent.
  NEW.received_at := clock_timestamp();
  NEW.acknowledge_by := NEW.received_at + interval '24 hours';
  NEW.resolve_by := NEW.received_at + CASE NEW.kind WHEN 'unlawful_content' THEN interval '72 hours' ELSE interval '15 days' END;
  NEW.acknowledged_at := NULL;
  NEW.resolved_at := NULL;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.grievance_clock() FROM PUBLIC;
DROP TRIGGER IF EXISTS grievance_clock ON app.grievances;
CREATE TRIGGER grievance_clock BEFORE INSERT ON app.grievances FOR EACH ROW EXECUTE FUNCTION app.grievance_clock();

ALTER TABLE app.grievances ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.grievances FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT (user_id, kind, body, question_id, acknowledge_by, resolve_by) ON app.grievances TO app_api;
GRANT UPDATE (acknowledged_at, resolved_at, outcome) ON app.grievances TO app_api;
DROP POLICY IF EXISTS grievances_read ON app.grievances;
CREATE POLICY grievances_read ON app.grievances FOR SELECT TO app_api
  USING (app.is_system() OR app.is_moderator() OR user_id = app.current_user_id());
DROP POLICY IF EXISTS grievances_add ON app.grievances;
CREATE POLICY grievances_add ON app.grievances FOR INSERT TO app_api WITH CHECK (user_id = app.current_user_id());
DROP POLICY IF EXISTS grievances_handle ON app.grievances;
CREATE POLICY grievances_handle ON app.grievances FOR UPDATE TO app_api USING (app.is_moderator()) WITH CHECK (app.is_moderator());

CREATE TABLE IF NOT EXISTS app.statements_of_reasons (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  question_id  bigint REFERENCES app.questions (id) ON DELETE SET NULL,
  restriction  text NOT NULL CHECK (restriction IN ('removal', 'visibility', 'account', 'demotion')),
  facts        text NOT NULL CHECK (char_length(facts) BETWEEN 10 AND 2000),
  legal_ground text CHECK (char_length(legal_ground) <= 500),
  terms_ground text CHECK (char_length(terms_ground) <= 500),
  automated    boolean NOT NULL,
  redress      text NOT NULL CHECK (char_length(redress) BETWEEN 10 AND 1000),
  issued_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (legal_ground IS NOT NULL OR terms_ground IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS app.legal_holds (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  question_id bigint REFERENCES app.questions (id) ON DELETE SET NULL,
  reason      text NOT NULL CHECK (char_length(reason) BETWEEN 5 AND 500),
  placed_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_at timestamptz
);
ALTER TABLE app.statements_of_reasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.statements_of_reasons FORCE ROW LEVEL SECURITY;
ALTER TABLE app.legal_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.legal_holds FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT (question_id, restriction, facts, legal_ground, terms_ground, automated, redress) ON app.statements_of_reasons TO app_api;
GRANT SELECT, INSERT (question_id, reason) ON app.legal_holds TO app_api;
GRANT UPDATE (released_at) ON app.legal_holds TO app_api;
DROP POLICY IF EXISTS sor_moderators ON app.statements_of_reasons;
CREATE POLICY sor_moderators ON app.statements_of_reasons FOR ALL TO app_api USING (app.is_moderator()) WITH CHECK (app.is_moderator());
DROP POLICY IF EXISTS holds_moderators ON app.legal_holds;
CREATE POLICY holds_moderators ON app.legal_holds FOR ALL TO app_api USING (app.is_moderator()) WITH CHECK (app.is_moderator());

UPDATE app.schema_meta SET version = 59, applied_at = now();
