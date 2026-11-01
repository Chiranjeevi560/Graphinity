-- Removing an advertising id (deleting an account, or turning personalized ads off) left the rows behind it:
-- a click id a merchant may have logged, the sales a merchant reported with its own customer id, and the
-- reader's country and topic. Billing needs only what was charged, for which campaign, and when.

CREATE OR REPLACE FUNCTION app.ad_identity_scrub() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  DELETE FROM app.ad_conversions c USING app.ad_impressions i
  WHERE c.impression_id = i.id AND i.ad_id = OLD.ad_id;
  UPDATE app.ad_impressions
  SET click_id = NULL, country = NULL, field = NULL, audience_id = NULL
  WHERE ad_id = OLD.ad_id;
  RETURN OLD;
END
$$;
REVOKE ALL ON FUNCTION app.ad_identity_scrub() FROM PUBLIC;
DROP TRIGGER IF EXISTS ad_identity_scrub ON app.ad_identities;
-- BEFORE: the foreign key's SET NULL would otherwise erase which rows were this person's.
CREATE TRIGGER ad_identity_scrub BEFORE DELETE ON app.ad_identities
  FOR EACH ROW EXECUTE FUNCTION app.ad_identity_scrub();

-- The person's own advertising rows, for their data export. The API can't read these tables per person.
CREATE OR REPLACE FUNCTION app.my_ad_activity() RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'shown', coalesce((
      SELECT jsonb_agg(jsonb_build_object('advertiser', a.name, 'placement', m.placement, 'field', m.field,
               'country', m.country, 'shownAt', m.shown_at, 'clickedAt', m.clicked_at) ORDER BY m.id)
      FROM app.ad_impressions m JOIN app.ad_campaigns c ON c.id = m.campaign_id
      JOIN app.ad_advertisers a ON a.id = c.advertiser_id
      WHERE m.ad_id = d.ad_id), '[]'::jsonb),
    'heldBack', coalesce((
      SELECT jsonb_agg(jsonb_build_object('advertiser', a.name, 'at', g.shown_at) ORDER BY g.id)
      FROM app.ad_ghost_impressions g JOIN app.ad_campaigns c ON c.id = g.campaign_id
      JOIN app.ad_advertisers a ON a.id = c.advertiser_id
      WHERE g.ad_id = d.ad_id), '[]'::jsonb),
    'partnerEvents', coalesce((
      SELECT jsonb_agg(jsonb_build_object('advertiser', a.name, 'kind', e.kind, 'product', e.product_key,
               'field', e.field, 'valueMicros', e.value_micros, 'at', e.occurred_at) ORDER BY e.id)
      FROM app.ad_partner_events e JOIN app.ad_advertisers a ON a.id = e.advertiser_id
      WHERE e.ad_id = d.ad_id), '[]'::jsonb),
    'reportedSales', coalesce((
      SELECT jsonb_agg(jsonb_build_object('advertiser', a.name, 'valueMicros', s.value_micros, 'at', s.converted_at) ORDER BY s.id)
      FROM app.ad_conversions s JOIN app.ad_impressions m ON m.id = s.impression_id
      JOIN app.ad_advertisers a ON a.id = s.advertiser_id
      WHERE m.ad_id = d.ad_id), '[]'::jsonb))
  FROM app.ad_identities d WHERE d.profile_id = app.current_user_id()
$$;
REVOKE ALL ON FUNCTION app.my_ad_activity() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_ad_activity() TO app_api;

UPDATE app.schema_meta SET version = 68, applied_at = now();
