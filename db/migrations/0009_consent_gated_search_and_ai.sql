-- New consent text makes semantic processing explicit. Existing AI choices
-- are revoked so no prior user is opted into the newly documented purpose.
UPDATE app.consent_categories
SET data_description = 'Search query text and the optional topic filter entered into Graphinity; the query is not sent to a partner.',
    retention = 'Search events expire within 365 days and may be inspected or deleted sooner; revoking consent stops new capture.'
WHERE name = 'search_history';
UPDATE app.consent_categories
SET data_description = 'Question identifiers opened while signed in; Graphinity does not measure reading duration.',
    retention = 'View events expire within 365 days and may be inspected or deleted sooner; revoking consent stops new capture.'
WHERE name = 'reading_history';
UPDATE app.consent_categories
SET data_description = 'Typed question, answer, selection, helpful-mark, and report event names and source identifiers; no post text is copied into these event records.',
    retention = 'Interaction events expire within 365 days and may be inspected or deleted sooner; revoking consent stops new capture.'
WHERE name = 'interaction_history';
UPDATE app.consent_categories
SET purpose = 'Use question text with the named AI processor for semantic matching and AI-assisted personalization in Graphinity.',
    data_description = 'Question title and optional details are sent to the configured embedding provider for semantic matching only when this category is enabled; semantic similarity is stored on the question.',
    retention = 'Graphinity deletes generated vectors when consent is revoked or the question/account is deleted. Cloudflare states standard Workers AI inference has zero data retention after processing and no training use; limited exceptions are described in its data usage policy.',
    recipients = 'Graphinity and Cloudflare Workers AI for standard inference; provider terms and documented exceptions apply.',
    policy_version = 2
WHERE name = 'ai_personalization';

WITH revoked AS (
  UPDATE app.user_consent_settings
  SET enabled = false, policy_version = 2, updated_at = clock_timestamp()
  WHERE category = 'ai_personalization' AND enabled
  RETURNING user_id
)
INSERT INTO app.user_consent_audit_log (user_id, category, enabled, policy_version, source)
SELECT user_id, 'ai_personalization', false, 2, 'settings' FROM revoked;

UPDATE app.user_consent_settings
SET policy_version = 2, updated_at = clock_timestamp()
WHERE category = 'ai_personalization' AND policy_version < 2;

DROP POLICY IF EXISTS consent_settings_system_read ON app.user_consent_settings;
CREATE POLICY consent_settings_system_read ON app.user_consent_settings FOR SELECT TO app_api
  USING (app.is_system());

UPDATE app.questions q
SET embedding = NULL, embedding_model = NULL
WHERE q.embedding IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM app.user_consent_settings s
  WHERE s.user_id = q.asker_id AND s.category = 'ai_personalization' AND s.enabled
);

CREATE OR REPLACE FUNCTION app.clear_revoked_question_embeddings() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF NEW.category = 'ai_personalization' AND OLD.enabled AND NOT NEW.enabled THEN
    UPDATE app.questions SET embedding = NULL, embedding_model = NULL WHERE asker_id = NEW.user_id;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.clear_revoked_question_embeddings() FROM PUBLIC;
CREATE TRIGGER clear_revoked_question_embeddings
  AFTER UPDATE OF enabled ON app.user_consent_settings
  FOR EACH ROW EXECUTE FUNCTION app.clear_revoked_question_embeddings();

-- Revoked users' vectors must not be candidate data for anyone else's search.
CREATE OR REPLACE FUNCTION app.nearest_questions(target text, model text, in_field text, lim integer)
  RETURNS TABLE (id bigint, similarity double precision)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, extensions, app, pg_temp
AS $$
  SELECT q.id, 1 - (q.embedding <=> target::extensions.halfvec(768))
  FROM app.questions q
  WHERE q.embedding IS NOT NULL AND q.embedding_model = model
    AND EXISTS (
      SELECT 1 FROM app.user_consent_settings s
      WHERE s.user_id = q.asker_id AND s.category = 'ai_personalization' AND s.enabled
    )
    AND (in_field IS NULL OR q.field = in_field)
    AND NOT app.is_question_hidden(q.id)
  ORDER BY q.embedding <=> target::extensions.halfvec(768)
  LIMIT least(greatest(lim, 1), 50)
$$;
REVOKE ALL ON FUNCTION app.nearest_questions(text, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.nearest_questions(text, text, text, integer) TO app_api;

UPDATE app.schema_meta SET version = 24, applied_at = now();
