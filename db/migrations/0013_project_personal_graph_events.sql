-- Incrementally project consented question interactions into the owner's
-- temporal graph. Evidence stays linked to the expiring source event.
ALTER TABLE app.personal_signal_events
  ADD COLUMN projected_at timestamptz;

CREATE INDEX personal_signal_events_projection_queue_idx
  ON app.personal_signal_events(id)
  WHERE projected_at IS NULL;

CREATE UNIQUE INDEX personal_graph_nodes_generated_key_idx
  ON app.personal_graph_nodes(user_id, consent_category, entity_type, label)
  WHERE source = 'graphinity_generated';

ALTER TABLE app.personal_graph_edges
  ADD COLUMN evidence_signal_id bigint REFERENCES app.personal_signal_events(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX personal_graph_edges_evidence_idx
  ON app.personal_graph_edges(evidence_signal_id)
  WHERE evidence_signal_id IS NOT NULL;
CREATE INDEX personal_graph_edges_temporal_idx
  ON app.personal_graph_edges(user_id, consent_category, freshness DESC);

-- Poisoned numeric identifiers must not make a whole SKIP LOCKED batch retry
-- forever. Return NULL for anything outside positive bigint range.
CREATE OR REPLACE FUNCTION app.personal_graph_question_id(value text)
RETURNS bigint
LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF value !~ '^[0-9]{1,19}$' THEN RETURN NULL; END IF;
  IF value::numeric < 1 OR value::numeric > 9223372036854775807 THEN RETURN NULL; END IF;
  RETURN value::bigint;
END
$$;
REVOKE ALL ON FUNCTION app.personal_graph_question_id(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.personal_graph_question_id(text) TO app_api;

-- The API role can invoke only this bounded projection operation. SECURITY
-- DEFINER is required because interaction events are written in a user-scoped
-- transaction and the worker must atomically claim work across users.
CREATE OR REPLACE FUNCTION app.project_personal_graph_events(batch_size integer DEFAULT 100)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  event_row app.personal_signal_events%ROWTYPE;
  question_key text;
  question_field text;
  question_node uuid;
  topic_node uuid;
  projected integer := 0;
BEGIN
  IF NOT app.is_system() THEN
    RAISE EXCEPTION 'system transaction required' USING ERRCODE = '42501';
  END IF;
  IF batch_size < 1 OR batch_size > 500 THEN
    RAISE EXCEPTION 'batch size must be between 1 and 500' USING ERRCODE = '22023';
  END IF;

  FOR event_row IN
    SELECT * FROM app.personal_signal_events
    WHERE projected_at IS NULL
    ORDER BY id
    LIMIT batch_size
    FOR UPDATE SKIP LOCKED
  LOOP
    -- Re-check consent at processing time. Revocation before processing means
    -- the queued event is acknowledged without adding a graph projection.
    IF event_row.expires_at > clock_timestamp()
       AND event_row.consent_category IN ('reading_history', 'interaction_history')
       AND EXISTS (
         SELECT 1 FROM app.user_consent_settings s
         WHERE s.user_id = event_row.user_id
           AND s.category = event_row.consent_category AND s.enabled
       ) THEN
      question_key := NULL;
      question_field := NULL;

      IF event_row.signal_type IN ('question_asked', 'question_viewed', 'answer_selected')
         AND app.personal_graph_question_id(event_row.subject_id) IS NOT NULL THEN
        SELECT q.id::text, q.field INTO question_key, question_field
        FROM app.questions q WHERE q.id = app.personal_graph_question_id(event_row.subject_id);
      ELSIF event_row.signal_type IN ('answer_written', 'answer_marked_helpful')
         AND app.personal_graph_question_id(event_row.subject_id) IS NOT NULL THEN
        SELECT q.id::text, q.field INTO question_key, question_field
        FROM app.answers a JOIN app.questions q ON q.id = a.question_id
        WHERE a.id = app.personal_graph_question_id(event_row.subject_id);
      END IF;

      IF question_key IS NOT NULL AND question_field IS NOT NULL THEN
        INSERT INTO app.personal_graph_nodes
          (user_id, consent_category, entity_type, label, attributes, source)
        VALUES
          (event_row.user_id, event_row.consent_category, 'topic', question_field, '{}'::jsonb, 'graphinity_generated')
        ON CONFLICT (user_id, consent_category, entity_type, label)
          WHERE source = 'graphinity_generated'
        DO UPDATE SET updated_at = app.personal_graph_nodes.updated_at
        RETURNING id INTO topic_node;

        INSERT INTO app.personal_graph_nodes
          (user_id, consent_category, entity_type, label, attributes, source)
        VALUES
          (event_row.user_id, event_row.consent_category, 'question', 'question:' || question_key, '{}'::jsonb, 'graphinity_generated')
        ON CONFLICT (user_id, consent_category, entity_type, label)
          WHERE source = 'graphinity_generated'
        DO UPDATE SET updated_at = app.personal_graph_nodes.updated_at
        RETURNING id INTO question_node;

        INSERT INTO app.personal_graph_edges
          (user_id, consent_category, source_node, target_node, relation, weight, confidence, freshness, evidence_signal_id)
        VALUES
          (event_row.user_id, event_row.consent_category, topic_node, question_node,
           event_row.signal_type, 1, 1, event_row.occurred_at, event_row.id)
        ON CONFLICT (evidence_signal_id) WHERE evidence_signal_id IS NOT NULL DO NOTHING;
      END IF;
    END IF;

    UPDATE app.personal_signal_events SET projected_at = clock_timestamp()
    WHERE id = event_row.id;
    projected := projected + 1;
  END LOOP;
  RETURN projected;
END
$$;
REVOKE ALL ON FUNCTION app.project_personal_graph_events(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.project_personal_graph_events(integer) TO app_api;

UPDATE app.schema_meta SET version = 28, applied_at = now();
