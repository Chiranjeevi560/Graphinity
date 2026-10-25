-- Exploration in routing (docs/adr/0014-routing-exploration.md): a wave's
-- last place may go to someone the model is unsure about. Each such decision
-- is recorded with why, and with its propensity (how likely the procedure
-- was to give the place to that person), so it can be evaluated without bias
-- later. Same table, same system-only access, same 180-day life as the factors.

ALTER TABLE app.route_factors
  -- The model's expected chance this person helps, when a model ranked them: checked against what happened.
  ADD COLUMN IF NOT EXISTS predicted double precision CHECK (predicted BETWEEN 0 AND 1),
  -- Set only on a last place the exploration procedure decided.
  ADD COLUMN IF NOT EXISTS explore_reason text CHECK (explore_reason IN
    ('explored', 'best_already', 'not_uncertain_enough', 'too_costly', 'capped')),
  ADD COLUMN IF NOT EXISTS propensity double precision CHECK (propensity > 0 AND propensity <= 1),
  ADD COLUMN IF NOT EXISTS probability_better double precision CHECK (probability_better BETWEEN 0 AND 1);

-- A decided place has a propensity, and only a decided place does; it was decided by a model.
ALTER TABLE app.route_factors
  ADD CONSTRAINT route_factors_decided CHECK (
    (explore_reason IS NULL) = (propensity IS NULL)
    AND (explore_reason IS NULL OR (model_version IS NOT NULL AND predicted IS NOT NULL AND NOT explore))
    AND (probability_better IS NULL OR explore_reason IS NOT NULL)
  );
CREATE INDEX IF NOT EXISTS route_factors_explored_idx ON app.route_factors (profile_id, recorded_at)
  WHERE explore_reason = 'explored';

GRANT INSERT (predicted, explore_reason, propensity, probability_better) ON app.route_factors TO app_api;

-- No one is explored more than 3 times in 7 days (routing-bandit.ts holds the same number):
-- exploration can't concentrate on anyone, or on a farm of fresh accounts.
CREATE OR REPLACE FUNCTION app.guard_exploration_cap() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF NEW.explore_reason = 'explored' AND (
    SELECT count(*) FROM app.route_factors f
    WHERE f.profile_id = NEW.profile_id AND f.explore_reason = 'explored'
      AND f.recorded_at > clock_timestamp() - interval '7 days'
  ) >= 3 THEN
    RAISE EXCEPTION 'exploration cap reached for this person' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER route_factors_exploration_cap BEFORE INSERT ON app.route_factors
  FOR EACH ROW EXECUTE FUNCTION app.guard_exploration_cap();

-- Exploration is the owner's decision: off until they turn it on. It works only
-- while a routing model is serving; off, the last place is the newcomer place again.
INSERT INTO app.feature_flags (name, enabled, note) VALUES
  ('routing_exploration', false, 'Give each wave''s last place by uncertainty-aware exploration (ADR 0014). Off: the newcomer place, by Ψ and its bonus.')
ON CONFLICT (name) DO NOTHING;

UPDATE app.schema_meta SET version = 32, applied_at = now();
