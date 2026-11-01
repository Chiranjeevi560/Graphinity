-- The charter asks for 30- and 90-day demand forecasts; the cube kept only 30.
ALTER TABLE app.olap_daily_commerce_cube ADD COLUMN IF NOT EXISTS holt_winters_forecast_90d real;

UPDATE app.schema_meta SET version = 82, applied_at = now();
