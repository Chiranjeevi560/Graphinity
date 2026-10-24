-- User-owned first-party knowledge graph. Every item names the consent
-- category that governs its use. Reads remain available to the owner for
-- inspection and deletion after revocation; writes require active consent.

CREATE TABLE IF NOT EXISTS app.personal_graph_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app.profiles(id) ON DELETE CASCADE,
  consent_category text NOT NULL REFERENCES app.consent_categories(name) ON DELETE RESTRICT,
  entity_type text NOT NULL CHECK (entity_type ~ '^[a-z][a-z0-9_]{0,39}$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 240),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(attributes) <= 8192),
  source text NOT NULL CHECK (source IN ('user_entered', 'user_imported', 'graphinity_generated')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
) WITH (fillfactor = 80);
CREATE INDEX IF NOT EXISTS personal_graph_nodes_user_category_idx
  ON app.personal_graph_nodes(user_id, consent_category, entity_type);
ALTER TABLE app.personal_graph_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.personal_graph_nodes FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON app.personal_graph_nodes TO app_api;
CREATE POLICY personal_graph_nodes_read_self ON app.personal_graph_nodes FOR SELECT TO app_api
  USING (user_id = app.current_user_id());
CREATE POLICY personal_graph_nodes_create_consented ON app.personal_graph_nodes FOR INSERT TO app_api
  WITH CHECK (
    user_id = app.current_user_id() AND (
      EXISTS (SELECT 1 FROM app.consent_categories c WHERE c.name = consent_category AND c.required_for_service)
      OR EXISTS (SELECT 1 FROM app.user_consent_settings s
                 WHERE s.user_id = app.current_user_id() AND s.category = consent_category AND s.enabled)
    )
  );
CREATE POLICY personal_graph_nodes_delete_self ON app.personal_graph_nodes FOR DELETE TO app_api
  USING (user_id = app.current_user_id());

CREATE TABLE IF NOT EXISTS app.personal_graph_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app.profiles(id) ON DELETE CASCADE,
  consent_category text NOT NULL REFERENCES app.consent_categories(name) ON DELETE RESTRICT,
  source_node uuid NOT NULL,
  target_node uuid NOT NULL,
  relation text NOT NULL CHECK (relation ~ '^[a-z][a-z0-9_]{0,39}$'),
  weight real NOT NULL DEFAULT 1 CHECK (weight BETWEEN 0 AND 1),
  confidence real NOT NULL DEFAULT 1 CHECK (confidence BETWEEN 0 AND 1),
  freshness timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (source_node, user_id) REFERENCES app.personal_graph_nodes(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (target_node, user_id) REFERENCES app.personal_graph_nodes(id, user_id) ON DELETE CASCADE,
  CHECK (source_node <> target_node)
) WITH (fillfactor = 80);
CREATE INDEX IF NOT EXISTS personal_graph_edges_user_idx ON app.personal_graph_edges(user_id, consent_category);
CREATE INDEX IF NOT EXISTS personal_graph_edges_source_idx ON app.personal_graph_edges(source_node);
CREATE INDEX IF NOT EXISTS personal_graph_edges_target_idx ON app.personal_graph_edges(target_node);
ALTER TABLE app.personal_graph_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.personal_graph_edges FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON app.personal_graph_edges TO app_api;
CREATE POLICY personal_graph_edges_read_self ON app.personal_graph_edges FOR SELECT TO app_api
  USING (user_id = app.current_user_id());
CREATE POLICY personal_graph_edges_create_consented ON app.personal_graph_edges FOR INSERT TO app_api
  WITH CHECK (
    user_id = app.current_user_id() AND
    EXISTS (SELECT 1 FROM app.user_consent_settings s
            WHERE s.user_id = app.current_user_id() AND s.category = consent_category AND s.enabled)
  );
CREATE POLICY personal_graph_edges_delete_self ON app.personal_graph_edges FOR DELETE TO app_api
  USING (user_id = app.current_user_id());

CREATE TABLE IF NOT EXISTS app.personal_signal_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app.profiles(id) ON DELETE CASCADE,
  consent_category text NOT NULL REFERENCES app.consent_categories(name) ON DELETE RESTRICT,
  signal_type text NOT NULL CHECK (signal_type ~ '^[a-z][a-z0-9_]{0,39}$'),
  subject_id text CHECK (subject_id IS NULL OR char_length(subject_id) <= 120),
  value jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(value) <= 4096),
  source text NOT NULL CHECK (source IN ('user_action', 'user_import', 'graphinity_generated')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '365 days'),
  CHECK (expires_at > occurred_at)
) WITH (fillfactor = 80);
CREATE INDEX IF NOT EXISTS personal_signal_events_user_category_time_idx
  ON app.personal_signal_events(user_id, consent_category, occurred_at DESC);
CREATE INDEX IF NOT EXISTS personal_signal_events_expiry_idx ON app.personal_signal_events(expires_at);
ALTER TABLE app.personal_signal_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.personal_signal_events FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON app.personal_signal_events TO app_api;
CREATE POLICY personal_signal_events_read_self ON app.personal_signal_events FOR SELECT TO app_api
  USING (user_id = app.current_user_id());
CREATE POLICY personal_signal_events_create_consented ON app.personal_signal_events FOR INSERT TO app_api
  WITH CHECK (
    user_id = app.current_user_id() AND
    EXISTS (SELECT 1 FROM app.user_consent_settings s
            WHERE s.user_id = app.current_user_id() AND s.category = consent_category AND s.enabled)
  );
CREATE POLICY personal_signal_events_delete_self ON app.personal_signal_events FOR DELETE TO app_api
  USING (user_id = app.current_user_id());

-- Hourly maintenance job uses this narrow definer function to honor the
-- 365-day default, without granting a broad system-deletion path to requests.
CREATE OR REPLACE FUNCTION app.purge_expired_personal_signals() RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE removed bigint;
BEGIN
  DELETE FROM app.personal_signal_events WHERE expires_at <= clock_timestamp();
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$$;
REVOKE ALL ON FUNCTION app.purge_expired_personal_signals() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_expired_personal_signals() TO app_api;

CREATE TABLE IF NOT EXISTS app.personal_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app.profiles(id) ON DELETE CASCADE,
  consent_category text NOT NULL DEFAULT 'interaction_history' REFERENCES app.consent_categories(name) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
) WITH (fillfactor = 80);
CREATE INDEX IF NOT EXISTS personal_collections_user_idx ON app.personal_collections(user_id, created_at);
ALTER TABLE app.personal_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.personal_collections FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.personal_collections TO app_api;
CREATE POLICY personal_collections_self ON app.personal_collections FOR ALL TO app_api
  USING (user_id = app.current_user_id()) WITH CHECK (
    user_id = app.current_user_id() AND EXISTS (
      SELECT 1 FROM app.user_consent_settings s
      WHERE s.user_id = app.current_user_id() AND s.category = consent_category AND s.enabled
    )
  );

UPDATE app.schema_meta SET version = 19, applied_at = now();
