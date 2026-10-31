# ADR 0029: The owner's analytics

- **Status:** Accepted 2026-11-01. Migration 0049.

## Decision

Hourly jobs write aggregates; the owner's page reads only those rows, never live tables.

- **Cohort retention**: per signup week, how many acted in each later week. Shown only for cohorts of at least 25.
- **Time to first answer**: a t-digest per day and field, merged across days for the median and 95th percentile.
- **Resolved within 4 days**: the charter's "VRR₄", defined here as picked or marked helpful within 4 days of asking.
- **Asked about together**: FP-Growth over one basket per person for 90 days, smoothed lift, at least 25 people. So one person asking
  often counts once, and a pair below the floor is never stored.
- **Error budget** on the owner's page, from the existing SLO status.

## Not built, and why

- **LTV, CAC**: Graphinity has no revenue and no marketing spend to measure. A formula over zeros would be a fake number.
- **Price elasticity**: the engine is tested, but needs price and quantity pairs. Answers report prices, not how many sold. It waits
  for merchant data.
- **Retention heatmap with colour**: figures as text for now; each colour would have to pass the contrast rule in both themes.
