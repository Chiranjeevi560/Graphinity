-- A finite knowledge-discovery feed uses only sources whose separate
-- collection consent is active. The recommendation purpose itself is opt-in.
INSERT INTO app.consent_categories
  (name, purpose, data_description, retention, recipients, policy_version, required_for_service)
VALUES
  ('feed_personalization',
   'Show a finite list of Graphinity questions ranked from your selected topics and separately consented search or reading history.',
   'Selected profile topics; search text only while search_history is enabled; viewed question identifiers only while reading_history is enabled. No new history is stored by recommendations.',
   'No additional recommendation history is retained. Source signals follow their own category retention and deletion controls.',
   'Graphinity only; no personal data is sent to merchants or other partners by this feature.',
   1, false)
ON CONFLICT (name) DO NOTHING;

CREATE INDEX IF NOT EXISTS questions_field_recent_idx
  ON app.questions (field, created_at DESC, id DESC);

UPDATE app.schema_meta SET version = 26, applied_at = now();
