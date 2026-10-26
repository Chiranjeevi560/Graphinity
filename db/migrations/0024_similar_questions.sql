-- Recommendations v3 (docs/adr/0016-recommendations-v3.md): "similar to a
-- question you opened", by meaning. Vectors are readable only by the
-- background job (app.question_embeddings, migration 0021), so this runs as
-- the schema owner and takes only a question id: it says which questions are
-- near a public question, never anything about a person. Searched like
-- app.nearest_questions: ef_search 400, an iterative scan, hidden questions
-- checked on the nearest 2k only.
CREATE OR REPLACE FUNCTION app.similar_questions(seed bigint, model text, lim integer)
  RETURNS TABLE (id bigint, similarity double precision)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, extensions, app, pg_temp
  SET hnsw.ef_search = 400
  SET hnsw.iterative_scan = relaxed_order
AS $$
#variable_conflict use_column
DECLARE
  v extensions.halfvec;
  k integer := least(greatest(lim, 1), 50);
BEGIN
  SELECT e.embedding INTO v FROM app.question_embeddings e
  WHERE e.question_id = seed AND e.model = similar_questions.model;
  IF v IS NULL OR app.is_question_hidden(seed) THEN RETURN; END IF;
  IF extensions.vector_dims(v) = 128 THEN
    RETURN QUERY
    WITH near AS MATERIALIZED (
      SELECT e.question_id, e.embedding::extensions.halfvec(128) <=> v::extensions.halfvec(128) AS d
      FROM app.question_embeddings e
      WHERE extensions.vector_dims(e.embedding) = 128 AND e.model = similar_questions.model AND e.question_id <> seed
      ORDER BY e.embedding::extensions.halfvec(128) <=> v::extensions.halfvec(128)
      LIMIT k * 2
    )
    SELECT near.question_id, 1 - near.d FROM near
    WHERE NOT app.is_question_hidden(near.question_id)
    ORDER BY near.d, near.question_id
    LIMIT k;
  ELSE
    RETURN QUERY
    WITH near AS MATERIALIZED (
      SELECT e.question_id, e.embedding <=> v AS d
      FROM app.question_embeddings e
      WHERE e.model = similar_questions.model AND e.question_id <> seed
        AND extensions.vector_dims(e.embedding) = extensions.vector_dims(v)
      ORDER BY e.embedding <=> v, e.question_id
      LIMIT k * 2
    )
    SELECT near.question_id, 1 - near.d FROM near
    WHERE NOT app.is_question_hidden(near.question_id)
    ORDER BY near.d, near.question_id
    LIMIT k;
  END IF;
END
$$;
REVOKE ALL ON FUNCTION app.similar_questions(bigint, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.similar_questions(bigint, text, integer) TO app_api;

UPDATE app.schema_meta SET version = 39, applied_at = now();
