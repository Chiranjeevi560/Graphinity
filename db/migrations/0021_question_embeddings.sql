-- Search, part 5 (docs/adr/0015-search.md): meaning stored at the model's own
-- size, in its own table, with an index searched the way it was measured.
--
-- Measured before this (scripts/benchmark-search.mjs, benchmark-ann.mjs, 100,000 questions):
-- - Graphinity's own model makes 128 numbers per question; they were stored
--   zero-padded to 768, so the index was 195 MB against 128 MB of shared
--   buffers, and meaning took 36 ms p50 and 201 ms p95 (389 / 1,140 ms with
--   the index grown insert by insert).
-- - pgvector's default ef_search, 40, returns at most 40 rows, so a search for
--   50 lost a fifth of the true neighbours (recall@50 0.80); at 100 it is
--   0.99 in about 5 ms against stored vectors. For new text, as searches are,
--   128 numbers with m 24 reached recall@50 0.98 at ef_search 400 in 4.6 ms
--   p50 (index 68 MB, a third of the padded one's 205 MB).
--
-- Expand: the old column stays (the previous release still reads it during a
-- deploy) but is no longer written or read by this release; contract later.

CREATE TABLE IF NOT EXISTS app.question_embeddings (
  question_id bigint NOT NULL REFERENCES app.questions (id) ON DELETE CASCADE,
  -- Which model made it, e.g. "graphinity:ppmi-svd-sif:v3". Several models may
  -- hold vectors for a question at once, while a new one replaces the old.
  model       text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 80),
  embedding   extensions.halfvec NOT NULL CHECK (extensions.vector_dims(embedding) BETWEEN 1 AND 2000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (question_id, model)
);
ALTER TABLE app.question_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.question_embeddings FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON app.question_embeddings TO app_api;
GRANT UPDATE (embedding, created_at) ON app.question_embeddings TO app_api;
-- Searching goes through the owner-run functions below; the API reads and
-- writes vectors directly only in its background job (app.is_system()), and
-- an asker's request stores the vector of the question it just posted.
DROP POLICY IF EXISTS question_embeddings_system ON app.question_embeddings;
CREATE POLICY question_embeddings_system ON app.question_embeddings FOR ALL TO app_api
  USING (app.is_system()) WITH CHECK (app.is_system());
DROP POLICY IF EXISTS question_embeddings_own_new ON app.question_embeddings;
CREATE POLICY question_embeddings_own_new ON app.question_embeddings FOR INSERT TO app_api
  WITH CHECK (EXISTS (SELECT 1 FROM app.questions q WHERE q.id = question_id AND q.asker_id = app.current_user_id()));

-- The background job stores vectors a batch at a time through this owner-run
-- function: the API role has no rights on the extensions schema to cast with,
-- and a question deleted meanwhile is skipped rather than failing the batch.
CREATE OR REPLACE FUNCTION app.store_question_embeddings(ids bigint[], by_model text, vectors text[]) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, extensions, app, pg_temp
AS $$
DECLARE
  stored integer;
BEGIN
  IF NOT app.is_system() THEN
    RAISE EXCEPTION 'only the background job stores embeddings' USING ERRCODE = '42501';
  END IF;
  INSERT INTO app.question_embeddings (question_id, model, embedding)
  SELECT x.id, by_model, x.v::extensions.halfvec
  FROM unnest(ids, vectors) AS x(id, v) JOIN app.questions q ON q.id = x.id
  ON CONFLICT (question_id, model) DO UPDATE SET embedding = excluded.embedding, created_at = now();
  GET DIAGNOSTICS stored = ROW_COUNT;
  RETURN stored;
END
$$;
REVOKE ALL ON FUNCTION app.store_question_embeddings(bigint[], text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.store_question_embeddings(bigint[], text, text[]) TO app_api;

-- One index per vector size, as pgvector indexes a fixed size: 128 is the own
-- model's (ADR 0010). m and ef_construction as measured (ADR 0015 part 5).
CREATE INDEX IF NOT EXISTS question_embeddings_128 ON app.question_embeddings
  USING hnsw ((embedding::extensions.halfvec(128)) extensions.halfvec_cosine_ops) WITH (m = 24, ef_construction = 200)
  WHERE extensions.vector_dims(embedding) = 128;
CREATE INDEX IF NOT EXISTS question_embeddings_model ON app.question_embeddings (model);

-- The nearest questions in meaning to a given vector, from one model. Indexed
-- for 128 numbers; any other size is compared exactly (development's 768-size
-- stand-in, or a future model before its index exists). ef_search 100 and an
-- iterative scan, so filtering (model, field, hidden) can't starve the result.
CREATE OR REPLACE FUNCTION app.nearest_questions(target text, model text, in_field text, lim integer)
  RETURNS TABLE (id bigint, similarity double precision)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, extensions, app, pg_temp
  SET hnsw.ef_search = 400
  SET hnsw.iterative_scan = relaxed_order
AS $$
-- Columns win over same-named parameters, so the parameter "model" is always
-- written nearest_questions.model (a bare "model" would compare the column to itself).
#variable_conflict use_column
DECLARE
  v extensions.halfvec := target::extensions.halfvec;
  k integer := least(greatest(lim, 1), 50);
BEGIN
  IF extensions.vector_dims(v) = 128 THEN
    RETURN QUERY
    -- relaxed_order may return a few slightly out of order: sorted again here.
    -- Hidden questions are checked on the nearest 2k only, not on every vector the
    -- index visits (up to ef_search 400 of them): the check costs ~60 µs a call.
    WITH near AS MATERIALIZED (
      SELECT e.question_id, e.embedding::extensions.halfvec(128) <=> v::extensions.halfvec(128) AS d
      FROM app.question_embeddings e JOIN app.questions q ON q.id = e.question_id
      WHERE extensions.vector_dims(e.embedding) = 128 AND e.model = nearest_questions.model
        AND (in_field IS NULL OR q.field = in_field)
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
      FROM app.question_embeddings e JOIN app.questions q ON q.id = e.question_id
      WHERE e.model = nearest_questions.model AND extensions.vector_dims(e.embedding) = extensions.vector_dims(v)
        AND (in_field IS NULL OR q.field = in_field)
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
REVOKE ALL ON FUNCTION app.nearest_questions(text, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.nearest_questions(text, text, text, integer) TO app_api;

-- Routing's φ1 (spec §11.2), from the same vectors: the same model for both questions.
CREATE OR REPLACE FUNCTION app.experience_proximity(target bigint, people uuid[])
  RETURNS TABLE (profile_id uuid, proximity double precision)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, extensions, pg_temp
AS $$
  SELECT a.answerer_id, max(1 - (ae.embedding <=> te.embedding))
  FROM app.question_embeddings te
  JOIN app.answers a ON a.answerer_id = ANY (people)
  JOIN app.question_embeddings ae ON ae.question_id = a.question_id AND ae.model = te.model
  WHERE app.is_system() AND te.question_id = target AND a.question_id <> te.question_id
    AND extensions.vector_dims(ae.embedding) = extensions.vector_dims(te.embedding)
    AND NOT app.is_answer_hidden(a.id) AND NOT app.is_question_hidden(a.question_id)
  GROUP BY a.answerer_id
$$;
REVOKE ALL ON FUNCTION app.experience_proximity(bigint, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.experience_proximity(bigint, uuid[]) TO app_api;

-- Word search (migration 0020), with hidden questions checked after scoring
-- instead of once per candidate: measured at 100,000 questions, the per-row
-- check took 15 of 17 ms, and grew to about 20 ms once Postgres switched the
-- function to a generic plan.
CREATE OR REPLACE FUNCTION app.word_search(query text, also text[], prefix text, in_field text, lim integer)
  RETURNS TABLE (id bigint, score double precision)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  budget constant integer := 1000;
  n double precision;
  avg_len double precision;
  terms text[];
  essential text[] := '{}';
  essential_query tsquery;
  used bigint := 0;
  t record;
BEGIN
  SELECT c.docs, c.total_length::float8 / greatest(c.docs, 1) INTO n, avg_len FROM app.search_corpus c;
  IF coalesce(n, 0) = 0 THEN RETURN; END IF;
  SELECT array_agg(DISTINCT x) INTO terms
  FROM unnest(tsvector_to_array(to_tsvector('english', coalesce(query, '') || ' ' || array_to_string(coalesce(also, '{}'), ' ')))) AS x;
  IF prefix IS NOT NULL AND char_length(prefix) >= 2 THEN
    terms := coalesce(terms, '{}') || ARRAY(
      SELECT l.lexeme FROM app.search_lexemes l
      WHERE l.lexeme LIKE replace(replace(replace(lower(prefix), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        AND l.docs > 0
      ORDER BY l.docs DESC, l.lexeme LIMIT 16);
  END IF;
  IF coalesce(cardinality(terms), 0) = 0 THEN RETURN; END IF;
  FOR t IN SELECT l.lexeme, l.docs FROM app.search_lexemes l
           WHERE l.lexeme = ANY (terms) AND l.docs > 0 ORDER BY l.docs, l.lexeme LOOP
    EXIT WHEN cardinality(essential) > 0 AND used + t.docs > budget;
    essential := essential || t.lexeme;
    used := used + t.docs;
  END LOOP;
  IF cardinality(essential) = 0 THEN RETURN; END IF;
  essential_query := array_to_string(ARRAY(SELECT quote_literal(e) FROM unnest(essential) AS e), ' | ')::tsquery;
  -- Planned on every call (EXECUTE): a cached generic plan can't see how rare
  -- the words are and walked the primary key backwards through every question
  -- (measured: 20 ms against 2.3 ms at 100,000). Values pass as parameters, never as text.
  RETURN QUERY EXECUTE $q$
  WITH c AS MATERIALIZED (
    -- One word common enough to exceed the budget alone: its newest questions.
    SELECT q.id, q.search FROM app.questions q
    WHERE q.search @@ $1 AND ($2::text IS NULL OR q.field = $2)
    ORDER BY q.id DESC LIMIT $3
  ), w AS (
    SELECT l.lexeme, ln(1 + ($4 - l.docs + 0.5) / (l.docs + 0.5)) AS idf
    FROM app.search_lexemes l WHERE l.lexeme = ANY ($5) AND l.docs > 0
  ), scored AS MATERIALIZED (
    -- Scored first, then checked for hidden questions: the check costs about
    -- 60 µs a call and ran once per candidate (15 of 17 ms at 100,000 questions).
    -- Twice the rows asked for are checked, so a few hidden ones never shorten
    -- the answer; hidden questions are rare.
    SELECT c.id, sum(w.idf * (tf.v * 2.2) / (tf.v + 1.2 * (0.25 + 0.75 * length(c.search) / $6)))::float8 AS score
    FROM c
    CROSS JOIN LATERAL unnest(c.search) AS u(lexeme, positions, weights)
    JOIN w ON w.lexeme = u.lexeme
    CROSS JOIN LATERAL (SELECT (cardinality(u.weights) + cardinality(array_positions(u.weights, 'A'::text)))::float8 AS v) tf
    GROUP BY c.id, c.search
    ORDER BY 2 DESC, 1 DESC
    LIMIT $7 * 2
  )
  SELECT s.id, s.score FROM scored s
  WHERE NOT app.is_question_hidden(s.id)
  ORDER BY s.score DESC, s.id DESC
  LIMIT $7
  $q$ USING essential_query, in_field, budget * 2, n, terms, avg_len, least(greatest(lim, 1), 100);
END
$$;
REVOKE ALL ON FUNCTION app.word_search(text, text[], text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.word_search(text, text[], text, text, integer) TO app_api;


-- Nothing reads the old column's index any more; it was the 195 MB that didn't fit.
DROP INDEX IF EXISTS app.questions_embedding;

UPDATE app.schema_meta SET version = 36, applied_at = now();
