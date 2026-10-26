-- The welcome consent screen (docs/adr/0023-consent-welcome.md): which
-- optional purposes to put to a person. A purpose is put to them only when
-- it is offered at all (app.consent_offered: advertising only while it is on)
-- and, for an advertising purpose, only where their country's rule is
-- approved by a lawyer and doesn't prohibit it. "Accept all" turns on
-- exactly these, so it can never switch on something the law where they
-- live doesn't allow.
CREATE OR REPLACE FUNCTION app.consent_offered_for(person uuid, category text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT app.consent_offered(category) AND (
    category NOT LIKE 'ads\_%' OR coalesce((
      SELECT r.legal_approved AND r.basis <> 'prohibited'
      FROM app.ad_jurisdiction_rules r JOIN app.profiles p ON p.id = person
      WHERE r.purpose = category AND (r.country = p.country OR r.country IS NULL)
      ORDER BY r.country IS NULL LIMIT 1), false))
$$;
REVOKE ALL ON FUNCTION app.consent_offered_for(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.consent_offered_for(uuid, text) TO app_api;

-- The same rule in the database: turning a purpose on is refused where it isn't
-- put to that person (replaces 0029's version, which checked only the switch).
CREATE OR REPLACE FUNCTION app.guard_offered_consent() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.enabled AND NOT app.consent_offered_for(NEW.user_id, NEW.category) THEN
    RAISE EXCEPTION 'this purpose is not offered' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_offered_consent() FROM PUBLIC;

UPDATE app.schema_meta SET version = 50, applied_at = now();
