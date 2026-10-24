# ADR 0003: Consent-based first-party data and commercial intelligence

- **Status:** Accepted; consent controls and the personal graph foundation implemented, downstream collectors and commerce integrations pending
- **Date:** 2026-10-22

## Context

The owner wants Graphinity to create useful personalization and sustainable revenue using first-party information users voluntarily provide or generate in Graphinity. The product brief permits broad categories (searches, reading and interaction history, ownership, purchases, preferences, learning, travel and expertise) only when the purpose is explained, consent is clear, and the user can inspect, export, revoke, and delete the data. The repository currently has no general-purpose consent ledger or personal knowledge graph. The prompts also contain an earlier zero-PII/no-personal-data-sale constraint, which conflicts with the owner's later explicit request for consent-based personal and commercial intelligence.

## Decision

Use an explicit, purpose-bound consent model. Do not collect a signal for personalization or commercial use until the relevant consent is active. Separate consent purposes at minimum into identity, search history, reading/interaction history, ownership and purchase history, AI personalization, commercial personalization, affiliate optimization, partner sharing by partner/category, market research, anonymous analytics, and enterprise use. Core account processing required to provide Graphinity is described separately from optional purposes.

Each consent record must identify the category, purpose, disclosure/version shown, current choice, timestamp, and source. Consent changes append an audit event; revocation blocks future use promptly. Data inventory entries must state source, retention, processors/recipients, export and deletion behavior. Provide access, correction where supported, export, deletion, and a way to disable personalization without deleting the account. Imported data is treated as first-party only after the user explicitly initiates the import and sees its purpose and scope.

Commercial ranking and knowledge/trust ranking remain separate. Commercial status, affiliate payouts, and partner contracts must not affect epistemic ranking. Recommendations should explain why they appear, evidence, geographic applicability, freshness, alternatives, and commercial disclosure. Partner sharing is a distinct opt-in with recipient- and category-specific records; affiliate redirect parameters alone do not authorize sharing a user's profile or history.

Enterprise outputs default to appropriately aggregated, de-identified statistics. Suppression thresholds, bounded contribution, privacy-budget accounting, and resistance to differencing must be established and tested before exposing metrics. The prompts' proposed `k >= 25` is a floor to evaluate, not by itself proof of anonymity or legal compliance. No individual-level data is exposed to an enterprise customer without a separately designed, explicit authorization flow and legal review.

## Alternatives considered

1. **Zero collection / contextual-only product.** Strongest minimization, but does not meet the owner's later stated personalization and commercial-intelligence goal.
2. **Collect all data by default under one broad consent.** Rejected because it obscures purpose, makes revocation imprecise, and creates unnecessary surprise and legal risk.
3. **Collect first-party signals after granular opt-in.** Chosen: supports the stated business direction while preserving user control and auditable purpose boundaries.

## Trade-offs

- Granular controls and audit history add schema, UI, lifecycle, and support work.
- Revocation must be enforced at every write and read/use boundary, not only in settings UI.
- Some data is needed to provide core functionality; the product must distinguish required processing from optional personalization and explain both plainly.
- Aggregated outputs can still leak information through small cohorts or repeated queries; thresholds alone do not solve that risk.
- Consent is not a substitute for lawful basis, age/sector rules, partner contracts, or jurisdiction-specific privacy review.

## Consequences

- New personal signal collection is blocked until consent storage, controls, purpose metadata, retention, export, deletion, and tests exist.
- Future graph tables require strict per-user RLS and API-only access; service-role access must not silently bypass consent checks.
- Recommender services receive only permitted categories and return explainability metadata.
- Partner sharing and enterprise analytics require independent kill switches and auditable paths.
- Launch readiness requires privacy counsel to review applicable laws and partner terms, including India/DPDP and any other target markets.

## Implementation record

Migrations `0003_consent_controls.sql` and `0004_personal_knowledge_graph.sql` implement the category inventory, default-off optional settings, append-only choice history, and RLS-protected graph tables. `GET/PUT /me/consents`, `GET /me/consents/audit`, `/me/graph`, node create/delete, and `/me/data-export` are implemented. The `/me/privacy` screen lets people manage purposes and inspect, add, delete, and export personal graph data. Automated event collectors, per-partner authorization records, enterprise aggregate APIs, DP accounting, and commercial recommendations remain pending.

## Future evolution

Implement in stages: consent inventory and audit ledger; privacy controls and lifecycle APIs; personal graph and opted-in signals; contextual and personal recommendations with ranking isolation; partner-sharing registry; aggregate market intelligence with suppression and privacy-budget tests. Revisit this ADR if legal review or user research changes acceptable purposes or disclosures.
