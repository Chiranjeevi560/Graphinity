-- A tap made while someone allowed only measurement mustn't feed retargeting if they later turn personal ads on: that
-- consent wasn't given then. Every identified impression before this migration was made under personal ads.
ALTER TABLE app.ad_impressions ADD COLUMN IF NOT EXISTS personal boolean NOT NULL DEFAULT false;
UPDATE app.ad_impressions SET personal = true WHERE ad_id IS NOT NULL;
GRANT INSERT (personal) ON app.ad_impressions TO app_api;

-- Evidence for a ring out of the top goes, or it would read as current.
GRANT DELETE ON app.collusion_evidence TO app_api;
DROP POLICY IF EXISTS collusion_evidence_remove ON app.collusion_evidence;
CREATE POLICY collusion_evidence_remove ON app.collusion_evidence FOR DELETE TO app_api USING (app.is_system());

UPDATE app.schema_meta SET version = 74, applied_at = now();
