-- Make personalized knowledge discovery globally disableable without a deploy.
INSERT INTO app.feature_flags (name, enabled, note)
VALUES (
  'recommendations', true,
  'Consent-gated finite knowledge suggestions. Off: no recommendation scoring query runs.'
)
ON CONFLICT (name) DO NOTHING;

UPDATE app.schema_meta SET version = 27, applied_at = now();
