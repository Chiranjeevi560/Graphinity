# ADR 0018: Feature drift monitoring, with the rule chosen by measurement

- **Status:** Accepted and built 2026-10-26.
- **Scope:** the tabular models that serve from logged inputs: routing (ADR 0013) and the search
  ranking (ADR 0015 part 6). The text model's drift is ADR 0019, judged by the same rule.

## Problem

A model is gated once, on held-out data from when it was trained. If what it sees in service moves
away from that, its quality can fall with nothing noticing:

- people start asking from new countries;
- answers arrive faster;
- meaning search finds more results than words do.

Training runs daily but only skips or retrains; it never asks whether the serving model's inputs
still look like its training data.

## Decision

**At training:**

- Each input feature of the training data is summarized as a profile: 201 quantiles, plus count,
  mean and standard deviation (36 KB per model, in `ml_models.dataset.profile`).
- No raw values are kept.
- Quantiles are always observed values (inverse empirical CDF). Interpolated ones invented values
  between a flag's 0 and 1 and blurred its point masses; a test proved this.

**Daily, as the system** (`src/ml/drift-monitor.ts`):

- The last 7 days of inputs, at most 100,000 rows, are compared with the serving version's profile.
  These are exploit routes, and searches that weren't interleaved by people not under collusion
  review: the populations training reads.
- One row per feature goes into `app.ml_drift` (migration 0026: system only, kept 400 days).
- If anything drifted, training starts at once instead of at the next daily run. The gates still
  decide whether a new version serves.

**The rule** (`src/ml/drift.ts`): a feature drifts when all of these hold:

- PSI ≥ 0.05 over the reference's deciles, plus a bin below its minimum and one above its maximum
  (added by ADR 0019: without them, nothing below a constant reference could show);
- two-sample KS against the profile is significant at 0.01 ÷ (features tested);
- there are at least 200 current values.

KS takes one quantile step off its statistic: the profile can't place a discrete value's mass more
finely than that.

## Measurement

`scripts/benchmark-drift.mjs` profiles 10,000 reference values in four shapes like Graphinity's
features:

- a score;
- a skewed count;
- a flag;
- a rank that is zero 40% of the time.

It then draws 200 to 100,000 current values, unmoved or moved by a negligible (0.05 sd), moderate
(0.25 sd) or material (0.5 sd) amount, with matching changes for flags and zero shares. 200 trials
each; the worst shape is reported:

| Rule | False alarms | Negligible moves flagged | Material caught at n = 200 / 1k / 10k / 100k |
|---|---|---|---|
| PSI ≥ 0.25 | 0 | 0 | 0 / 0 / 0 / 0 |
| PSI ≥ 0.2 | 0 | 0 | 0.02 / 0 / 0 / 0 |
| PSI ≥ 0.1 | 0.015 | 0.02 | 0.49 / 0.31 / 0.06 / 0 |
| KS p < 0.01 | 0.010 | **0.975** | 0.78 / 1 / 1 / 1 |
| PSI ≥ 0.1 and KS | 0 | 0 | 0.49 / 0.31 / 0.06 / 0 |
| **PSI ≥ 0.05 and KS (built)** | **0** | **0.005** | **0.78 / 1 / 1 / 1** |

What the table shows:

- **PSI's usual bars** (0.1, 0.2, 0.25) miss material moves of discrete features. A flag going from
  30% to 45% is PSI 0.097.
- **KS alone** flags almost every negligible move once samples are large, the kind of alarm people
  learn to ignore.
- **Both together** take KS's power and PSI's sense of size.

## Performance and scale

- **Cost:** O(m log m) per feature for m current values (sort and binary searches); the profile
  itself is O(n log n) once, at training.
- **Measured:** 6 ms for 1,000 rows × 9 features, 40 ms for 10,000, 410 ms for 100,000 (the cap).
  Profiling 1,000,000 training rows × 9 takes 1.9 s.
- **At larger scale:** the cap keeps a run bounded, and 100,000 recent rows estimate a CDF to
  within about 0.004. Beyond one server, the same profiles merge (quantile sketches) and the
  comparison runs per shard; the stored rows don't change.

## Not built, and why

- **Concept drift** (the inputs stay the same but what helps changes): already watched where labels
  exist. Routing's monitor demotes a model whose calibrated predictions fall short (ADR 0014). The
  search judge rolls back a promotion its predecessor beats (ADR 0015).
- **Alerting a person:** the log line `drift monitor` names drifted features. With one owner and
  free tiers there is no paging service; the runbook says what to look at.
