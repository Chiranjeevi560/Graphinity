-- Learned click prediction (docs/adr/0022-advertising-platform.md part 5):
-- each impression keeps the page's topic as shown, the point-in-time
-- feature a click model learns from (with its campaign, ad, placement and
-- hour). The page's topic, never anything about the person.
ALTER TABLE app.ad_impressions ADD COLUMN IF NOT EXISTS field text
  CHECK (field IS NULL OR (field ~ '^[a-z]+(-[a-z]+)*$' AND char_length(field) <= 40));
GRANT INSERT (field) ON app.ad_impressions TO app_api;

UPDATE app.schema_meta SET version = 48, applied_at = now();
