-- Search, part 1 (docs/adr/0015-search.md): consent made accurate and
-- purpose-based before any search data is collected.

-- 1. Meaning-based matching runs only on Graphinity's own server (ADR 0010):
-- question text no longer goes to any outside AI. Owner decision 2026-10-25:
-- it is part of the service for everyone, like word search, and is announced
-- once in the app (the privacy update below). The AI choice stays, for any
-- future AI-assisted personal feature, with text that is true today.
UPDATE app.consent_categories
SET purpose = 'Use your Graphinity information for AI-assisted features personalized to you, when such features are offered.',
    data_description = 'None today: no AI-assisted personal feature exists yet. Matching questions by meaning runs on Graphinity''s own servers for everyone and sends nothing to an outside AI.',
    retention = 'Described per feature before it is offered; turning this off stops future use.',
    recipients = 'Graphinity only. No outside AI service is used.',
    policy_version = 3
WHERE name = 'ai_personalization';

-- Vectors no longer depend on that choice: they are computed on our server from
-- public question text, as the word index is.
DROP TRIGGER IF EXISTS clear_revoked_question_embeddings ON app.user_consent_settings;
DROP FUNCTION IF EXISTS app.clear_revoked_question_embeddings();

-- 2. Learning one search ranking for everyone is its own purpose: separate from
-- your own search history, off by default, asked once (prompt_once), and what
-- it collected is deleted when it is turned off (with the search tables, part 3).
ALTER TABLE app.consent_categories ADD COLUMN IF NOT EXISTS prompt_once boolean NOT NULL DEFAULT false;
INSERT INTO app.consent_categories
  (name, purpose, data_description, retention, recipients, policy_version, required_for_service, prompt_once)
VALUES
  ('search_improvement',
   'Use the searches you make in Graphinity, the results you were shown, the ones you opened and how long you spent on them, to improve search for everyone.',
   'Search text, the results shown and their order, which you opened, and time spent on an opened question. Only while this is on; nothing from before.',
   'Deleted as soon as you turn this off; otherwise kept at most 365 days. A trained ranking keeps only a few numbers about result features, nothing about you.',
   'Graphinity only.',
   1, false, true)
ON CONFLICT (name) DO NOTHING;

-- 3. Reading history's text said Graphinity never measures reading time; time on a
-- question opened from search is measured, but only under search_improvement.
UPDATE app.consent_categories
SET data_description = 'Question identifiers opened while signed in. Time spent on a question is measured only if "improve search for everyone" is on, and only for questions opened from search.'
WHERE name = 'reading_history';

-- 4. Meaning candidates for everyone, from every visible question with a vector.
CREATE OR REPLACE FUNCTION app.nearest_questions(target text, model text, in_field text, lim integer)
  RETURNS TABLE (id bigint, similarity double precision)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, extensions, app, pg_temp
AS $$
  SELECT q.id, 1 - (q.embedding <=> target::extensions.halfvec(768))
  FROM app.questions q
  WHERE q.embedding IS NOT NULL AND q.embedding_model = model
    AND (in_field IS NULL OR q.field = in_field)
    AND NOT app.is_question_hidden(q.id)
  ORDER BY q.embedding <=> target::extensions.halfvec(768)
  LIMIT least(greatest(lim, 1), 50)
$$;
REVOKE ALL ON FUNCTION app.nearest_questions(text, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.nearest_questions(text, text, text, integer) TO app_api;

UPDATE app.schema_meta SET version = 34, applied_at = now();
