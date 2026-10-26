# ADR 0006: Finite, consented knowledge discovery

- **Status:** Accepted. Its sources and fusion are superseded by ADR 0016 (`feed-rrf-v3`, measured);
  its rules (finite, consented, no commerce, nothing stored, no hand-picked weights) stand.
- **Date:** 2026-10-22

## Problem

The owner's later master prompt asks for feed and recommendation personalization. The older product
spec prohibited algorithmic feeds. The later direction permits finite, consented knowledge discovery
but must not turn an answer service into an engagement-optimized endless timeline or allow commercial
signals to change trust and knowledge ranking.

## Decision

Implement a finite home-page list of at most 20 public questions through `GET /me/recommendations`.
Its own `feed_personalization` purpose is default-off. It uses profile fields (required account data)
and may use search and reading signals only while their respective independent choices remain active.
It ignores interactions, purchase/ownership, affiliate, and commercial features. It returns a
reason and algorithm version per response, persists no recommendation decision, and excludes hidden,
own, answered, and already-opened questions.

## Domain model and schema

The existing question, profile-field, consent, and personal-signal tables remain authoritative. The
additive migration adds one consent catalog row and a `(field, created_at DESC, id DESC)` index for
recent topic candidates. Search uses the existing GIN index on `questions.search`; activity uses the
existing `(user_id, consent_category, occurred_at DESC)` index. No user-level features, scores, or
recommendation impressions are stored.

## Algorithm and complexity

`feed-rrf-v2` considers bounded candidate pools from selected fields, active lexical search matches,
questions near viewed-question topics, and recent questions. Each source returns an independent
best-first rank, and the service fuses available ranks with Reciprocal Rank Fusion:

```text
score(candidate) = Σ 1 / (60 + rank_in_active_source(candidate))
```

The fusion constant 60 reuses the repository's precheck RRF configuration. No learned or hand-tuned
feature weights are used. Search and reading sources use PostgreSQL lexical retrieval rank; freshness
and field membership are separate sources. The strongest contribution supplies the explanation.
The returned score is a retrieval score, not calibrated probability or predicted user satisfaction.

Search and viewed signals are capped to 50 each; lexical candidate retrieval is capped at 20 per
search, viewed-question topic candidates at 25 per view, and general recent candidates at 100.
Together with the 100-candidate selected-field source, the pre-deduplication ceiling is 2,450
candidates per request. PostgreSQL computes lexical ranks with the existing GIN index, caps each
source, and computes four row numbers. Application fusion is `O(C log C)` time and `O(C)` temporary
memory for at most `C = 2,450` candidates. The limits bound request work independently of total
account history. `scripts/benchmark-recommendations.mjs` measures the actual fusion function over
that synthetic maximum candidate count; it measures algorithm CPU cost, not database or HTTP latency.

## Alternatives considered

1. **No personalized discovery:** conflicts with the owner's latest requirement.
2. **Engagement-ranked infinite timeline:** rejected; it optimizes a proxy that can undermine answer
   quality, user agency, and attention.
3. **Hand-picked weighted features:** rejected because the weights lacked judged-data evidence.
4. **External ML/embedding model:** not selected for this route; the deterministic rank fusion has
   no inference provider, model drift, or opaque feature weights. It remains a baseline until local
   models have a consent-reviewed dataset and held-out evidence of improved ranking quality.
5. **One broad personalization consent:** rejected; search and reading each keep independent consent.

## Trade-offs, cost and scalability

Rank fusion is explainable and inexpensive, but inherits the lexical retrievers' misses on semantic
matches and long-tail relevance; it does not learn negative feedback or calibrated confidence. It
runs one bounded query per home view and adds no cache invalidation or separate service. At larger
scale, profile features and ranked candidates can move to a rebuildable offline feature store only
after p95/query-volume benchmarks show the indexed bounded query misses the documented SLO. Any such
store must apply current consent at read time.

## Consistency, privacy and security

Consent is read in the same request as candidate scoring; disabled search/reading categories cannot
contribute. The API uses the signed-in account scope and public-question visibility rules. No signal
content is returned, only a source-specific reason. No partners receive the result or inputs. The
API returns an empty disabled response rather than silently falling back to personal data use.

## Observability and benchmark methodology

Algorithm version and bounded result count are returned for reproducibility; no per-user impression
log is stored. Existing request logs must not include response bodies. Integration tests cover
consent/exclusion; unit tests use `evaluateRanking` on explicit synthetic relevance judgments to
check that RRF puts the highly judged multi-source item first. The standalone benchmark measures
the fusion function's p50/p95/p99 and process RSS delta at maximum candidate count. Production DB/API
p50/p95/p99, real relevance labels, confidence intervals, and drift/fairness dashboards do not yet
exist; this is not a million-user capacity claim.

## Failure modes and recovery

If the query fails, the standard API error path returns no partial recommendation result and the
home page's recent-question list remains available. If a consent lookup fails, the request errors
rather than assuming permission. No asynchronous state needs replay or cleanup. The global
`recommendations` kill switch is checked before the user-scoped scoring query; the feature is also
disabled per user by default through independent consent.

## Acceptance criteria

- Disabled feed consent returns no personalized candidates.
- Search/reading features only influence results under their independent active choice.
- Own, hidden, answered, and already-opened questions are excluded.
- A finite top 20 is ordered deterministically and each item carries an explanation/version.
- Unit/integration/browser tests cover consent, ranking, privacy and usability.
- Production performance remains subject to repeated Lighthouse runs and realistic load tests.

## Migration and rollback

Migration `0011_feed_personalization_consent.sql` is additive and forward-only. Roll back the UI/API
release to remove the surface; the unused catalog row and index are safe to retain. The consent row
defaults off, so a rolling deployment cannot opt existing users in. A later ranking formula ships
as a new algorithm version; no historical score data migration is required.
