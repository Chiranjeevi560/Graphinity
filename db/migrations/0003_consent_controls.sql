-- Granular, default-off consent for optional personalization and commercial
-- purposes. Choices are private to one account; audit records are append-only.

CREATE TABLE IF NOT EXISTS app.consent_categories (
  name text PRIMARY KEY CHECK (name ~ '^[a-z][a-z0-9_]{0,39}$'),
  purpose text NOT NULL CHECK (char_length(purpose) BETWEEN 10 AND 500),
  data_description text NOT NULL CHECK (char_length(data_description) BETWEEN 10 AND 500),
  retention text NOT NULL CHECK (char_length(retention) BETWEEN 5 AND 300),
  recipients text NOT NULL CHECK (char_length(recipients) BETWEEN 5 AND 300),
  policy_version integer NOT NULL CHECK (policy_version > 0),
  required_for_service boolean NOT NULL DEFAULT false
);
ALTER TABLE app.consent_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.consent_categories FORCE ROW LEVEL SECURITY;
GRANT SELECT ON app.consent_categories TO app_api;
CREATE POLICY consent_categories_read ON app.consent_categories FOR SELECT TO app_api USING (true);

INSERT INTO app.consent_categories
  (name, purpose, data_description, retention, recipients, policy_version, required_for_service)
VALUES
  ('identity', 'Create and secure your Graphinity account and show your chosen public profile.', 'Chosen username, country, fields, adult confirmation, and account security state.', 'While your account exists; deletion removes the profile and linked account data.', 'Graphinity; hosting and authentication providers process data to operate the service.', 1, true),
  ('search_history', 'Personalize your own search and recommendations using searches made in Graphinity.', 'Search text and the time and context of searches in this service.', 'Until you delete it, revoke consent, or delete your account; deletion controls are provided.', 'Graphinity only unless another separately enabled purpose permits sharing.', 1, false),
  ('reading_history', 'Personalize your own experience from questions and answers you read in Graphinity.', 'Viewed content identifiers and optional reading-duration measurements.', 'Until you delete it, revoke consent, or delete your account; deletion controls are provided.', 'Graphinity only unless another separately enabled purpose permits sharing.', 1, false),
  ('interaction_history', 'Improve your own routing and recommendations from your Graphinity interactions.', 'Saves, follows, clicks, votes, and other in-service interactions.', 'Signal events expire within 365 days; graph records remain until you remove them or delete your account.', 'Graphinity only unless another separately enabled purpose permits sharing.', 1, false),
  ('ownership', 'Use products or services you choose to record to improve your own recommendations.', 'Items, versions, region, and optional ownership dates that you provide.', 'Until you remove the entry, revoke consent, or delete your account.', 'Graphinity only unless partner sharing is separately enabled for this category.', 1, false),
  ('purchase_history', 'Use purchase records you enter or explicitly import to improve your own recommendations.', 'Purchase items, dates, price ranges, retailer, and region that you provide or import.', 'Until you remove the entry, revoke consent, or delete your account.', 'Graphinity only unless partner sharing is separately enabled for this category.', 1, false),
  ('travel_preferences', 'Personalize travel-related answers and services using travel information you choose to provide.', 'Countries, regions, and travel preferences you enter or explicitly import.', 'Until you remove the entry, revoke consent, or delete your account.', 'Graphinity only unless partner sharing is separately enabled for this category.', 1, false),
  ('learning_expertise', 'Personalize learning and expert discovery from skills and learning goals you choose to record.', 'Topics, skills, certifications, goals, and progress you provide.', 'Until you remove the entry, revoke consent, or delete your account.', 'Graphinity only unless partner sharing is separately enabled for this category.', 1, false),
  ('commercial_personalization', 'Rank product and service recommendations for your interests and preferences.', 'Selected first-party interests, ownership, purchase, budget, and retailer signals whose categories you enabled.', 'Until you revoke consent or delete your account; associated optional signals are no longer used after revocation.', 'Graphinity; affiliate partners receive only the referral information described at the point of click.', 1, false),
  ('affiliate_optimization', 'Measure and improve contextual affiliate referrals shown in Graphinity.', 'Referral and campaign identifiers and Graphinity click events; partner-side processing is governed by that partner.', 'Referral events are retained for up to 13 months unless a shorter partner or legal period applies.', 'The affiliate network or retailer named beside the referral; no profile/history is included by this choice.', 1, false),
  ('partner_sharing', 'Share specifically selected categories with a named partner when you separately authorize that sharing.', 'Only categories, fields, and recipients shown in a separate partner authorization.', 'For the duration and deletion terms shown in the partner authorization; Graphinity records the authorization.', 'Only the named partner and categories you approve in the separate authorization.', 1, false),
  ('partner_recommendations', 'Receive recommendations from a named commercial partner using only signals and fields you explicitly authorize.', 'Partner, signal categories, and preference fields shown before a partner recommendation program is enabled.', 'For the program duration and as described in its separate authorization.', 'The specifically named partner; this setting alone does not authorize sharing.', 1, false),
  ('market_research', 'Use eligible information to calculate privacy-protected aggregate market trends.', 'Bounded, grouped contribution data; small groups and unsafe queries must be suppressed.', 'Raw contribution data is retained only as long as needed for aggregation; aggregate retention is documented per product.', 'Graphinity; approved research customers receive only reviewed aggregates unless separately authorized.', 1, false),
  ('anonymous_analytics', 'Measure service reliability and broad usage without advertising profiles.', 'Aggregate counts and technical events with direct identifiers excluded or promptly removed.', 'Event-level data up to 30 days; aggregated measures up to 25 months.', 'Graphinity and service operators; no advertising partners.', 1, false),
  ('enterprise_data_licensing', 'Allow reviewed enterprise products to use eligible aggregate trends for commercial purposes.', 'Only reviewed, suppressed aggregates; individual-level access requires separate explicit authorization.', 'As stated for each enterprise product and in the data-use record.', 'Enterprise customers named in product documentation receive aggregates by default.', 1, false),
  ('ai_personalization', 'Use permitted first-party Graphinity information to personalize AI-assisted features for you.', 'Only categories with active consent sent to a configured AI provider; provider and fields are disclosed before activation.', 'Provider request retention and Graphinity caches are documented per feature; revoke stops future use.', 'Graphinity and the named AI processor; no training use unless separately disclosed and consented.', 1, false),
  ('notification_preferences', 'Use notification settings and choices to send the updates you ask for.', 'Delivery channels, topics, and frequency settings you select.', 'Until you change the setting or delete your account; delivery records are kept only as operationally required.', 'Graphinity and the push/email service needed to deliver the selected notification.', 1, false),
  ('relationship_graph', 'Use relationships you explicitly record to improve your own discovery and recommendations.', 'People or organizations and relationship labels you enter or explicitly import.', 'Until you remove an entry, revoke consent, or delete your account.', 'Graphinity only unless you separately authorize sharing with a named partner.', 1, false)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS app.user_consent_settings (
  user_id uuid NOT NULL REFERENCES app.profiles(id) ON DELETE CASCADE,
  category text NOT NULL REFERENCES app.consent_categories(name) ON DELETE RESTRICT,
  enabled boolean NOT NULL DEFAULT false,
  policy_version integer NOT NULL CHECK (policy_version > 0),
  source text NOT NULL DEFAULT 'settings' CHECK (source IN ('settings', 'onboarding', 'import', 'partner_authorization')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category)
) WITH (fillfactor = 80);
ALTER TABLE app.user_consent_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_consent_settings FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON app.user_consent_settings TO app_api;
CREATE POLICY consent_settings_self ON app.user_consent_settings FOR ALL TO app_api
  USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id());

CREATE TABLE IF NOT EXISTS app.user_consent_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app.profiles(id) ON DELETE CASCADE,
  category text NOT NULL REFERENCES app.consent_categories(name) ON DELETE RESTRICT,
  enabled boolean NOT NULL,
  policy_version integer NOT NULL CHECK (policy_version > 0),
  source text NOT NULL CHECK (source IN ('settings', 'onboarding', 'import', 'partner_authorization')),
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_consent_audit_user_time_idx ON app.user_consent_audit_log(user_id, changed_at DESC);
ALTER TABLE app.user_consent_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_consent_audit_log FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON app.user_consent_audit_log TO app_api;
CREATE POLICY consent_audit_self_read ON app.user_consent_audit_log FOR SELECT TO app_api
  USING (user_id = app.current_user_id());
CREATE POLICY consent_audit_self_insert ON app.user_consent_audit_log FOR INSERT TO app_api
  WITH CHECK (user_id = app.current_user_id());

UPDATE app.schema_meta SET version = 18, applied_at = now();
