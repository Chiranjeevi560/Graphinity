-- Reading meaning vectors for diversity. The API role can't cast halfvec (it has no rights on the extensions schema),
-- so this owner-run function hands them over as text. Hidden questions are left out.
CREATE OR REPLACE FUNCTION app.question_vectors(ids bigint[], by_model text)
  RETURNS TABLE (id bigint, vector text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT e.question_id, e.embedding::text
  FROM app.question_embeddings e
  WHERE e.question_id = ANY(ids) AND e.model = by_model AND cardinality(ids) <= 200
    AND NOT app.is_question_hidden(e.question_id)
$$;
REVOKE ALL ON FUNCTION app.question_vectors(bigint[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.question_vectors(bigint[], text) TO app_api;

UPDATE app.schema_meta SET version = 77, applied_at = now();
