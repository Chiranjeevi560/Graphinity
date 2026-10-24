# Commercial intent classifier

## Current implementation

`apps/api/src/commercial-intent.ts` provides a deterministic lexical baseline for 14 public-page
intent dimensions: purchase, upgrade, replacement, import, travel, education, financial, insurance,
healthcare education, developer tooling, enterprise procurement, hiring, subscription, and service.

Inputs are page content only: question title, consensus summary, expert answers, supporting evidence,
tags, field, country, and a public-page confidence value. The function has no user id, personal graph,
search history, purchase history, affiliate payout, or partner status input. It calls no external AI
provider and persists nothing. Output gives each dimension a 0–1 score, matched-signal labels, an
explanation, and algorithm version `lexical-v1`.

Each unique lexical signal contributes 0.35 (maximum 1.0), multiplied by
`0.875 + 0.25 * pageConfidence`, then clamped to `[0,1]` and rounded to 0.001. If public page
confidence is absent, it defaults to 0.5. `pageConfidence` is bounded to `[0,1]`; non-finite input
becomes zero. Scores are deterministic relevance signals, **not calibrated purchase probabilities**.

## Separation and safe use

This module is not wired into search, answer ordering, trust, or routing. Any future caller must use
it only to filter/rank a separate commercial surface. Commercial output, payout, and sponsor status
must never alter knowledge, consensus, trust, or search ranking. A future recommendation must show
its signals, evidence, geographic applicability, freshness, alternatives, and commercial disclosure.

The lexical taxonomy will have false positives and miss new phrasing. Before adding AI enrichment,
collect a consented evaluation set, measure precision/recall per dimension and language, cache strictly
by content hash, set a quota, and preserve this deterministic fallback. Do not label these scores as
probabilities until calibrated against a reviewed dataset.

## Verification and remaining work

`apps/api/test/commercial-intent.test.ts` checks 14-dimension output, determinism, bounded scores,
NFKC normalization, empty signals, and invariance to unrelated identity/payout metadata. No product
route, affiliate link, partner transfer, or enterprise API uses this output yet.
