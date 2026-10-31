-- What the owner's page was missing (docs/adr/0029-owner-analytics.md): weekly cohort retention, time to
-- a first answer as t-digests, resolved questions, and which products people ask about together.
-- Only counts and sketches: none of it holds an id, and each is rebuilt from what remains.
CREATE TABLE IF NOT EXISTS app.olap_cohort_retention (
  cohort_week date NOT NULL,
  week_offset smallint NOT NULL CHECK (week_offset BETWEEN 0 AND 12),
  cohort_size integer NOT NULL CHECK (cohort_size >= 0),
  active      integer NOT NULL CHECK (active >= 0),
  PRIMARY KEY (cohort_week, week_offset)
);
CREATE TABLE IF NOT EXISTS app.olap_daily_answering (
  day             date NOT NULL,
  field_id        text NOT NULL,
  questions       integer NOT NULL CHECK (questions >= 0),
  -- Picked or marked helpful within 4 days of asking: a person said it was resolved.
  resolved_4d     integer NOT NULL CHECK (resolved_4d >= 0),
  answered        integer NOT NULL CHECK (answered >= 0),
  -- Minutes to the first answer.
  tdigest_minutes bytea NOT NULL,
  PRIMARY KEY (day, field_id)
);
CREATE TABLE IF NOT EXISTS app.olap_commerce_rules (
  from_product bigint NOT NULL REFERENCES app.products (id) ON DELETE CASCADE,
  to_product   bigint NOT NULL REFERENCES app.products (id) ON DELETE CASCADE,
  -- Distinct people who asked about both in the window; at least 25, or there's no row.
  people       integer NOT NULL CHECK (people >= 25),
  confidence   real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  lift         real NOT NULL CHECK (lift >= 0),
  computed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_product, to_product)
);
ALTER TABLE app.olap_cohort_retention ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.olap_cohort_retention FORCE ROW LEVEL SECURITY;
ALTER TABLE app.olap_daily_answering ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.olap_daily_answering FORCE ROW LEVEL SECURITY;
ALTER TABLE app.olap_commerce_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.olap_commerce_rules FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.olap_cohort_retention, app.olap_daily_answering, app.olap_commerce_rules TO app_api;
DROP POLICY IF EXISTS retention_owner ON app.olap_cohort_retention;
CREATE POLICY retention_owner ON app.olap_cohort_retention FOR SELECT TO app_api USING (app.is_system() OR app.is_owner());
DROP POLICY IF EXISTS retention_system ON app.olap_cohort_retention;
CREATE POLICY retention_system ON app.olap_cohort_retention FOR ALL TO app_api USING (app.is_system()) WITH CHECK (app.is_system());
DROP POLICY IF EXISTS answering_owner ON app.olap_daily_answering;
CREATE POLICY answering_owner ON app.olap_daily_answering FOR SELECT TO app_api USING (app.is_system() OR app.is_owner());
DROP POLICY IF EXISTS answering_system ON app.olap_daily_answering;
CREATE POLICY answering_system ON app.olap_daily_answering FOR ALL TO app_api USING (app.is_system()) WITH CHECK (app.is_system());
DROP POLICY IF EXISTS rules_owner ON app.olap_commerce_rules;
CREATE POLICY rules_owner ON app.olap_commerce_rules FOR SELECT TO app_api USING (app.is_system() OR app.is_owner());
DROP POLICY IF EXISTS rules_system ON app.olap_commerce_rules;
CREATE POLICY rules_system ON app.olap_commerce_rules FOR ALL TO app_api USING (app.is_system()) WITH CHECK (app.is_system());

UPDATE app.schema_meta SET version = 64, applied_at = now();
