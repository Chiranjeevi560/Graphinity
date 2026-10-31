-- The owner's role, and the knowledge graphs (master charter §4). Owners are added only in the
-- SQL editor. Graph nodes are topics and products, never people: time travel is safe to keep.

CREATE TABLE IF NOT EXISTS app.platform_owners (
  profile_id uuid PRIMARY KEY REFERENCES app.profiles (id) ON DELETE CASCADE,
  added_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.platform_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.platform_owners FORCE ROW LEVEL SECURITY;
GRANT SELECT ON app.platform_owners TO app_api;
DROP POLICY IF EXISTS platform_owners_self ON app.platform_owners;
CREATE POLICY platform_owners_self ON app.platform_owners FOR SELECT TO app_api
  USING (app.is_system() OR profile_id = app.current_user_id());

CREATE OR REPLACE FUNCTION app.is_owner() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$ SELECT EXISTS (SELECT 1 FROM app.platform_owners WHERE profile_id = app.current_user_id()) $$;
REVOKE ALL ON FUNCTION app.is_owner() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_owner() TO app_api;

CREATE TABLE IF NOT EXISTS app.kg_nodes (
  id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('field', 'product', 'brand')),
  key  text NOT NULL CHECK (key ~ '^[a-z0-9-]{1,80}$'),
  UNIQUE (kind, key)
);

CREATE TABLE IF NOT EXISTS app.kg_bitemporal_edges (
  edge_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_node_id bigint NOT NULL REFERENCES app.kg_nodes (id) ON DELETE CASCADE,
  target_node_id bigint NOT NULL REFERENCES app.kg_nodes (id) ON DELETE CASCADE,
  relation_type  text NOT NULL CHECK (relation_type ~ '^[a-z_]{1,40}$'),
  weight         real NOT NULL CHECK (weight BETWEEN -1.0 AND 1.0),
  confidence     real NOT NULL CHECK (confidence BETWEEN 0.0 AND 1.0),
  valid_from     timestamptz NOT NULL,
  valid_to       timestamptz NOT NULL DEFAULT 'infinity',
  tx_from        timestamptz NOT NULL DEFAULT clock_timestamp(),
  tx_to          timestamptz NOT NULL DEFAULT 'infinity',
  CHECK (valid_from < valid_to),
  CHECK (tx_from <= tx_to)
);
CREATE INDEX IF NOT EXISTS idx_kg_bitemporal_lookup ON app.kg_bitemporal_edges (source_node_id, relation_type, valid_from DESC, tx_from DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_kg_bitemporal_active ON app.kg_bitemporal_edges (source_node_id, target_node_id, relation_type) WHERE tx_to = 'infinity' AND valid_to = 'infinity';

-- History can't be rewritten: the only change ever allowed is closing tx_to, once.
CREATE OR REPLACE FUNCTION app.guard_kg_edge() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.tx_to <> 'infinity' OR NEW.tx_to = 'infinity'
     OR (to_jsonb(NEW) - 'tx_to') IS DISTINCT FROM (to_jsonb(OLD) - 'tx_to') THEN
    RAISE EXCEPTION 'edge history can''t be rewritten' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_kg_edge() FROM PUBLIC;
DROP TRIGGER IF EXISTS kg_edges_guard ON app.kg_bitemporal_edges;
CREATE TRIGGER kg_edges_guard BEFORE UPDATE ON app.kg_bitemporal_edges
  FOR EACH ROW EXECUTE FUNCTION app.guard_kg_edge();

-- A new belief: closes what was believed and records it, keeping the old row and adding a corrected
-- one for the period before valid_from.
CREATE OR REPLACE FUNCTION app.kg_assert(
  in_source bigint, in_target bigint, in_relation text, in_weight real, in_confidence real, in_valid_from timestamptz)
  RETURNS bigint
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  old app.kg_bitemporal_edges;
  now_tx timestamptz := clock_timestamp();
  id bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('kg'), hashtext(in_source::text || ':' || in_target::text || ':' || in_relation));
  SELECT * INTO old FROM app.kg_bitemporal_edges e
  WHERE e.source_node_id = in_source AND e.target_node_id = in_target AND e.relation_type = in_relation
    AND e.tx_to = 'infinity' AND e.valid_to = 'infinity';
  IF FOUND THEN
    UPDATE app.kg_bitemporal_edges SET tx_to = now_tx WHERE edge_id = old.edge_id;
    IF old.valid_from < in_valid_from THEN
      INSERT INTO app.kg_bitemporal_edges (source_node_id, target_node_id, relation_type, weight, confidence, valid_from, valid_to, tx_from)
      VALUES (in_source, in_target, in_relation, old.weight, old.confidence, old.valid_from, in_valid_from, now_tx);
    END IF;
  END IF;
  INSERT INTO app.kg_bitemporal_edges (source_node_id, target_node_id, relation_type, weight, confidence, valid_from, tx_from)
  VALUES (in_source, in_target, in_relation, in_weight, in_confidence, in_valid_from, now_tx)
  RETURNING edge_id INTO id;
  RETURN id;
END
$$;

CREATE TABLE IF NOT EXISTS app.kg_session_transitions (
  from_key  text NOT NULL CHECK (from_key ~ '^[a-z0-9-]{1,80}$'),
  to_key    text NOT NULL CHECK (to_key ~ '^[a-z0-9-]{1,80}$'),
  prior_key text NOT NULL DEFAULT '' CHECK (prior_key ~ '^[a-z0-9-]{0,80}$'),
  decayed_transition_count real NOT NULL DEFAULT 1.0 CHECK (decayed_transition_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_key, to_key, prior_key),
  CHECK (from_key <> to_key)
);

CREATE TABLE IF NOT EXISTS app.kg_node_embeddings (
  node_id    bigint PRIMARY KEY REFERENCES app.kg_nodes (id) ON DELETE CASCADE,
  embedding  real[] NOT NULL CHECK (cardinality(embedding) = 64),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app.kg_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.kg_nodes FORCE ROW LEVEL SECURITY;
ALTER TABLE app.kg_bitemporal_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.kg_bitemporal_edges FORCE ROW LEVEL SECURITY;
ALTER TABLE app.kg_session_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.kg_session_transitions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.kg_node_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.kg_node_embeddings FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON app.kg_nodes TO app_api;
GRANT SELECT, INSERT ON app.kg_bitemporal_edges TO app_api;
GRANT UPDATE (tx_to) ON app.kg_bitemporal_edges TO app_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.kg_session_transitions TO app_api;
GRANT SELECT, INSERT, UPDATE ON app.kg_node_embeddings TO app_api;
REVOKE ALL ON FUNCTION app.kg_assert(bigint, bigint, text, real, real, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.kg_assert(bigint, bigint, text, real, real, timestamptz) TO app_api;
DROP POLICY IF EXISTS kg_nodes_system ON app.kg_nodes;
CREATE POLICY kg_nodes_system ON app.kg_nodes FOR ALL TO app_api USING (app.is_system()) WITH CHECK (app.is_system());
DROP POLICY IF EXISTS kg_edges_system ON app.kg_bitemporal_edges;
CREATE POLICY kg_edges_system ON app.kg_bitemporal_edges FOR ALL TO app_api USING (app.is_system()) WITH CHECK (app.is_system());
DROP POLICY IF EXISTS kg_session_system ON app.kg_session_transitions;
CREATE POLICY kg_session_system ON app.kg_session_transitions FOR ALL TO app_api USING (app.is_system()) WITH CHECK (app.is_system());
DROP POLICY IF EXISTS kg_embeddings_system ON app.kg_node_embeddings;
CREATE POLICY kg_embeddings_system ON app.kg_node_embeddings FOR ALL TO app_api USING (app.is_system()) WITH CHECK (app.is_system());

UPDATE app.schema_meta SET version = 55, applied_at = now();
