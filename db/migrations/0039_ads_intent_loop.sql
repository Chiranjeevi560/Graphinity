-- The rest of advertising part 9 (docs/adr/0022-advertising-platform.md): rotating
-- ids a partner may hand back, partner product events, ghost impressions for
-- randomized holdouts, budget pacing state, and audiences a partner matches.
-- Everything hangs off ad_id, so rotating or withdrawing removes it in one transaction.

INSERT INTO app.feature_flags (name, enabled, note) VALUES
  ('ads_holdout', false, 'Randomized holdouts with ghost impressions: measures what ads add (ADR 0022 part 9b).'),
  ('ads_pacing', false, 'Primal-dual budget pacing instead of the on/off rule (ADR 0022).')
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS app.ad_eids (
  eid        text PRIMARY KEY CHECK (eid ~ '^[A-Za-z0-9_-]{22}$'),
  ad_id      uuid NOT NULL REFERENCES app.ad_identities (ad_id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ad_eids_identity ON app.ad_eids (ad_id);
CREATE INDEX IF NOT EXISTS ad_eids_expiry ON app.ad_eids (expires_at);

CREATE TABLE IF NOT EXISTS app.ad_partner_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  advertiser_id bigint NOT NULL REFERENCES app.ad_advertisers (id) ON DELETE CASCADE,
  ad_id         uuid NOT NULL REFERENCES app.ad_identities (ad_id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('PRODUCT_SEARCH', 'PRODUCT_VIEW', 'ADD_TO_CART', 'PURCHASE')),
  product_key   text CHECK (product_key ~ '^[a-z0-9-]{1,80}$'),
  field         text REFERENCES app.fields (slug) ON DELETE SET NULL,
  external_id   text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 100 AND external_id !~ '[[:cntrl:]]'),
  value_micros  bigint NOT NULL DEFAULT 0 CHECK (value_micros >= 0 AND value_micros <= 1000000000000),
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (advertiser_id, external_id)
);
CREATE INDEX IF NOT EXISTS ad_partner_events_identity ON app.ad_partner_events (ad_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ad_partner_events_time ON app.ad_partner_events (occurred_at);

CREATE TABLE IF NOT EXISTS app.ad_ghost_impressions (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign_id           bigint NOT NULL REFERENCES app.ad_campaigns (id) ON DELETE CASCADE,
  ad_id                 uuid NOT NULL REFERENCES app.ad_identities (ad_id) ON DELETE CASCADE,
  counterfactual_micros bigint NOT NULL CHECK (counterfactual_micros >= 0),
  shown_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ad_ghost_campaign ON app.ad_ghost_impressions (campaign_id, shown_at);
CREATE INDEX IF NOT EXISTS ad_ghost_identity ON app.ad_ghost_impressions (ad_id);

CREATE TABLE IF NOT EXISTS app.ad_pacing (
  campaign_id bigint PRIMARY KEY REFERENCES app.ad_campaigns (id) ON DELETE CASCADE,
  lambda      double precision NOT NULL DEFAULT 0 CHECK (lambda >= 0),
  integral    double precision NOT NULL DEFAULT 0,
  last_error  double precision NOT NULL DEFAULT 0,
  day         date NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app.ad_audiences DROP CONSTRAINT IF EXISTS ad_audiences_kind_check;
ALTER TABLE app.ad_audiences ADD CONSTRAINT ad_audiences_kind_check
  CHECK (kind IN ('segment', 'retargeting', 'lookalike', 'partner_match'));

ALTER TABLE app.ad_eids ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ad_eids FORCE ROW LEVEL SECURITY;
ALTER TABLE app.ad_partner_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ad_partner_events FORCE ROW LEVEL SECURITY;
ALTER TABLE app.ad_ghost_impressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ad_ghost_impressions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.ad_pacing ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ad_pacing FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON app.ad_eids TO app_api;
GRANT SELECT, DELETE ON app.ad_partner_events TO app_api;
GRANT SELECT, INSERT (campaign_id, ad_id, counterfactual_micros), DELETE ON app.ad_ghost_impressions TO app_api;
GRANT SELECT, INSERT, UPDATE ON app.ad_pacing TO app_api;
DROP POLICY IF EXISTS ad_eids_system ON app.ad_eids;
CREATE POLICY ad_eids_system ON app.ad_eids FOR ALL TO app_api USING (app.is_system()) WITH CHECK (app.is_system());
DROP POLICY IF EXISTS ad_partner_events_system ON app.ad_partner_events;
CREATE POLICY ad_partner_events_system ON app.ad_partner_events FOR ALL TO app_api USING (app.is_system()) WITH CHECK (app.is_system());
DROP POLICY IF EXISTS ad_ghost_system ON app.ad_ghost_impressions;
CREATE POLICY ad_ghost_system ON app.ad_ghost_impressions FOR ALL TO app_api USING (app.is_system()) WITH CHECK (app.is_system());
DROP POLICY IF EXISTS ad_pacing_system ON app.ad_pacing;
CREATE POLICY ad_pacing_system ON app.ad_pacing FOR ALL TO app_api USING (app.is_system()) WITH CHECK (app.is_system());

-- A partner's product event, with its API key, about a rotating id it was handed. Counted only
-- while the switches are on and the person allows partner sites now. Every refusal reads the
-- same, so neither keys nor ids can be probed.
CREATE OR REPLACE FUNCTION app.record_partner_event(
  in_key_hash text, in_eid text, in_kind text, in_product text, in_field text, in_external text, in_value bigint)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  advertiser bigint;
  subject uuid;
  added bigint;
BEGIN
  IF NOT (app.flag_on('ads') AND app.flag_on('ads_partner_sites')) THEN RETURN 'unknown'; END IF;
  SELECT k.advertiser_id INTO advertiser FROM app.ad_api_keys k WHERE k.key_hash = in_key_hash AND k.revoked_at IS NULL;
  IF advertiser IS NULL THEN RETURN 'unknown'; END IF;
  SELECT e.ad_id INTO subject FROM app.ad_eids e JOIN app.ad_identities i ON i.ad_id = e.ad_id
  WHERE e.eid = in_eid AND e.expires_at > clock_timestamp() AND app.ads_permitted(i.profile_id, 'ads_partner_sites');
  IF subject IS NULL THEN RETURN 'unknown'; END IF;
  INSERT INTO app.ad_partner_events (advertiser_id, ad_id, kind, product_key, field, external_id, value_micros)
  VALUES (advertiser, subject, in_kind, in_product,
          (SELECT slug FROM app.fields WHERE slug = in_field), in_external, coalesce(in_value, 0))
  ON CONFLICT (advertiser_id, external_id) DO NOTHING
  RETURNING id INTO added;
  RETURN CASE WHEN added IS NULL THEN 'already' ELSE 'recorded' END;
END
$$;
REVOKE ALL ON FUNCTION app.record_partner_event(text, text, text, text, text, text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_partner_event(text, text, text, text, text, text, bigint) TO app_api;

-- A partner's blinded tokens intersected with rotating ids: under 100 matches, nothing is
-- stored and the partner learns only 'insufficient', so it can't test one person's presence.
CREATE OR REPLACE FUNCTION app.match_partner_audience(in_key_hash text, in_name text, in_eids text[])
  RETURNS TABLE (public_id uuid, status text, size integer)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  advertiser bigint;
  matched uuid[];
  created app.ad_audiences;
BEGIN
  IF NOT (app.flag_on('ads') AND app.flag_on('ads_partner_sites') AND app.flag_on('ads_audiences')) THEN RETURN; END IF;
  SELECT k.advertiser_id INTO advertiser FROM app.ad_api_keys k WHERE k.key_hash = in_key_hash AND k.revoked_at IS NULL;
  IF advertiser IS NULL THEN RETURN; END IF;
  SELECT array_agg(DISTINCT e.ad_id) INTO matched
  FROM app.ad_eids e JOIN app.ad_identities i ON i.ad_id = e.ad_id
  WHERE e.eid = ANY (in_eids) AND e.expires_at > clock_timestamp()
    AND app.ads_permitted(i.profile_id, 'ads_partner_sites')
    AND app.ads_permitted(i.profile_id, 'ads_personalization');
  IF coalesce(array_length(matched, 1), 0) < 100 THEN
    RETURN QUERY SELECT NULL::uuid, 'insufficient'::text, 0;
    RETURN;
  END IF;
  INSERT INTO app.ad_audiences (advertiser_id, name, kind, status, size, built_at)
  VALUES (advertiser, in_name, 'partner_match', 'ready', array_length(matched, 1), clock_timestamp())
  RETURNING * INTO created;
  INSERT INTO app.ad_audience_members (audience_id, ad_id, event_at)
  SELECT created.id, m, clock_timestamp() FROM unnest(matched) AS m;
  RETURN QUERY SELECT created.public_id, 'ready'::text, (array_length(matched, 1) / 100) * 100;
END
$$;
REVOKE ALL ON FUNCTION app.match_partner_audience(text, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.match_partner_audience(text, text, text[]) TO app_api;

-- Partner events 180 days (ADR 0022), ids once expired, ghosts 13 months like impressions.
CREATE OR REPLACE FUNCTION app.expire_ad_signals() RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  n bigint := 0;
  c bigint;
BEGIN
  IF NOT app.is_system() THEN
    RAISE EXCEPTION 'only the server expires these' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM app.ad_partner_events WHERE occurred_at < clock_timestamp() - interval '180 days';
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;
  DELETE FROM app.ad_eids WHERE expires_at < clock_timestamp();
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;
  DELETE FROM app.ad_ghost_impressions WHERE shown_at < clock_timestamp() - interval '13 months';
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION app.expire_ad_signals() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.expire_ad_signals() TO app_api;

UPDATE app.schema_meta SET version = 54, applied_at = now();
