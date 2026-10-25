-- Search, part 3 (docs/adr/0015-search.md): what learning a better ranking
-- needs, collected only under "improve search for everyone"
-- (search_improvement, migration 0019), and deleted the moment it is turned off.
--
-- For each search: what was searched, the results shown in order with the
-- features each had at that moment (so a model learns from what the ranking
-- actually saw), and which were opened and for how long. Only the Search
-- screen's searches: drafts typed into the Ask check are never recorded here.

CREATE TABLE IF NOT EXISTS app.searches (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- What the client is given: random, so ids say nothing about how many others searched.
  public_id        uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  user_id          uuid NOT NULL REFERENCES app.profiles (id) ON DELETE CASCADE,
  -- The consent version the person accepted, as it stood (set by the trigger below).
  consent_version  integer NOT NULL CHECK (consent_version > 0),
  query            text NOT NULL CHECK (char_length(query) BETWEEN 2 AND 200 AND query !~ '[[:cntrl:]]'),
  field            text CHECK (field ~ '^[a-z]+(-[a-z]+)*$' AND char_length(field) <= 40),
  -- Which ranking produced the order, and which meaning model (null: words only).
  ranker           text NOT NULL CHECK (char_length(ranker) BETWEEN 1 AND 80),
  meaning_model    text CHECK (char_length(meaning_model) <= 80),
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL DEFAULT now() + interval '365 days',
  CHECK (expires_at <= created_at + interval '365 days')
);
CREATE INDEX IF NOT EXISTS searches_user ON app.searches (user_id, created_at);
CREATE INDEX IF NOT EXISTS searches_expiry ON app.searches (expires_at);

CREATE TABLE IF NOT EXISTS app.search_results (
  search_id     bigint NOT NULL REFERENCES app.searches (id) ON DELETE CASCADE,
  position      smallint NOT NULL CHECK (position BETWEEN 1 AND 20),
  question_id   bigint NOT NULL REFERENCES app.questions (id) ON DELETE CASCADE,
  -- Point-in-time features: what the ranking knew when it showed this result.
  word_rank     smallint CHECK (word_rank BETWEEN 1 AND 100),
  meaning_rank  smallint CHECK (meaning_rank BETWEEN 1 AND 100),
  similarity    real CHECK (similarity BETWEEN -1 AND 1),
  every_word    boolean NOT NULL,
  answer_count  integer NOT NULL CHECK (answer_count >= 0),
  -- Days since its last answer, or null if it had none.
  answer_age_days real CHECK (answer_age_days >= 0),
  PRIMARY KEY (search_id, position),
  UNIQUE (search_id, question_id)
);

CREATE TABLE IF NOT EXISTS app.search_opens (
  search_id  bigint NOT NULL,
  position   smallint NOT NULL,
  opened_at  timestamptz NOT NULL DEFAULT now(),
  -- Time on the question once opened, as reported by the page (at most an hour).
  dwell_ms   integer CHECK (dwell_ms BETWEEN 0 AND 3600000),
  PRIMARY KEY (search_id, position),
  FOREIGN KEY (search_id, position) REFERENCES app.search_results (search_id, position) ON DELETE CASCADE
);

ALTER TABLE app.searches ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.searches FORCE ROW LEVEL SECURITY;
ALTER TABLE app.search_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.search_results FORCE ROW LEVEL SECURITY;
ALTER TABLE app.search_opens ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.search_opens FORCE ROW LEVEL SECURITY;
-- Column by column: dates, ids and the consent version are the database's to set.
GRANT SELECT, DELETE ON app.searches, app.search_results, app.search_opens TO app_api;
GRANT INSERT (user_id, consent_version, query, field, ranker, meaning_model) ON app.searches TO app_api;
GRANT INSERT ON app.search_results TO app_api;
GRANT INSERT (search_id, position, dwell_ms), UPDATE (dwell_ms) ON app.search_opens TO app_api;
GRANT USAGE ON SEQUENCE app.searches_id_seq TO app_api;
-- The API writes only these columns of a consent row; no request may move one to another
-- person or purpose (which would also slip past the delete-on-revoke trigger below).
REVOKE UPDATE ON app.user_consent_settings FROM app_api;
GRANT UPDATE (enabled, policy_version, source, updated_at) ON app.user_consent_settings TO app_api;

-- Whether a person has "improve search for everyone" on right now.
CREATE OR REPLACE FUNCTION app.search_improvement_on(person uuid) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.user_consent_settings s
    WHERE s.user_id = person AND s.category = 'search_improvement' AND s.enabled)
$$;
REVOKE ALL ON FUNCTION app.search_improvement_on(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.search_improvement_on(uuid) TO app_api;

-- A person sees and removes their own; the training job reads everyone's and
-- removes what has expired. Writes only by the person, only while it is on.
CREATE POLICY searches_own ON app.searches FOR SELECT TO app_api
  USING (user_id = app.current_user_id() OR app.is_system());
CREATE POLICY searches_own_insert ON app.searches FOR INSERT TO app_api
  WITH CHECK (user_id = app.current_user_id() AND app.search_improvement_on(user_id));
CREATE POLICY searches_own_delete ON app.searches FOR DELETE TO app_api
  USING (user_id = app.current_user_id() OR app.is_system());

CREATE POLICY search_results_own ON app.search_results FOR SELECT TO app_api
  USING (app.is_system() OR EXISTS (
    SELECT 1 FROM app.searches s WHERE s.id = search_id AND s.user_id = app.current_user_id()));
CREATE POLICY search_results_own_insert ON app.search_results FOR INSERT TO app_api
  WITH CHECK (EXISTS (
    SELECT 1 FROM app.searches s
    WHERE s.id = search_id AND s.user_id = app.current_user_id() AND app.search_improvement_on(s.user_id)));
CREATE POLICY search_results_own_delete ON app.search_results FOR DELETE TO app_api
  USING (app.is_system() OR EXISTS (
    SELECT 1 FROM app.searches s WHERE s.id = search_id AND s.user_id = app.current_user_id()));

CREATE POLICY search_opens_own ON app.search_opens FOR SELECT TO app_api
  USING (app.is_system() OR EXISTS (
    SELECT 1 FROM app.searches s WHERE s.id = search_id AND s.user_id = app.current_user_id()));
CREATE POLICY search_opens_own_insert ON app.search_opens FOR INSERT TO app_api
  WITH CHECK (EXISTS (
    SELECT 1 FROM app.searches s
    WHERE s.id = search_id AND s.user_id = app.current_user_id() AND app.search_improvement_on(s.user_id)));
CREATE POLICY search_opens_own_update ON app.search_opens FOR UPDATE TO app_api
  USING (EXISTS (SELECT 1 FROM app.searches s WHERE s.id = search_id AND s.user_id = app.current_user_id()))
  WITH CHECK (EXISTS (
    SELECT 1 FROM app.searches s
    WHERE s.id = search_id AND s.user_id = app.current_user_id() AND app.search_improvement_on(s.user_id)));
CREATE POLICY search_opens_own_delete ON app.search_opens FOR DELETE TO app_api
  USING (app.is_system() OR EXISTS (
    SELECT 1 FROM app.searches s WHERE s.id = search_id AND s.user_id = app.current_user_id()));

-- No row can slip in while the choice is being turned off. Each write first
-- locks the person's consent row (FOR SHARE): a revoke in progress makes it
-- wait, and it then sees the choice off and is refused; a revoke that starts
-- after waits for the write to commit, then deletes it with everything else.
CREATE OR REPLACE FUNCTION app.require_search_improvement() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  person uuid;
  accepted integer;
BEGIN
  IF TG_TABLE_NAME = 'searches' THEN
    person := NEW.user_id;
  ELSE
    SELECT s.user_id INTO person FROM app.searches s WHERE s.id = NEW.search_id;
  END IF;
  SELECT c.policy_version INTO accepted FROM app.user_consent_settings c
  WHERE c.user_id = person AND c.category = 'search_improvement' AND c.enabled
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'search_improvement is off' USING ERRCODE = '42501';
  END IF;
  -- The database's own facts, whatever the writer sent.
  IF TG_TABLE_NAME = 'searches' THEN
    NEW.consent_version := accepted;
    NEW.created_at := now();
    NEW.expires_at := now() + interval '365 days';
  ELSIF TG_TABLE_NAME = 'search_opens' AND TG_OP = 'INSERT' THEN
    NEW.opened_at := now();
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.require_search_improvement() FROM PUBLIC;
DROP TRIGGER IF EXISTS searches_require_consent ON app.searches;
CREATE TRIGGER searches_require_consent BEFORE INSERT ON app.searches
  FOR EACH ROW EXECUTE FUNCTION app.require_search_improvement();
DROP TRIGGER IF EXISTS search_results_require_consent ON app.search_results;
CREATE TRIGGER search_results_require_consent BEFORE INSERT ON app.search_results
  FOR EACH ROW EXECUTE FUNCTION app.require_search_improvement();
DROP TRIGGER IF EXISTS search_opens_require_consent ON app.search_opens;
CREATE TRIGGER search_opens_require_consent BEFORE INSERT OR UPDATE ON app.search_opens
  FOR EACH ROW EXECUTE FUNCTION app.require_search_improvement();

-- Turning it off deletes everything collected under it, at once: whatever
-- the change to the consent row (turned off, deleted, or moved to another
-- person or purpose, which no request can do but the owner could).
CREATE OR REPLACE FUNCTION app.delete_searches_on_revoke() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  -- Nothing can be recorded without an enabled row, so only a row that was the
  -- person's search_improvement row and no longer says yes can leave data behind.
  IF OLD.category = 'search_improvement'
     AND NOT (TG_OP = 'UPDATE' AND NEW.category = 'search_improvement' AND NEW.user_id = OLD.user_id AND NEW.enabled) THEN
    DELETE FROM app.searches WHERE user_id = OLD.user_id;
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.delete_searches_on_revoke() FROM PUBLIC;
DROP TRIGGER IF EXISTS delete_searches_on_revoke ON app.user_consent_settings;
CREATE TRIGGER delete_searches_on_revoke AFTER UPDATE OR DELETE ON app.user_consent_settings
  FOR EACH ROW EXECUTE FUNCTION app.delete_searches_on_revoke();

-- Kept at most 365 days: the hourly job removes what has expired.
CREATE OR REPLACE FUNCTION app.purge_expired_searches() RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE removed bigint;
BEGIN
  DELETE FROM app.searches WHERE expires_at <= clock_timestamp();
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$$;
REVOKE ALL ON FUNCTION app.purge_expired_searches() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_expired_searches() TO app_api;

-- What the consent says now that the tables exist ("deleted as soon as you turn this off").
UPDATE app.consent_categories
SET data_description = 'The searches you make on the Search screen, the results you were shown and their order, which you opened, and time spent on an opened question. Only while this is on; nothing from before. Never drafts typed while asking.'
WHERE name = 'search_improvement';

UPDATE app.schema_meta SET version = 37, applied_at = now();
