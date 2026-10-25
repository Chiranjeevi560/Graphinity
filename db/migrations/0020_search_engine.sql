-- Search, part 2 (docs/adr/0015-search.md): word ranking by BM25 instead of
-- ts_rank_cd, and a kill switch for the Search screen's endpoint.
--
-- Measured before this (scripts/benchmark-search.mjs, 10,000 questions): the
-- word stage took 82 ms p50 and 100 ms p95, and ranked the right question
-- first 17% of the time, because every word was matched as a prefix ("item1"
-- matched "item10" to "item1999") and ts_rank_cd ignores how rare a word is.
-- BM25 on exact stemmed words, with prefixes only for the word being typed,
-- ranked it first 98% of the time in 18 ms p50, 26 ms p95.

-- 1. The Search screen can be switched off without a deploy; the Ask check stays on.
INSERT INTO app.feature_flags (name, enabled, note)
VALUES (
  'search', true,
  'POST /search (the Search screen). Off: it refuses with search_off; the Ask check is unaffected.'
)
ON CONFLICT (name) DO NOTHING;

-- 2. What BM25 needs to know about the collection: in how many questions each
-- stemmed word appears, how many questions there are and their total length.
-- Kept exact by triggers, so a new rare word is searchable the moment it is
-- posted. Only the owner-run functions below read or write these tables:
-- app_api has no grants on them at all.
CREATE TABLE IF NOT EXISTS app.search_lexemes (
  -- "C" collation, so LIKE 'impor%' (the word being typed) can use the primary key.
  lexeme text COLLATE "C" PRIMARY KEY,
  docs   integer NOT NULL CHECK (docs >= 0)
);
ALTER TABLE app.search_lexemes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.search_lexemes FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS app.search_corpus (
  only_row     boolean PRIMARY KEY DEFAULT true CHECK (only_row),
  docs         bigint NOT NULL CHECK (docs >= 0),
  -- Sum over questions of their distinct stemmed words (tsvector length).
  total_length bigint NOT NULL CHECK (total_length >= 0)
);
ALTER TABLE app.search_corpus ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.search_corpus FORCE ROW LEVEL SECURITY;

-- Recounts everything from the questions themselves. Used once here, and by the
-- owner after anything that bypasses triggers (a restore, a bulk load with
-- session_replication_role = replica): docs/RUNBOOK.md. Owner only.
CREATE OR REPLACE FUNCTION app.rebuild_search_stats() RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  LOCK TABLE app.search_lexemes, app.search_corpus IN EXCLUSIVE MODE;
  DELETE FROM app.search_lexemes;
  INSERT INTO app.search_lexemes (lexeme, docs) SELECT word, ndoc FROM ts_stat('SELECT search FROM app.questions');
  INSERT INTO app.search_corpus (docs, total_length)
  SELECT count(*), coalesce(sum(length(search)), 0) FROM app.questions
  ON CONFLICT (only_row) DO UPDATE SET docs = excluded.docs, total_length = excluded.total_length;
END
$$;
REVOKE ALL ON FUNCTION app.rebuild_search_stats() FROM PUBLIC;
SELECT app.rebuild_search_stats();

-- Statement-level, with transition tables: an account deletion that removes
-- hundreds of questions updates each word's count once, not once per question.
CREATE OR REPLACE FUNCTION app.count_search_lexemes() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO app.search_lexemes AS l (lexeme, docs)
    SELECT x.lexeme, count(*)::int FROM new_rows n, unnest(tsvector_to_array(n.search)) AS x(lexeme) GROUP BY 1
    ON CONFLICT (lexeme) DO UPDATE SET docs = l.docs + excluded.docs;
    UPDATE app.search_corpus
    SET docs = docs + (SELECT count(*) FROM new_rows),
        total_length = total_length + (SELECT coalesce(sum(length(search)), 0) FROM new_rows);
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE app.search_lexemes l SET docs = l.docs - d.n
    FROM (SELECT x.lexeme, count(*)::int AS n FROM old_rows o, unnest(tsvector_to_array(o.search)) AS x(lexeme) GROUP BY 1) d
    WHERE l.lexeme = d.lexeme;
    UPDATE app.search_corpus
    SET docs = docs - (SELECT count(*) FROM old_rows),
        total_length = total_length - (SELECT coalesce(sum(length(search)), 0) FROM old_rows);
  ELSE
    -- Only rows whose text changed: storing an embedding updates questions too,
    -- and is all app_api may update (title and body are never changed by the API).
    IF NOT EXISTS (SELECT 1 FROM old_rows o JOIN new_rows n ON n.id = o.id WHERE o.search IS DISTINCT FROM n.search) THEN
      RETURN NULL;
    END IF;
    UPDATE app.search_lexemes l SET docs = l.docs - d.n
    FROM (SELECT x.lexeme, count(*)::int AS n
          FROM old_rows o JOIN new_rows nr ON nr.id = o.id AND o.search IS DISTINCT FROM nr.search,
               unnest(tsvector_to_array(o.search)) AS x(lexeme) GROUP BY 1) d
    WHERE l.lexeme = d.lexeme;
    INSERT INTO app.search_lexemes AS l (lexeme, docs)
    SELECT x.lexeme, count(*)::int
    FROM new_rows nr JOIN old_rows o ON o.id = nr.id AND o.search IS DISTINCT FROM nr.search,
         unnest(tsvector_to_array(nr.search)) AS x(lexeme) GROUP BY 1
    ON CONFLICT (lexeme) DO UPDATE SET docs = l.docs + excluded.docs;
    UPDATE app.search_corpus
    SET total_length = total_length
      + (SELECT coalesce(sum(length(nr.search)), 0) - coalesce(sum(length(o.search)), 0)
         FROM old_rows o JOIN new_rows nr ON nr.id = o.id WHERE o.search IS DISTINCT FROM nr.search);
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.count_search_lexemes() FROM PUBLIC;

DROP TRIGGER IF EXISTS count_search_lexemes_insert ON app.questions;
CREATE TRIGGER count_search_lexemes_insert AFTER INSERT ON app.questions
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.count_search_lexemes();
DROP TRIGGER IF EXISTS count_search_lexemes_delete ON app.questions;
CREATE TRIGGER count_search_lexemes_delete AFTER DELETE ON app.questions
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.count_search_lexemes();
DROP TRIGGER IF EXISTS count_search_lexemes_update ON app.questions;
CREATE TRIGGER count_search_lexemes_update AFTER UPDATE ON app.questions
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.count_search_lexemes();

-- 3. BM25 (Robertson & Zaragoza 2009; k1 = 1.2, b = 0.75, Lucene's idf) over
-- the stored tsvector, so words are stemmed and split exactly as the index
-- stores them. Title words count twice (BM25F, Robertson et al. 2004).
-- `query` and `also` (spelling corrections) are matched as whole words;
-- `prefix`, the word still being typed, also matches the 16 most common
-- words it could become. Candidates come from the rarest query words whose
-- questions add up to at most 1,000 (MaxScore's essential lists, Turtle &
-- Flood 1995): commoner words still add to those candidates' scores. Owner-run
-- because row-level security would otherwise force a scan of every question;
-- hidden questions are left out here as row-level security leaves them out.
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
  RETURN QUERY
  WITH c AS MATERIALIZED (
    -- One word common enough to exceed the budget alone: its newest questions.
    SELECT q.id, q.search FROM app.questions q
    WHERE q.search @@ essential_query AND (in_field IS NULL OR q.field = in_field)
    ORDER BY q.id DESC LIMIT budget * 2
  ), w AS (
    SELECT l.lexeme, ln(1 + (n - l.docs + 0.5) / (l.docs + 0.5)) AS idf
    FROM app.search_lexemes l WHERE l.lexeme = ANY (terms) AND l.docs > 0
  )
  SELECT c.id, sum(w.idf * (tf.v * 2.2) / (tf.v + 1.2 * (0.25 + 0.75 * length(c.search) / avg_len)))::float8
  FROM c
  CROSS JOIN LATERAL unnest(c.search) AS u(lexeme, positions, weights)
  JOIN w ON w.lexeme = u.lexeme
  CROSS JOIN LATERAL (SELECT (cardinality(u.weights) + cardinality(array_positions(u.weights, 'A'::text)))::float8 AS v) tf
  WHERE NOT app.is_question_hidden(c.id)
  GROUP BY c.id, c.search
  ORDER BY 2 DESC, 1 DESC
  LIMIT least(greatest(lim, 1), 100);
END
$$;
REVOKE ALL ON FUNCTION app.word_search(text, text[], text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.word_search(text, text[], text, text, integer) TO app_api;

UPDATE app.schema_meta SET version = 35, applied_at = now();
