# ADR 0007: Offline ranking and counterfactual evaluation primitives

- **Status:** Implemented as pure evaluation functions; no learned model is deployed
- **Date:** 2026-10-22

## Problem

The product contains deterministic ranking rules, but the repository has no common way to compare
ranking versions against judged examples or estimate a candidate policy from randomized logged
actions. Without those measurements, changing weights or introducing a learned ranker would be
guesswork. The currently implemented route and feed rankers are not trained models.

## Decision

Add pure TypeScript functions for macro NDCG@k, MRR, precision@k, recall@k, inverse-propensity
estimation (IPS), self-normalized IPS, effective sample size and maximum importance weight. Inputs
are supplied by the caller; the module performs no database access, network access, storage, or
personal-data collection. Invalid labels and unsupported propensities fail closed. Ties have a
stable ID order. The module deliberately does not clip large importance weights because clipping
silently biases IPS; callers must inspect effective sample size and maximum weight.

## Alternatives considered

- **Change ranker weights without evaluation:** rejected because there is no evidence of improvement.
- **Add a model-serving or experiment platform now:** rejected because the repository has no held-out
  judged corpus, logged action propensities, or available self-hosted inference infrastructure.
- **Add an external ML dependency:** rejected for this slice; the metrics require only standard
  arithmetic and the repository's exact-version, dependency-age policy.

## Complexity and limits

For a query with `n` candidates, evaluation sorts once and computes metrics in `O(n log n)` time and
`O(n)` temporary memory. Across `Q` queries with `N` total candidates, total work is bounded by
`O(Σ nᵢ log nᵢ)` and memory by the largest query plus input. Counterfactual evaluation is `O(A)` time
and `O(1)` extra memory for `A` logged actions. Scores are macro averages per query. Relevance is a
graded integer from zero through four; the gain is `2ʳ - 1` and discount is `log₂(rank + 1)`.

## Security, privacy and operation

The evaluator has no I/O surface and does not log examples. Data preparation, consent, access
control, retention, and deletion remain the responsibility of a future caller and must be reviewed
before connecting personal events. Counterfactual evaluation requires the historical logging policy
to have nonzero probability for every action the candidate policy may choose (positivity); the
function checks observed-action support but cannot prove dataset coverage or causal assumptions.

## Acceptance and verification

Unit tests cover graded ranking metrics, empty-label handling, deterministic ties, unsupported
propensities, invalid probabilities/rewards, IPS, SNIPS and effective sample size. These tests prove
the formulas on small examples, not the predictive quality of a model. Before model deployment,
provide a consent- and privacy-reviewed held-out dataset, compare against the current ranker, report
confidence intervals and segment quality, and run a shadow evaluation. None of those deployment
conditions is currently met.

## Rollback

The evaluator is an isolated module and has no production caller. Remove its imports to roll back;
there is no schema or runtime state to migrate.
