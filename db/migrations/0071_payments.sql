-- Payments (ADR 0034): a Razorpay payment link per payment, paid on Razorpay's own page, and believed only when
-- Razorpay's signed webhook says so. Two purposes for now: an advertiser's prepaid ad credit, and an organization's
-- enterprise analytics plan. Off by default; nothing here charges anyone until the owner has a Razorpay account,
-- sets its keys and turns `payments` on.
INSERT INTO app.feature_flags (name, enabled, note) VALUES
  ('payments', false, 'Payment links through Razorpay for ad credit and enterprise plans')
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS app.payments (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Also Razorpay's reference_id (at most 40 characters there): the link between the two records.
  public_id           uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  purpose             text NOT NULL CHECK (purpose IN ('ad_credit', 'enterprise')),
  -- Financial records outlive an account (tax law), so a deleted advertiser or organization leaves the payment
  -- with no link to it rather than deleting it; the person who asked is unlinked the same way.
  advertiser_id       bigint REFERENCES app.ad_advertisers (id) ON DELETE SET NULL,
  org_id              bigint REFERENCES app.enterprise_orgs (id) ON DELETE SET NULL,
  CHECK (purpose = 'ad_credit' OR advertiser_id IS NULL),
  CHECK (purpose = 'enterprise' OR org_id IS NULL),
  -- ₹100 to ₹1,00,000, in paise: Razorpay's minimum is ₹1, ours keeps fees from eating small payments.
  amount_paise        integer NOT NULL CHECK (amount_paise BETWEEN 10000 AND 10000000),
  currency            text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  status              text NOT NULL DEFAULT 'creating'
                      CHECK (status IN ('creating', 'created', 'partially_paid', 'paid', 'expired', 'cancelled', 'failed')),
  provider            text NOT NULL DEFAULT 'razorpay' CHECK (provider = 'razorpay'),
  provider_link_id    text UNIQUE CHECK (provider_link_id ~ '^plink_[A-Za-z0-9]{1,40}$'),
  link_url            text CHECK (char_length(link_url) <= 200 AND link_url ~ '^https://([a-z0-9-]+\.)*(rzp\.io|razorpay\.com)/'),
  amount_paid_paise   integer NOT NULL DEFAULT 0 CHECK (amount_paid_paise >= 0 AND amount_paid_paise <= amount_paise),
  provider_payment_id text CHECK (provider_payment_id ~ '^pay_[A-Za-z0-9]{1,40}$'),
  created_by          uuid REFERENCES app.profiles (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  paid_at             timestamptz,
  CHECK ((status = 'paid') = (paid_at IS NOT NULL)),
  -- Paid means paid in full; a part payment is partially_paid.
  CHECK (status <> 'paid' OR amount_paid_paise = amount_paise)
);
CREATE INDEX IF NOT EXISTS payments_advertiser ON app.payments (advertiser_id) WHERE advertiser_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payments_org ON app.payments (org_id) WHERE org_id IS NOT NULL;

-- Razorpay may send the same event more than once; each is acted on once.
CREATE TABLE IF NOT EXISTS app.payment_events (
  event_id    text PRIMARY KEY CHECK (char_length(event_id) BETWEEN 1 AND 100),
  received_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.payments FORCE ROW LEVEL SECURITY;
ALTER TABLE app.payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.payment_events FORCE ROW LEVEL SECURITY;

GRANT SELECT ON app.payments TO app_api;
GRANT INSERT (purpose, advertiser_id, org_id, amount_paise, created_by) ON app.payments TO app_api;
GRANT UPDATE (status, provider_link_id, link_url, amount_paid_paise, provider_payment_id, paid_at) ON app.payments TO app_api;
GRANT SELECT, INSERT ON app.payment_events TO app_api;

-- Seen by the platform's owner, by an advertiser's members for its payments, and by whoever asked (their export).
DROP POLICY IF EXISTS payments_read ON app.payments;
CREATE POLICY payments_read ON app.payments FOR SELECT TO app_api
  USING (app.is_system() OR app.is_owner() OR created_by = app.current_user_id()
         OR (advertiser_id IS NOT NULL AND app.is_ad_member(advertiser_id)));
-- Asked for only while the switch is on: ad credit by the advertiser's owner, for themselves; a plan by the owner.
DROP POLICY IF EXISTS payments_ask ON app.payments;
CREATE POLICY payments_ask ON app.payments FOR INSERT TO app_api
  WITH CHECK (
    app.flag_on('payments') AND created_by = app.current_user_id() AND (
      (purpose = 'ad_credit' AND EXISTS (
        SELECT 1 FROM app.ad_advertiser_members m
        WHERE m.advertiser_id = payments.advertiser_id AND m.profile_id = app.current_user_id() AND m.role = 'owner'))
      OR (purpose = 'enterprise' AND org_id IS NOT NULL AND app.is_owner())));
-- Only the server itself records what Razorpay says.
DROP POLICY IF EXISTS payments_record ON app.payments;
CREATE POLICY payments_record ON app.payments FOR UPDATE TO app_api
  USING (app.is_system()) WITH CHECK (app.is_system());
DROP POLICY IF EXISTS payment_events_system ON app.payment_events;
CREATE POLICY payment_events_system ON app.payment_events FOR ALL TO app_api
  USING (app.is_system()) WITH CHECK (app.is_system());

-- A payment only moves forward: paid stays paid, money received never shrinks, and the amount asked and the link
-- are fixed once set. Events arrive out of order (Razorpay says so); a late "expired" can't undo a payment.
CREATE OR REPLACE FUNCTION app.payments_forward() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.status = 'paid' AND NEW.status <> 'paid' THEN
    RAISE EXCEPTION 'a paid payment stays paid' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.amount_paid_paise < OLD.amount_paid_paise THEN
    RAISE EXCEPTION 'money received never shrinks' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.provider_link_id IS NOT NULL AND NEW.provider_link_id IS DISTINCT FROM OLD.provider_link_id THEN
    RAISE EXCEPTION 'a payment keeps its link' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.provider_payment_id IS NOT NULL AND NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id THEN
    RAISE EXCEPTION 'a payment keeps its payment id' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.payments_forward() FROM PUBLIC;
DROP TRIGGER IF EXISTS payments_forward ON app.payments;
CREATE TRIGGER payments_forward BEFORE UPDATE ON app.payments FOR EACH ROW EXECUTE FUNCTION app.payments_forward();

UPDATE app.schema_meta SET version = 86, applied_at = now();
