# ADR 0004: Page-context commercial intent baseline

- **Status:** Accepted; deterministic classifier implemented, commercial product integration pending
- **Date:** 2026-10-22

## Context

The owner wants commercial recommendations to be relevant and based on consented first-party
information. The master prompt also asks for a deterministic baseline across 14 intent dimensions,
explainability, and resilience to optional AI classification. Personal consent controls now exist,
but partner integrations, commercial ranking, and a personalization service do not.

## Problem

We need a safe first stage for identifying public content with commercial context without creating a
user-level ad profile or coupling commercial value to knowledge quality.

## Decision

Implement a pure deterministic lexical classifier over public question/consensus content. Its type
has no user identity, event history, commercial payout, or partner-status field. It returns a bounded
score and matching rule labels for 14 dimensions. It is not used by existing ranking or exposed to
partners. The score is a relevance heuristic, not a purchase probability.

## Alternatives considered

1. **External AI at request time:** rejected for the first version because it adds cost/quota and
   provider-retention questions before the output has demonstrated value.
2. **Train a purchase predictor from user histories:** rejected for now because there is no consented
   evaluation set, calibration data, retention model, or personalization runtime.
3. **Deterministic page-only rules:** chosen as an inexpensive, reproducible, inspectable baseline.

## Trade-offs

- Lexical rules miss synonyms, languages, and nuanced intent and can match benign educational
  discussion.
- Outputs are explainable and stable but not statistically calibrated.
- Page context improves relevance without user profiling, but cannot personalize to an individual.

## Consequences

- The module is isolated from knowledge, trust, consensus, search, and routing.
- Any later commercial surface must disclose sponsorship and use of the classifier.
- Payout, sponsor status, and partner data remain unavailable to knowledge-ranking code.
- Optional AI enrichment needs a separate decision covering consent, provider, caching, budgets,
  retention, fallback, evaluation, and circuit breaking.

## Acceptance criteria

- All 14 outputs are deterministic and bounded to `[0,1]`.
- Explanations list the matching lexical rules.
- Adding unrelated identity or payout metadata does not change output.
- No current request route sends user-level or page-level data to a commercial partner.
