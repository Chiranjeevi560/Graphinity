-- Feature flags and kill switches (apps/api/src/flags.ts). The owner turns a
-- flag on or off in the Supabase SQL editor; every server picks it up within
-- 30 seconds, with no deploy:
--   UPDATE app.feature_flags SET enabled = false, note = 'why', updated_at = now() WHERE name = 'embeddings';
-- The API can only read them: a bug or a stolen API login can't flip one.

CREATE TABLE IF NOT EXISTS app.feature_flags (
  name        text PRIMARY KEY CHECK (name ~ '^[a-z][a-z0-9_]{0,39}$'),
  enabled     boolean NOT NULL,
  -- What it controls, or why it was last changed: for the owner, never shown to visitors.
  note        text NOT NULL DEFAULT '' CHECK (char_length(note) <= 300),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.feature_flags FORCE ROW LEVEL SECURITY;
GRANT SELECT ON app.feature_flags TO app_api;
CREATE POLICY feature_flags_read ON app.feature_flags FOR SELECT TO app_api USING (true);

-- The switches the code has today. Each one's "off" is a working state: the
-- site keeps going without that part. Re-running keeps the owner's choices.
INSERT INTO app.feature_flags (name, enabled, note) VALUES
  ('embeddings', true, 'Search by meaning (Cloudflare Workers AI). Off: matching by words only, no calls to Cloudflare.'),
  ('push', true, 'Notifications to people''s devices. Off: nothing is sent; the site shows everything as before.')
ON CONFLICT (name) DO NOTHING;

UPDATE app.schema_meta SET version = 17, applied_at = now();
