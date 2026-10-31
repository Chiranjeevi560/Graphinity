-- OLAP and commerce (master charter §8, §9). Questions and answers stream into a journal by trigger,
-- a watermark drains it into daily cubes, and dashboards read only cubes. A subject is a daily-rotated
-- keyed hash, so nothing in a cube leads back to anyone. Commerce rows need 25 distinct contributors.

CREATE TABLE IF NOT EXISTS app.analytics_event_journal (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('question', 'answer')),
  field       text,
  country     text CHECK (country ~ '^[A-Z]{2}$'),
  subject     uuid,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS analytics_journal_time ON app.analytics_event_journal (occurred_at);

CREATE TABLE IF NOT EXISTS app.olap_watermarks (
  name     text PRIMARY KEY,
  last_id  bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS app.olap_daily_platform_cube (
  day              date NOT NULL,
  field_id         text NOT NULL,
  country_iso      text NOT NULL,
  events           bigint NOT NULL DEFAULT 0 CHECK (events >= 0),
  questions        bigint NOT NULL DEFAULT 0 CHECK (questions >= 0),
  answers          bigint NOT NULL DEFAULT 0 CHECK (answers >= 0),
  hll_unique_users bytea NOT NULL,
  cms_top_entities bytea NOT NULL,
  PRIMARY KEY (day, field_id, country_iso)
);

CREATE TABLE IF NOT EXISTS app.products (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key       text NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9-]{1,80}$'),
  brand     text NOT NULL,
  label     text NOT NULL CHECK (char_length(label) <= 120)
);

CREATE TABLE IF NOT EXISTS app.product_mentions_daily (
  day          date NOT NULL,
  product_id   bigint NOT NULL REFERENCES app.products (id) ON DELETE CASCADE,
  field_id     text NOT NULL,
  mentions     integer NOT NULL CHECK (mentions > 0),
  contributors bytea NOT NULL,
  PRIMARY KEY (day, product_id, field_id)
);

CREATE TABLE IF NOT EXISTS app.olap_daily_commerce_cube (
  day                       date NOT NULL,
  field_id                  text NOT NULL,
  product_entity_id         bigint NOT NULL REFERENCES app.products (id) ON DELETE CASCADE,
  k_distinct_contributors   integer NOT NULL CHECK (k_distinct_contributors >= 25),
  dp_noisy_intent_count     integer NOT NULL CHECK (dp_noisy_intent_count >= 0),
  holt_winters_forecast_30d real,
  conformal_interval_90     real,
  PRIMARY KEY (day, field_id, product_entity_id)
);

-- Journal writes: a trigger, so no route can forget, and a failure here can't lose the post.
CREATE OR REPLACE FUNCTION app.journal_post() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  who uuid;
  topic text;
  place text;
BEGIN
  IF TG_TABLE_NAME = 'questions' THEN
    who := NEW.asker_id; topic := NEW.field;
  ELSE
    who := NEW.answerer_id;
    SELECT q.field INTO topic FROM app.questions q WHERE q.id = NEW.question_id;
  END IF;
  SELECT p.country INTO place FROM app.profiles p WHERE p.id = who;
  INSERT INTO app.analytics_event_journal (kind, field, country, subject)
  VALUES (CASE TG_TABLE_NAME WHEN 'questions' THEN 'question' ELSE 'answer' END, topic, place, who);
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.journal_post() FROM PUBLIC;
DROP TRIGGER IF EXISTS questions_journal ON app.questions;
CREATE TRIGGER questions_journal AFTER INSERT ON app.questions FOR EACH ROW EXECUTE FUNCTION app.journal_post();
DROP TRIGGER IF EXISTS answers_journal ON app.answers;
CREATE TRIGGER answers_journal AFTER INSERT ON app.answers FOR EACH ROW EXECUTE FUNCTION app.journal_post();

-- Deleting an account deletes everything: its journal rows too. (Sketches hold only rotated hashes.)
CREATE OR REPLACE FUNCTION app.journal_forget() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  DELETE FROM app.analytics_event_journal WHERE subject = OLD.id;
  RETURN OLD;
END
$$;
REVOKE ALL ON FUNCTION app.journal_forget() FROM PUBLIC;
DROP TRIGGER IF EXISTS profiles_journal_forget ON app.profiles;
CREATE TRIGGER profiles_journal_forget BEFORE DELETE ON app.profiles FOR EACH ROW EXECUTE FUNCTION app.journal_forget();

ALTER TABLE app.analytics_event_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.analytics_event_journal FORCE ROW LEVEL SECURITY;
ALTER TABLE app.olap_watermarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.olap_watermarks FORCE ROW LEVEL SECURITY;
ALTER TABLE app.olap_daily_platform_cube ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.olap_daily_platform_cube FORCE ROW LEVEL SECURITY;
ALTER TABLE app.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.products FORCE ROW LEVEL SECURITY;
ALTER TABLE app.product_mentions_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.product_mentions_daily FORCE ROW LEVEL SECURITY;
ALTER TABLE app.olap_daily_commerce_cube ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.olap_daily_commerce_cube FORCE ROW LEVEL SECURITY;
GRANT SELECT, DELETE ON app.analytics_event_journal TO app_api;
GRANT SELECT, INSERT, UPDATE ON app.olap_watermarks TO app_api;
GRANT SELECT, INSERT, UPDATE ON app.olap_daily_platform_cube TO app_api;
GRANT SELECT, INSERT, UPDATE ON app.products TO app_api;
GRANT SELECT, INSERT, UPDATE ON app.product_mentions_daily TO app_api;
GRANT SELECT, INSERT, UPDATE ON app.olap_daily_commerce_cube TO app_api;
DROP POLICY IF EXISTS journal_system ON app.analytics_event_journal;
CREATE POLICY journal_system ON app.analytics_event_journal FOR ALL TO app_api USING (app.is_system()) WITH CHECK (app.is_system());
DROP POLICY IF EXISTS watermarks_system ON app.olap_watermarks;
CREATE POLICY watermarks_system ON app.olap_watermarks FOR ALL TO app_api USING (app.is_system()) WITH CHECK (app.is_system());
DROP POLICY IF EXISTS platform_cube_owner ON app.olap_daily_platform_cube;
CREATE POLICY platform_cube_owner ON app.olap_daily_platform_cube FOR ALL TO app_api USING (app.is_system() OR app.is_owner()) WITH CHECK (app.is_system());
DROP POLICY IF EXISTS products_system ON app.products;
CREATE POLICY products_system ON app.products FOR ALL TO app_api USING (app.is_system() OR app.is_owner()) WITH CHECK (app.is_system());
DROP POLICY IF EXISTS mentions_system ON app.product_mentions_daily;
CREATE POLICY mentions_system ON app.product_mentions_daily FOR ALL TO app_api USING (app.is_system()) WITH CHECK (app.is_system());
DROP POLICY IF EXISTS commerce_cube_owner ON app.olap_daily_commerce_cube;
CREATE POLICY commerce_cube_owner ON app.olap_daily_commerce_cube FOR ALL TO app_api USING (app.is_system() OR app.is_owner()) WITH CHECK (app.is_system());

UPDATE app.schema_meta SET version = 58, applied_at = now();
