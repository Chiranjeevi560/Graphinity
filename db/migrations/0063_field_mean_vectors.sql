-- What each topic's questions mean on average, for the knowledge graph's starting features. Owner-run because the API
-- role can't touch the extensions schema. System only; hidden questions don't count. Uses the model with most vectors,
-- since while a new model replaces the old, two can hold vectors at once.
CREATE OR REPLACE FUNCTION app.field_mean_vectors()
  RETURNS TABLE (field text, vector text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, extensions, pg_temp
AS $$
  WITH model AS (
    SELECT e.model FROM app.question_embeddings e GROUP BY e.model ORDER BY count(*) DESC, e.model LIMIT 1
  )
  SELECT q.field, avg(e.embedding::vector)::text
  FROM app.question_embeddings e JOIN model m ON m.model = e.model
  JOIN app.questions q ON q.id = e.question_id
  WHERE app.is_system() AND NOT app.is_question_hidden(q.id)
  GROUP BY q.field
$$;
REVOKE ALL ON FUNCTION app.field_mean_vectors() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.field_mean_vectors() TO app_api;

UPDATE app.schema_meta SET version = 78, applied_at = now();
