-- Step-up sign-in (docs/adr/0026-step-up-and-transport.md). Off until the owner has
-- checked once that real Supabase tokens carry a usable sign-in time: on without
-- that, people could not delete their accounts.
INSERT INTO app.feature_flags (name, enabled, note) VALUES
  ('step_up_auth', false, 'Dangerous actions need a sign-in from the last 5 minutes. Off: any valid sign-in is enough.')
ON CONFLICT (name) DO NOTHING;

UPDATE app.schema_meta SET version = 61, applied_at = now();
