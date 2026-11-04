-- Search suggestions from Graphinity's own trigram model (ADR 0035). Off until the owner chooses to show them.
INSERT INTO app.feature_flags (name, enabled, note) VALUES
  ('query_completion', false, 'Finish search queries from public question titles, with Graphinity''s own model')
ON CONFLICT (name) DO NOTHING;

UPDATE app.schema_meta SET version = 87, applied_at = now();
