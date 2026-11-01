-- What the owner spent to bring people in, by month and currency: the one part of cost per new person the platform
-- can't see for itself. Typed by the owner. Totals only; nothing here is about a person.
CREATE TABLE IF NOT EXISTS app.acquisition_spend (
  month        date NOT NULL CHECK (extract(day FROM month) = 1),
  currency     text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_micros bigint NOT NULL CHECK (amount_micros >= 0),
  PRIMARY KEY (month, currency)
);
ALTER TABLE app.acquisition_spend ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.acquisition_spend FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON app.acquisition_spend TO app_api;
DROP POLICY IF EXISTS acquisition_spend_owner ON app.acquisition_spend;
CREATE POLICY acquisition_spend_owner ON app.acquisition_spend FOR ALL TO app_api
  USING (app.is_owner()) WITH CHECK (app.is_owner());

UPDATE app.schema_meta SET version = 76, applied_at = now();
