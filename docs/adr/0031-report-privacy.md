# ADR 0031: What a business's ad reports cost

Date: 2026-11-01. Status: accepted under the owner's autonomous-run directive; the owner can change any number here.

## Context

Three independent re-audits showed that exact figures, free re-reads and per-day parallel composition each let a business learn
about one person: report a sale and re-read; subtract two reads across someone's withdrawal; add viewers until a floor flips.

## Decisions

- **Every read costs and draws fresh noise.** Reused noise over changing data gives away exactly who changed it.
- **Budgets:** 2.0 of ε a UTC day and 12.0 in any 30 days, per business. A private report read costs 1.0 per cell a person can be in; a campaign report 1.0; lift 0.8.
- **Noise grows with a report's days,** which share one charge. Long reports are coarser instead of refused.
- **Floors are noised and charged,** and raised by a margin (`FLOOR_DELTA`, 1e-6) so wide noise can't let a lone viewer through. Hidden cells aren't counted.
- **Rule attribution models only** in releases: the data-driven one lets one path move everyone's credit.
- **Exact spend stays.** A business must see its bill. It shows that a click happened, never who, and the business's own site saw that visit.

## Consequences

About two reads a day and twelve a month, and small campaigns see little until they are large: at one day the floor is about 58 people. Whether that suits real businesses is unknown until there are some.
ε = 12 a month isn't a strong promise alone; clips and floors carry part of the weight, and over a year it adds up with no lifetime bound. Signed-out viewers have no identity to clip by, so they don't get the full guarantee.
