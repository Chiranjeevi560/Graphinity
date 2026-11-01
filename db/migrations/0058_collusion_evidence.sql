-- Two more readings for a moderator looking at a possible ring: how much trust reaches it from people outside, and how many
-- of its members sit in a dense block of picks. Evidence only: nothing acts on these numbers by itself.
CREATE TABLE IF NOT EXISTS app.collusion_evidence (
  group_id      bigint PRIMARY KEY REFERENCES app.collusion_groups (id) ON DELETE CASCADE,
  outside_trust real NOT NULL CHECK (outside_trust >= 0),
  dense_members integer NOT NULL CHECK (dense_members >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.collusion_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.collusion_evidence FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON app.collusion_evidence TO app_api;
DROP POLICY IF EXISTS collusion_evidence_read ON app.collusion_evidence;
CREATE POLICY collusion_evidence_read ON app.collusion_evidence FOR SELECT TO app_api
  USING (app.is_system() OR app.is_moderator());
DROP POLICY IF EXISTS collusion_evidence_add ON app.collusion_evidence;
CREATE POLICY collusion_evidence_add ON app.collusion_evidence FOR INSERT TO app_api WITH CHECK (app.is_system());
DROP POLICY IF EXISTS collusion_evidence_change ON app.collusion_evidence;
CREATE POLICY collusion_evidence_change ON app.collusion_evidence FOR UPDATE TO app_api
  USING (app.is_system()) WITH CHECK (app.is_system());

UPDATE app.schema_meta SET version = 73, applied_at = now();
