# ADR 0033: Enterprise analytics, off until an agreement and the privacy page allow it

Date: 2026-11-04. Status: accepted under the owner's instruction to build every income system code can build, with
anything that needs a partner, a contract or a lawyer kept off.

## Context

The implementation report listed enterprise analytics and API licensing as not built. Graphinity already computes,
for the owner, what people ask about each topic's products: the commerce cube (ADR 0024), where a product appears only
once 25 or more people have mentioned it, each day's count has Laplace noise, and a 30 and 90 day forecast comes with
it. Organizations (retailers, makers, researchers) would pay for that kind of trend. Nothing about a person is in it.

## Decision

- **What an organization reads:** `GET /enterprise/v1/topics/:field?days=1..90` with its own key: per day, the
  product and its noised count. Only cube rows with 25 contributors or more, at most 500 rows. **Not the forecasts:**
  they are fitted to un-noised daily mentions, so comparing one day's forecast with the next would reveal the newest
  day's exact count (found by the independent review). Noised forecasts can be added later, fitted to noised counts.
- **Keys:** `gre_` and 43 random characters, shown once to the owner, kept as a SHA-256 hash; revoked at once.
- **Quota:** each organization has a number of reads a UTC day (1,000 unless set), counted in the database, plus the
  per-key request limit the ad keys use.
- **Who manages it:** the platform's owner only, at `/owner/enterprise/*`, each change written to the audit log, with
  a recent sign-in once `step_up_auth` is on.
- **Every rule in the database too:** `app.enterprise_topic_demand` is the only way to read. It checks the switch, the
  key, the quota and the floor itself; the tables are readable by the owner alone.
- **Off:** the switch `enterprise_analytics` starts off, and the API answers 404 `enterprise_off`.

## Before turning it on

1. A written agreement with each organization: what it may do with the numbers (no re-identification, no resale).
2. The privacy page says Graphinity shares noised totals about topics with organizations, never anything about a person.
3. A lawyer's view on whether DPDP or GDPR treats noised totals with a 25-person floor as anonymous.
4. Then: `UPDATE app.feature_flags SET enabled = true WHERE name = 'enterprise_analytics';`

## Consequences

- No new personal data is collected or shared; the numbers are the owner page's numbers.
- The noise is fixed per day and product, so reading the same row again reveals nothing new, and no privacy budget is
  spent per read.
- Payment isn't built: Graphinity has no way to take money without a paid processor (the owner's zero-cost rule). The
  agreement and invoices are outside the code until the owner chooses one.
