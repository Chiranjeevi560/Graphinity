# ADR 0030: Privacy Sandbox calls, the Sponsored slot on pages, and the merchant pixel

- **Status:** Accepted 2026-11-01. Migration 0050. Everything here is behind `ads` and `ads_partner_sites`, both off.

## Decision

- **Sponsored slot on the question and search pages**, in its own chunk. While `ads` is off a visit costs one small
  `GET /ads/status` and no ad code.
- **Protected Audience and Topics**, called only for someone who allowed partner sites, without Global Privacy Control, and only
  if the browser has the API. Turning the permission off leaves every group at once.
- **Merchant pixel**: `/ads/tag.js`, and `POST /ads/pixel`. A browser can't keep a secret, so the tag carries a public id and an event
  counts only when the request's `Origin` is a host the advertiser listed. It can't report money: only the Conversions API, with its secret
  key, can. A forged page could still claim a product view for an id it knows; ids rotate, are per advertiser, and only reach a site by a tap.

## Why these calls may do nothing

Google's status page (last updated 14 August 2026) lists both APIs under "Continue to support" in Chrome, yet links an "Intent to Deprecate and
Remove" for each, and marks them as phasing out on Android. Safari and Firefox have neither. So each is feature-detected, and
nothing depends on them. Not tested in a browser that has them: Playwright's browsers don't enable them.

Search engines don't send the query in a referrer, so only `utm_term` from an ad link is read, as before.
