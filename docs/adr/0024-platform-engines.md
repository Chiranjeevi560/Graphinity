# ADR 0024: The intelligence platform's engines, and what's connected to what

- **Status:** Accepted 2026-11-01. Migrations 0039-0045, not yet applied to production.
- **Context:** the owner's Master AI Platform Charter, Bidirectional Ad Exchange spec, data schema and
  API specification. The charter's names are kept where its math was kept; every place measurement
  overturned it is listed below.

## Decisions that measurement changed

| Charter said | Measured | Shipped |
|---|---|---|
| Velocity-form PID pacing, λ += … | Spent as little as 56% of budget over 18 simulated worlds; error 0.084 | Positional form with tuned gains: error 0.023, 99% spent; the on/off rule it replaces: 0.138 |
| Isotonic calibration around FTRL, always | A curve from the validation slice sometimes made an already-calibrated model worse, and rejected a good model | Fitted every time, served only if it improves log loss on the judged slice |
| TPE for tuning | After three fixes it ties a Latin hypercube (0.150 vs 0.153 mean best loss) | Hypercube plus halving by default; TPE kept, with no claim that it wins |
| Trained GraphSAGE | Last-layer edge training lowered held-out AUC from 0.74 to 0.61 (embeddings collapse) | Near-identity weights, no training |
| X-learner beats two-model | Identical Qini with linear base models, as algebra predicts | X-learner kept; it can only differ with nonlinear base learners |
| HyperLogLog at ±0.81% | Needs p = 14, 16 KB per cell, about 580 MB a year at 100 cells a day: over the free database | p = 12, 4 KB, nominal ±1.6% (3.05% in one run at 1,000,000) |
| Google search referrer → query | Search engines don't send the query | Only `utm_term` from an ad link, plus the page itself |
| Protected Audience, Topics | A public feature database lists Protected Audience as removed from Chrome in June 2026; Topics' status not confirmed | Client functions that do nothing where the browser lacks them. Not called from any page |

## Benchmarks

`node scripts/benchmark-platform.mjs`, simulated data with known truth, fixed seeds:

```
Calibration ECE: raw                                       0.1679
Calibration ECE: Platt                                     0.0121
Calibration ECE: isotonic (shipped)                        0.0043
Calibration lookup, ns each                                33
Pacing mean error, no pacing                               0.2313 (spent 100.0%)
Pacing mean error, on/off (what served)                    0.0879 (spent 100.0%)
Pacing mean error, primal-dual (shipped)                   0.0053 (spent 100.0%)
CVR, truth 0.300: unsold clicks as "no"                    0.173
CVR, truth 0.300: delayed feedback (shipped)               0.317
Off-policy RMSE: IPS                                       0.0996
Off-policy RMSE: doubly robust (shipped)                   0.0726
Bandit regret over 20,000: uniform                         1423
Bandit regret: LinUCB α=0.5                                815
Bandit regret: Thompson                                    82
LinUCB update, d=32, µs each                               6.5
Uplift Qini: two-model                                     48.6085
Uplift Qini: X-learner (shipped)                           48.6085
CUPED variance left, ρ=0.8 (theory 0.36)                   0.360
A/A false positives under peeking: repeated t-test         0.362
A/A false positives under peeking: mSPRT (shipped)         0.029
Forecast MAE, 30 days: seasonal naive                      6.22
Forecast MAE: Holt-Winters damped (shipped)                5.23
Conformal 90% interval, measured coverage                  0.934
HLL error at 1,000,000                                     3.05%, 4096 bytes, 195 ms (exact Set: 240 ms, ~40 MB)
t-digest relative error at q=0.5                           0.022%
t-digest relative error at q=0.99                          0.530%
t-digest relative error at q=0.999                         1.016%
t-digest bytes, 1,000,000 values                           960
Trust into a clique of 100 (bound 50)                      50.0 in 0.5 ms
Trust into a clique of 10000 (bound 50)                    50.0 in 20.0 ms
Next-item accuracy: first order                            0.455
Next-item accuracy: second order with backoff (shipped)    0.903
```

## What's connected

**Serving or running, behind switches where noted:** partner bidding (`ads_rtb`), holdout ghosts (`ads_holdout`),
pacing (`ads_pacing`), calibration, inbound signals (`ads_partner_sites`), partner events and matching,
journal → cubes, products and commerce cube, knowledge graph with embeddings, feature store, SRM-halting
experiments, audit chain, complaints, memory preferences, evidence from answers, `/owner`.

**Tested engines nothing calls yet:** LinUCB and Thompson, position-bias and doubly robust evaluation,
uplift, ASHA, TPE, delayed feedback, elasticity, FP-Growth rules, trust flow, the rollback governor,
template registry, episodic memory sweep, image hashes, receipt redaction, `advanceStage`, the
Sponsored slot (needs 0.6 kB of script budget). Connecting the ranking ones touches knowledge results,
which should happen one at a time with real traffic to compare against.

**Not built:** see `project report.md`.

## Consequences

- Nothing here affects anyone until migrations are applied and switches turned on.
- `kg_*` nodes are topics and products that passed 25 people: time travel is safe to keep forever.
