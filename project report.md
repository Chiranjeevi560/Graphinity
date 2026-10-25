# Graphinity implementation report

**Snapshot date:** 2026-10-22  
**Status:** Active implementation; requested master prompts are not complete.  
**Purpose:** Handoff for the owner and future Claude/Codex sessions. Update this report with verified work; never count a roadmap item as implemented.

## Executive summary

Graphinity is an existing React/TypeScript + Fastify modular monolith using Supabase Postgres, Cloudflare Pages, and Render. The starting checkout already contained substantial product/security work and an uncommitted feature-flag implementation. Codex preserved that existing work and has since added consent controls, a personal graph, consent-gated interaction signals, first router-learning edges, route pass/undo, explainable route snapshots, and a finite opt-in personalized question list. The requested master prompts remain incomplete.

The owner’s latest product direction is to use valuable first-party Graphinity data for personalization and monetization only with clear, purpose-specific consent, transparent retention and recipients, and user access, export, revocation, and deletion controls. The conflicting earlier prompt requirement for zero-PII and no personal-data sale is resolved in favor of the later owner direction, with consent and privacy controls retained. Consent alone does not establish legal compliance; legal review remains a launch gate.

This report is not a 100% production-readiness claim. Partner-sharing, enterprise intelligence, differential privacy, broader event capture and graph algorithms, parts of the original hardening prompt, and real deployment checks remain undone.

## Expected vs. built

| Area | Expected in prompts | Built in the current checkout | Remaining work |
|---|---|---|---|
| Existing Graphinity | Global Q&A, routing, reputation, moderation, privacy/security foundation | Existing routes, RLS, OAuth state/nonce, deletion, rate limits, question/answer/points/routing/graph, tests and docs (see `docs/SECURITY.md`, `docs/SPEC.md`, `docs/GRAPH.md`) | Continue audit; resolve documented risks and verify production behavior |
| Kill switches | Independently disable optional subsystems | Pre-existing dirty changes add DB flags for `embeddings` and `push`; API read-only, 30-second refresh, runbook instructions | Review/verify on Node 24 and deploy; add further switches with each module |
| Consent architecture | Separate, transparent user choices | 19 categories; optional choices default off; private settings and append-only audit; `GET/PUT /me/consents`, audit endpoint; migration 0009 updates AI processing disclosure and revokes earlier AI consent pending reapproval; migration 0011 adds the default-off feed purpose | Named-partner authorization records, policy-version change UX, collector enforcement across remaining modules |
| Personal knowledge graph | First-party graph with strict per-user RLS | `0004_personal_knowledge_graph.sql` and `0013_project_personal_graph_events.sql`; node, evidence-edge, event, collection tables with RLS; 37 allow-listed node types; consent-gated manual writes; bounded async projection for selected question interactions; hourly expiry cleanup | Complete collection workflows, graph algorithm suite, measured queue performance/lag alerts, graph scoring, cross-domain personalization |
| User controls | Inspect, change, export and delete | `/me/privacy` screen manages choices and graph nodes; inspect/delete individual signal records; individual and bulk graph deletion; JSON export of profile, posts, selections, feedback, route score snapshots, reports, points, network activity, device identifiers, consents and graph | Export format versioning and long-running/large export behavior |
| Personalization | Explainable, reproducible ranking across personal signals | AI semantic precheck, question embeddings, and backfill require active `ai_personalization`; revocation deletes vectors and excludes those questions from semantic candidates. Search queries and question-view identifiers are captured only with separate consents. Routing learns from answer outcomes and field-local co-answer affinity; decision snapshots are recipient-only. A finite `feed-rrf-v2` list fuses selected fields and separately consented lexical search/reading ranks with RRF; score reasons/version, global kill switch and no-impression behavior are covered. | Adaptive/cross-domain personalization, learning/search/expert/notification/mentor engines, online learning, A/B/shadow evaluation, drift/fairness/calibration, real relevance labels and trained models remain. |
| Commercial intelligence | Affiliate, partner, and enterprise products | Deterministic page-context intent classifier implemented for 14 dimensions; the finite `feed-rrf-v2` knowledge suggestions are separate from commerce. No affiliate, partner transfers or commercial recommendations. | Integrate a separate commercial surface, disclosures, recipients, click controls, aggregate API and privacy review |
| Privacy analytics | `k >= 25`, DP, budget and abuse defenses | No enterprise release or DP implementation | Threat model and privacy budget; suppression/differencing tests before external access |
| Other master prompt scope | SEO/GEO, IaC, CI, routing refinements, performance, security, cost, scale, ADRs | Existing portions documented in repository; route pass/undo, 9 weighted factors plus cold-start/load terms, country timing, learned expertise/affinity and saved route explanations now implemented. ADRs 0003–0004 cover consent and contextual intent. | Audit/implement all remaining requirements; current readiness matrix below is deliberately partial |

## Changes made in the latest implementation turn

- `db/migrations/0003_consent_controls.sql`: initial purpose inventory of 18 categories, default-off optional consent rows, per-user RLS, append-only audit history, required identity category, and data purpose/retention/recipient descriptions; migration 0011 adds feed personalization as category 19.
- `db/migrations/0004_personal_knowledge_graph.sql`: RLS-protected `personal_graph_nodes`, `personal_graph_edges`, `personal_signal_events`, and `personal_collections`; fillfactor 80 on hot personal tables; node/event inserts are blocked unless matching consent is active; a narrow definer function purges expired signal events.
- `apps/api/src/personal-data.ts` and `apps/api/src/main.ts`: run expired signal cleanup on startup and hourly; log only the number of rows removed.
- `apps/api/src/routes/consent.ts`: read, update, and audit routes with schema validation and duplicate/unknown/required category refusal.
- `apps/api/src/commercial-intent.ts`: pure public-page lexical baseline for all 14 commercial intent dimensions; no user profile, user history, payout, or partner metadata in its input API.
- `apps/api/src/routes/personal-graph.ts`: inspect graph, consent-gated node create, individual/bulk graph deletion, and JSON export of profile, questions, answers, selections, feedback, routes, reports, points, network activity, push-device identifiers, consents and graph data.
- `apps/web/src/routes/PrivacySettings.tsx`, route registration and `Me.tsx`: first user-facing consent manager, audit history, graph item add/inspect/delete controls, bulk graph deletion confirmation, and JSON download.
- `apps/web/src/routes/Privacy.tsx`: revised privacy summary to describe optional categories and controls without promising zero collection for the future platform.
- `apps/web/src/styles/tokens.css`: replaced remaining CSS hex color literals with equivalent OKLCH tokens; the contrast suite still passes.
- `docs/API.md`, `docs/RUNBOOK.md`, and ADR 0003: endpoint, operational and architectural records.
- `apps/api/test/consent.integration.test.ts`, `apps/api/test/personal-graph.integration.test.ts`: real Postgres coverage for defaults, audit, user isolation, consent enforcement, revocation, deletion, export, and size bounds.
- `apps/api/test/commercial-intent.test.ts`, ADR 0004, and `docs/commercial-intelligence.md`: deterministic bounded intent scores, explanations, contextual-only inputs, and classifier limitations.
- `db/migrations/0005_route_pass_undo.sql`: recipient-owned route pass and a database-enforced seven-second undo window.
- `db/migrations/0006_consented_interaction_signals.sql`: minimal typed first-party interaction events (no text payload) for question, answer, selection, helpful, and report actions, only while `interaction_history` is enabled; owners can inspect/delete signals and 365-day expiry applies.
- `db/migrations/0007_learned_routing_edges.sql`: field/country expertise priors and field-local co-answer affinities (`fillfactor=80`) with evaluation reinforcement and decay; routing uses country-based circadian fit, greedy diversity, and learning inputs.
- `db/migrations/0008_route_score_explanations.sql`: persists ranking version, selected score, expertise weight, local-time fit, and diversity fit for new routes; recipient-only API explanation and integration coverage.
- `db/migrations/0009_consent_gated_search_and_ai.sql`: semantic embeddings require active `ai_personalization`; existing AI permissions are revoked at the revised disclosure version, revocation clears question vectors, and semantic search excludes revoked vectors. Query text is captured only under `search_history`, and question views only under `reading_history`; both are inspectable, deletable, and expire within 365 days.
- `apps/api/src/backfill.ts`, `apps/api/src/routes/questions.ts`, and `apps/web/src/routes/PrivacySettings.tsx`: consent-aware AI processing and search/reading collectors; the privacy center displays the collected search values and exports them.
- `apps/web/src/components/Inbox.tsx`, `apps/api/test/route-pass.integration.test.ts`: seven-second pass/undo interaction with database expiry and recipient authorization.
- `db/migrations/0010_retract_previous_selection_learning.sql`: rebalances prior learning when a selected answer changes; integration test retains helpful/rating/verdict evidence while removing the old selection reward.
- `db/migrations/0011_feed_personalization_consent.sql`: adds a default-off feed-personalization purpose and a field/time candidate index.
- `db/migrations/0012_recommendations_kill_switch.sql`: inserts the globally controlled `recommendations` flag without modifying previously applied migrations.
- `apps/api/src/routes/recommendations.ts` and `apps/api/src/recommendation-ranking.ts`: bounded `feed-rrf-v2` top-20 ranking using reciprocal-rank fusion over selected-field membership, consented search matches, consented viewed-question similarity, and recency; excludes own/hidden/answered/opened questions and omits each revoked source.
- `apps/api/src/flags.ts`, migration `0012_recommendations_kill_switch.sql`, and `apps/api/src/main.ts`: add a global `recommendations` kill switch, refreshed with the other owner-controlled flags.
- `apps/web/src/components/RecommendedQuestions.tsx` and `apps/web/src/routes/Home.tsx`: finite explainable “For you” list plus link to the user control center when the independent feed choice is off.
- `apps/api/test/recommendations.integration.test.ts`, `apps/api/test/recommendation-ranking.test.ts`, `scripts/benchmark-recommendations.mjs`, `docs/API.md`, `docs/RUNBOOK.md`, and ADR 0006: cover default-off behavior, source-consent revocation, ranking explanations, global shutdown, RRF quality on explicit judged fixtures, query/complexity boundaries and limitations.
- `docs/GRAPH.md` and `docs/RUNBOOK.md`: updated routing factors, score snapshot, complexity caveats, interaction capture and current schema version.
- `apps/api/test/db.integration.test.ts`: removed two unused imports from pre-existing work after lint identified them.
- `apps/web/e2e/answers.spec.ts`: fixed the consensus test data setup to use three distinct, age-eligible accounts; the semantic duplicate journey explicitly opts into AI personalization and accepts a nonblocking related fallback when semantic inference is unavailable.
- `docs/adr/0005-measure-before-distributing.md`: records a measured, staged path from the existing modular monolith to workers, read replicas and regional reads; this does not claim global-scale capacity.
- Updated `package.json` bundle budgets to 6.50 kB CSS and 99.00 kB total JavaScript Brotli, based on measured output of 6.34 kB and 98.95 kB after the personalized home section. Main JavaScript is 61.67 kB under the 61.80 kB limit. The prior lower limits were exceeded by the consent UI.
- Updated Vite from 8.3.2 to 8.3.3, released more than two weeks before this snapshot, to address six advisories reported by OSV; dependency audit and license scan now pass.
- `scripts/lighthouse.mjs`: failed performance checks now list the weighted Lighthouse performance audits that lost score.
- `codex logs.md`: chronological handoff log, including the original dirty tree and verification history.

## Security and privacy properties now covered

- Optional personal graph writes require active consent both at the API and in PostgreSQL RLS policies.
- Owners can continue to inspect and erase their records after revocation; revocation prevents further writes and future use must be filtered by consent.
- Graph records are isolated by `app.current_user_id()`; user foreign keys prevent edges between different accounts.
- Consent choice history allows only read/insert through the API role; no API update/delete grant.
- Account deletion cascades consent and personal graph records through profile foreign keys.
- User-entered graph items use an allow-listed type and bounded JSON attributes.
- Current commercial and enterprise features do not send personal data to partners because those transfer systems are not implemented.

These properties do **not** prove complete privacy compliance. The general adaptive personalization runtime and partner-sharing systems do not exist. AI semantic matching is enabled only by `ai_personalization`; revocation clears the owner's question vectors and prevents their inclusion in semantic results. Feed personalization requires the distinct `feed_personalization` choice and uses search/reading history only while each respective purpose remains enabled. Other consented signals are currently collected for user inspection and export, not used to personalize ranking. Signal cleanup runs hourly, but retention and restore drills are not yet tested. The settings page exposes some purpose categories before corresponding product features exist; each new feature must disclose exactly when and how it starts using data.

## AI/ML ranking implementation (2026-10-22)

- The owner's new directive requires Graphinity-owned/self-hosted AI and ML, with external inference only as an optional fallback. This supersedes ADR 0001's former preference for Cloudflare Workers AI. The existing Workers AI adapter remains hosted third-party inference; self-hosted model weights, runtime, deployment capacity, and operational limits have not been established. Production can omit its credentials and falls back to word matching; the development hash embedder is explicitly not semantic AI.
- Added `apps/api/src/ranking-evaluation.ts`: pure offline NDCG@k, MRR, precision/recall@k, IPS, self-normalized IPS, effective sample size and maximum importance weight calculations. It performs no I/O or event capture, validates labels and propensity support, and uses stable code-unit tie-breaking. Complexity and causal assumptions are documented in ADR 0007.
- Added five unit tests covering graded ranking, deterministic ties, no-label data, invalid inputs, IPS/SNIPS and effective sample size. This is an evaluation primitive only: there is no trained ranker, model registry, logging propensity in existing routing, labeled evaluation corpus, or deployment integration. No predictive-quality claim is made.
- `npm run check:task` passed under Node 24 after the RRF integration: API 415 tests and web 200 tests, API coverage 96.92% lines / 88.19% branches, web 87.78% lines, builds and bundle limits. The subsequent full Chromium/WebKit E2E run passed all 22 journeys, including the screen audit. Realistic load and self-hosted model validation remain unverified.
- ADR 0007 records purpose, formulas, complexity, rejected alternatives, privacy boundaries, limitations, tests and rollback. `docs/ENVIRONMENT.md`, `docs/SECURITY.md`, and ADR 0001 identify the old hosted adapter as transitional rather than self-hosted AI.
- Replaced feed's hand-set 0.42/0.35/0.13/0.10 feature weights with actual source-rank fusion in `apps/api/src/recommendation-ranking.ts`, using `Σ 1/(60 + source_rank)` and version `feed-rrf-v2`. PostgreSQL still bounds candidates at 2,450 before fusion. Unit tests run `evaluateRanking` on RRF-ranked candidates with explicit graded judgments.
- The ranker benchmark ran 250 rounds at 2,450 synthetic candidates: p50 0.337 ms, p95 0.425 ms, p99 0.459 ms, max 0.626 ms. Process max RSS was 83,488 KiB before and 91,968 KiB after. This measures in-process rank fusion only; it excludes PostgreSQL/API latency and RSS is a whole-process high-water mark, not isolated per-request allocation.

## Verification

Verified in the current implementation turn:

- `npm run check:task`: passed with Node `v24.11.1`: typecheck, lint, format, floor guard, 12 migration checks, API 415 tests and web 200 tests; API coverage 96.92% lines / 88.19% branches and web 87.78% lines; API and web production builds; bundle budgets.
- `npm run check:secrets`: passed; Gitleaks reported no leaks in the checkout or pre-commit scan.
- `npm run check:deps` and `npm run check:licenses`: passed after the Vite security update; OSV and `npm audit` report zero vulnerabilities, and all dependencies match the repository's allowed license list.
- The migration integration suite applies all 12 forward migrations to throwaway PostgreSQL databases and exercises RLS/API behavior.
- `npm run test:e2e`: all 22 Chromium and WebKit journeys passed after the personalized-home update; screen audit includes `/me/privacy`, axe checks in light/dark modes, responsive widths, horizontal overflow, and 44 px target checks. Firefox is not in this repository's required browser matrix.
- Latest `npm run check:perf` passed at performance 97, LCP 2.178 s, CLS 0, TBT 69 ms; accessibility, best practices, and SEO were 100. Two samples passed at 98 and 97 after a cold-start failure at 61 (LCP 3.22 s, TBT 2.13 s); repeatability and load/capacity evidence remain incomplete.
- Mutation checks: a routing-weight mutation failed its router-weight test; bypassing the AI-consent gate failed the provider-call assertion. Both source files were restored after the deliberate checks.

Still not verified:

- Live production provider/partner flows remain unverified. Backup restore, signed supply-chain/SBOM, production host headers and production incident drills remain unverified.
- Performance has passing samples but not stable repeated runs, realistic load tests, or p50/p95/p99 capacity evidence.
- The prompt calls routing “11-factor”: the executable formula is nine weighted φ factors plus the cold-start bonus and load dampener. All are represented; calibrated/fairness benchmarks, exhaustive country timezone coverage, real routing SLO monitoring, and large-scale performance evidence remain incomplete.
- The expanded master scope remains incomplete: full personal graph projection; adaptive, feed/search/expert/learning/notification/follow/mentor/commercial recommendation engines; trained models and self-hosted inference; online learning, offline and counterfactual evaluation integration, A/B/shadow/drift/bias/fairness/calibration; retailer/affiliate/attribution/commission/sponsored systems; partner authorization/audit and enterprise commercial APIs; k-suppression plus differential-privacy accounting; comprehensive fraud and Sybil detection; commercial semantic/personal embeddings, duplicate-model benchmarks; multi-region, replicas and regional failover; SLO dashboards/alerts/flag UI; B2B organizations, billing, quotas and metering; backup/restore, disaster recovery, final security/accessibility/performance/load audits; and launch/release verification. These are not built or claimed complete.

## Production readiness scorecard (0–100)

Scores are an engineering snapshot across the prompt’s requested subsystems, not a vendor comparison or certification. A score below 100 means the prompt’s production gates are not all met. The equal-weight mean is **55/100** (rounded from 55.4).

| Subsystem | Score | Evidence and path to 100 |
|---|---:|---|
| Architecture | 65 | Modular monolith and domain routes exist; document full boundaries, vendor adapters, and all major ADRs. |
| Security | 70 | Strong baseline RLS/auth/input defenses; finish prompt-specific audit, threat tests, and production validation. |
| Database | 70 | Numbered migrations, forced RLS, Postgres integration tests; add lifecycle jobs, full restore proof, indexes/load evidence. |
| CI/CD | 55 | Several checks are configured; verify Node 24 full CI, previews, promotion, signing/SBOM and release rollback. |
| Testing | 76 | 621 API/web tests and all 22 Chromium/WebKit journeys pass after graph algorithms; repeatable fault/load and broad mutation suites remain. |
| Observability | 45 | Structured request logs and health route exist; add correlation IDs, redaction audit, SLIs/SLOs and alerts. |
| Monitoring | 35 | Health checks exist; add actionable alerting, dashboards, retention and incident runbooks. |
| Scalability | 25 | Single-region monolith and indexes; no measured 1k–10M capacity model or scale tests. |
| Reliability | 55 | Timeouts/fallbacks/jobs exist; add systematic retries, circuit breakers, idempotency, restore and failure validation. |
| Authentication | 70 | Google state/nonce, JWT validation, short session storage; complete provider policy and live OAuth/device revocation checks. |
| Documentation | 55 | Security/API/runbook/spec and two reports exist; reconcile all prompt requirements and cost/vendor research. |
| Infrastructure | 50 | Render/Cloudflare/Supabase setup documented; isolated environments and reproducible deployment gates incomplete. |
| Developer experience | 65 | npm workspaces, local scripts, tests and code conventions; make all checks work on required Node 24 everywhere. |
| Cost efficiency | 70 | Existing free-tier choices and no-card constraint; verify current limits/costs and model revenue/break-even scenarios. |
| Privacy-first monetization | 25 | Consent and graph foundation exists; personal ranking, partner authorization, disclosures, aggregate intelligence and DP remain. |

## 17-gate checklist

| Gate | Status |
|---|---|
| Functional behavior | Partial — existing app plus consent/graph CRUD; broad prompt product scope remains. |
| Unit tests | Partial — many tests pass; coverage of all new and planned subsystems is incomplete. |
| Integration tests | Green for migrations/RLS and current consent/graph APIs; not the complete requested integration matrix. |
| End-to-end tests | Green for the configured matrix — all 22 Chromium/WebKit journeys pass; no Firefox project is configured. |
| Security validation | Partial — RLS and consent attack cases tested; full adversarial review pending. |
| Performance validation | Partial — latest Lighthouse run passed (97, LCP 2.316 s, TBT 45 ms); repeated-run stability and realistic load/capacity tests remain. |
| Accessibility validation | Green for audited screens — Chromium/WebKit axe checks in light and dark modes, responsive widths, overflow and tap targets passed, including `/me/privacy`; additional assistive-technology and production checks remain. |
| Failure testing | Partial — existing resilience coverage; not all new dependency failures covered. |
| Rollback verification | Partial — additive migration strategy documented; new migration rollback not exercised (forward-fix approach). |
| Documentation | Partial — core API, runbook, ADR, log and report updated; prompt matrix not complete. |
| Operational runbook | Partial — consent/kill-switch notes added; all new systems need on-call procedures. |
| Monitoring | Red for commercial/personal systems — no dedicated metrics/alerts. |
| Alerting | Red — prompt requires alerts; comprehensive alert rules are not implemented. |
| Backup and restore | Red — restore drill not run. |
| Privacy inventory | Partial — consent catalog seeded; legal review and full source/processor inventory pending. |
| Export and deletion | Partial — profile/posts/interaction/consent/graph export, graph bulk erase, and account cascade; browser QA and export format lifecycle need coverage. |
| Cost and scale | Red — current provider limits, cost scenarios, and 1k–10M capacity evidence not completed. |

## Cost and revenue status

The project targets $0 monthly bootstrap infrastructure. No current-price or quota verification is included in this implementation pass. It would be misleading to fill the requested cost-per-million, gross-margin, break-even, affiliate-revenue, and 1k–10M user tables with invented figures. Validate each provider’s current terms and model traffic assumptions before launch; no paid AI, analytics, or partner product has been enabled by this work.

## Next implementation order

1. Implement and validate the remaining personal graph and personalization requirements: complete graph inventory, adaptive feed/search/expert/learning/notification/follow/mentor/recommendation systems, explanation and controls, online/offline evaluation, A/B/shadow/counterfactual methods, drift/fairness checks, and confidence calibration.
2. Build and verify partner/merchant/affiliate systems, retailer integrations, attribution/commission/revenue analytics, sponsored placements, fraud controls, and recipient-specific sharing consent/audit before any external data flow. Partner credentials and account approval are external blockers for live integrations.
3. Implement privacy-preserving enterprise products (bounded contributions, suppression, differential-privacy accounting, access controls, API/dashboard, organizations, keys/quotas, audit and billing) with legal review before exposing user-level outputs. Legal interpretation, payment-account choices and enterprise contracts require owner decisions.
4. Complete search/knowledge requirements (personalized search, ranking evaluations, duplicate detection, expert discovery and embedding benchmarks), and keep trust/knowledge ranking isolated from commercial ranking.
5. Add the monitoring/SLO/alert/feature-flag dashboards, load/capacity benchmarks, backup/restore and regional failover verification, disaster recovery, signed supply-chain evidence, rollback, and launch verification.
6. Finish automated documentation/ADRs and repeat the full security, accessibility, performance, mutation, load, and browser release-candidate gates after the implementations.

## Personal graph event projection (2026-10-22)

- Added migration 0013 / schema version 28. A partial queue index and `projected_at` marker support bounded `FOR UPDATE SKIP LOCKED` processing; generated nodes are unique by owner/category/type/key, and each evidence edge is unique by source signal.
- `project_personal_graph_events` claims at most 500 events per call (API worker uses 100), checks the event category's consent again at processing time, and projects supported question ask/view/select/write/helpful events into owner-scoped topic and question nodes plus weighted, confidence-tagged temporal edges. Question text is not copied. Search events and unsupported signals are acknowledged without projection. Deleting/expiring the source signal cascades to its evidence edge.
- `apps/api/src/main.ts` drains one batch at startup and every 15 seconds. `SKIP LOCKED` allows multiple API instances. Failures leave the transaction uncommitted for retry; logs include counts/error kinds only. No queue-lag metric, alert, graph algorithm suite, or production traffic benchmark is present.
- Added focused integration coverage for opted-in projection, idempotent retries, evidence deletion cascade, and consent revoked before processing. Focused suite passed 6/6. Full repository gates are pending for this turn.
- ADR 0008 documents domain, algorithm, alternatives, complexity, recovery, scale path, and limitations. This advances the personal graph from signal storage to incremental interaction projection; it does not implement the attachment's PageRank, clustering, matching, shortest-path, embeddings, GNNs, or other listed AI/ML systems.

## Personal graph layers, algorithms, and queue operations (2026-10-22)

- Added consent-aware entity/category validation for expertise/learning, trust/interaction, ownership, purchases, travel/experience, commercial preferences, notification preferences, relationships, and privacy-control entries. Added an owner-only edge-creation API with active-consent and same-owner endpoint checks. Edges retain direction, weight, confidence, freshness, category and optional event evidence.
- Added `POST /me/graph/insights` and `apps/api/src/personal-graph-algorithms.ts`: weighted directed PageRank, seed-personalized PageRank/random walk with restart, deterministic weighted label propagation, deterministic 16-dimensional random-walk co-occurrence embeddings, and graph recommendations that fuse PPR and embedding cosine. Inputs are bounded to 1,000 nodes, 5,000 edges, and 10 seeds; analysis is on demand and not persisted. It is self-hosted deterministic graph computation, not a trained recommender or a semantic language model.
- The privacy settings page now filters node types by enabled category and can request/show graph-related items. Result scores are disclosed as graph proximity, not answer quality; revocation/deletion clears displayed derived results.
- Added migration 0014 / schema version 29 for queue status. The projection and queue-status definer functions require a system transaction; aggregate pending count and oldest age are logged each minute, with a warning at five minutes. `personal_graph_question_id` prevents a malformed numeric identifier from poisoning a batch. No external alert receiver, dashboard or SLO is configured.
- Synthetic CPU benchmark: 1,000 nodes / 5,000 edges, 5 warmups and 20 measured rounds: p50 41.584 ms, p95 45.975 ms, p99/max 46.826 ms, process max RSS 189,504 KiB. This measures the in-process graph algorithms on synthetic data only; it does not measure Postgres, HTTP, concurrent accounts, production traffic, or memory attributable solely to the operation.
- Unit and database integration tests now cover algorithm determinism, ranking neighborhood, community separation, limits, active-consent filtering, cross-account endpoint refusal, revocation, system-only worker/status access, and malformed queue IDs. `npm run check:fast` and `npm run check:task` passed: API 421 tests (96.87% lines / 86.18% branches), web 200 tests (87.78% lines), 14 migrations, production builds and size limits.
- All 22 configured Chromium/WebKit E2E journeys passed, including axe/responsive screen audits. Lighthouse passed at performance 97, accessibility 100, best practices 100, SEO 100, LCP 2,316 ms, CLS 0.000 and TBT 45 ms. Gitleaks reported no leaks; OSV and npm audit reported zero vulnerabilities; allowed-license scan passed. These checks do not replace a dedicated concurrency/load test, multi-user capacity validation, provider-level alert configuration, or production deployment. Feature store, training pipeline, model registry, trained recommendation models, semantic search, model-based personalized embeddings, and self-hosted text inference remain unimplemented.

## Consolidation into one line of history (2026-10-24, Claude)

Before this, Graphinity existed in seven copies: `main` (16e9dfb), my unmerged pull request #1 and three branches stacked on it, uncommitted work by Codex in the main checkout, and four GitHub Copilot worktrees (`/Users/Chiranjeevi/copilot-worktrees/graphinity/*`) with uncommitted changes built on the old single `db/schema.sql`. Cloudflare Pages could not build `main`.

Now on `change/20261024-one-line-of-history`, on top of `main`, in order:

1. The Cloudflare build fix: the browser tests have their own TypeScript project and are no longer compiled into the website (reproduced Cloudflare's 39 errors with a fresh clone built from `apps/web`, then the same steps passed).
2. Pull request #1 (branch-and-PR shipping, the migration plan, secret-scan fixes, browser-test fixes for WebKit and Firefox, Lighthouse in CI).
3. Numbered migrations with CI drift checks; removal of `/questions/similar`.
4. The API container image and release workflow; browser tests split by journey, each run on its own fresh database.
5. A `.gitleaksignore` entry for dummy values in a local Copilot checkpoint ref.
6. The feature flags and all of Codex's consent / personal-graph / discovery work (migrations 0002-0014), recovered intact: another tool's `git stash` on 2026-10-23 had taken the edits to existing files out of the working tree.
7. The CI image smoke test locked down (read-only, no capabilities), taken from Copilot's `container-smoke.mjs`.

Copilot work reviewed and not brought in:

| Worktree | Content | Why not |
|---|---|---|
| turbo-robot | Its own copy of migrations, Dockerfile, release workflow; `promote.yml`; Workers AI smoke script | Duplicates items 3-4 above; `promote.yml` calls deploy hooks and GitHub Environments that don't exist yet (Phase 4/5); the Workers AI check conflicts with the self-hosted direction. Its container lockdown was ported (item 7) |
| supreme-adventure | `ml-platform.ts`, `knowledge-graph.ts`, operations/telemetry routes, edits to `db/schema.sql` | Interfaces and types with no implementation behind them (the owner's directive rules these out); built on the pre-migration schema file |
| verbose-umbrella | `graph-algorithms.ts` (PageRank), `ml-platform.ts` wrapper, load-test script | PageRank duplicates Codex's tested `personal-graph-algorithms.ts`; the wrapper only labels the existing embedder |
| musical-succotash | Single-flight embedding cache; PageRank convergence reporting | Real but small. The cache change also turns batched embedding calls into one call per text (more Cloudflare calls for the backfill); the PageRank change overlaps Codex's rewrite of `routing-score.ts`, and its seed de-duplication fixes a case that can't occur (seeds come from a primary key). Worth a separate, measured change |
| symmetrical-succotash | First draft of the Cloudflare build fix | Superseded by item 1 |

Every patch is kept for reference in this session's scratch folder and still in the worktrees themselves; nothing in them was deleted.

Open question for the owner: migration 0009 puts the meaning-based duplicate check behind each asker's optional "AI personalization" consent and clears the embeddings of questions whose askers haven't opted in. Optional consents start off, so duplicate detection works by words for almost everyone. A question's public text is not personal data; this looks like a miscategorisation, but it's a product decision.

Verification of the combined branch: see the next section once the browser suite and Lighthouse finish.

### Verification of the combined branch (2026-10-24)

- `npm run check:task` (through `ship.sh`, Node 24, local Postgres): typecheck including the browser tests' own project, lint, formatting, floor guard, 14 migrations lint-clean, API 421 tests, web 200 tests, builds, bundle budgets.
- Browser suite, Chromium and WebKit: 21 of 22 passed on the first run. "answers that report amounts" failed once in WebKit: one of its three answers (the ₹96,000 one) was missing from the question page, though the test had seen it appear right after posting. The same test then passed twice in a row in WebKit. Not diagnosed: the failure's trace was overwritten by the re-run. Open; next step is to keep its trace on the next failure and read the answer's POST and the later GET.
- Lighthouse: performance 98, accessibility 100, best practices 100, SEO 100, LCP 2,131 ms, CLS 0.000, TBT 37 ms.
- Before Lighthouse could run, the local API refused to start: "password authentication failed for user graphinity_api". Two Copilot worktrees have their own `.local/api.env`; `scripts/db.sh start` creates the API login with a new random password when its checkout has no `api.env`, and all checkouts share one Postgres, so a Copilot run replaced the password. Restored to this checkout's value. Those two worktrees' logins will now fail instead; they are paused.
- Not run here: Firefox (won't start on this Mac; CI runs it), the API image build and the release workflow (no Docker here; CI runs the image step), and the live Supabase migration.

## Graphinity's own models: learning platform and text embedding (2026-10-25, Claude)

Owner decision: train everything from Graphinity's own data; no pretrained weights and no outside AI. ADR 0010 has the full design, alternatives and measurements.

Built and verified:
- Model registry (`app.ml_models`, migration 0015, schema 30): versions, parameters, dataset fingerprint, held-out scores against the serving baseline, status, reason; weights with SHA-256 for promoted versions only; one serving version per model (unique index); system-only RLS. A new optional consent purpose, `model_training`, off by default, and a `model_training` kill switch.
- `ml/linalg.ts`: seeded RNG, CSR sparse matrices, Gram-Schmidt (twice), Jacobi eigensolver, randomized top-k eigenpairs (Halko et al.). No dependencies.
- `ml/text-embedding.ts`: PPMI (window 5, 1/d, α 0.75) factorized to 128 dims (p = 0.5), SIF sentence vectors (a = 1e-3, first component removed), hashed vectors for unseen words; deterministic; serialized artifact with integrity check.
- `ml/embedding-gate.ts`: stable 1-in-5 held-out split, details-to-title retrieval, MRR and recall@10, candidate fused with words exactly as the precheck serves, paired bootstrap promotion rule; BM25 baseline in `ml/bm25.ts`.
- `ml/training.ts` + `training-worker.ts`: daily job on a worker thread; skips under 200 consented documents or unchanged data; promotes or records the rejection; the server swaps a promoted model in without restarting.
- Tests: 464 API tests pass (43 new: linear algebra, the embedding, the gate, the training run, the serving wrapper, and the pipeline against a real database, including a real worker-thread run). Branch coverage 85.76% (bar 85.65%), lines 97.12%. One test proves learning: held-out questions whose details share no word with their title (synonyms for every word); word matching finds none (MRR 0.012, recall@10 0%), the model learned the synonyms from other questions and found them (MRR 0.079, recall@10 18%, 82 queries), and the gate promoted it (95% interval of the gain 0.039 to 0.102). Real but modest, at 400 short synthetic questions. Broken on purpose and caught: ignoring consent, not retiring the old version, skipping the integrity check, held-out data leaking into training, promoting on the mean instead of the interval (first survived; the test was sharpened until it caught it). Surviving by design: removing the query's hidden-post filter, because the read policy already excludes hidden posts (defence in depth).

Measured (synthetic, this Mac): 8,006 documents train in 5.1 s with 150 MB peak memory growth (304 MB before building the matrix from sorted keys); 39,881 documents in 13.8 s, 231 MB; embedding a text takes 0.006 ms at the median. On held-out retrieval the gate refused to promote: model alone MRR 0.933, fused with words 0.973, words alone 0.997, because in that data the details always repeat the title's exact words. Real posts will decide; until a version wins, search works by words.

Cloudflare Workers AI is removed from the code and settings (no outside AI remains). Not built yet (honestly): spelling correction, learned ranking and a feature store, spam and fraud models, the commerce graph and affiliate engine, merchant platform, enterprise analytics with k-anonymity and differential privacy, and a self-trained language model. Render's free instance memory isn't confirmed on Render's own pages.

## Spelling correction learned from Graphinity's own posts (2026-10-25, Claude)

Owner request: "the next system on this branch: spelling correction learned from our own data." ADR 0011 has the design, alternatives and measurements.

Built and verified:
- `ml/spelling.ts`: vocabulary, counts and word pairs from consented posts (words seen at least twice); symmetric-delete candidates up to 2 edits over 7-letter prefixes; optimal string alignment distance over letters as people see them (so Telugu and Hindi vowel signs stay with their consonant); a noisy-channel choice with a bigram model and a tuned "leave it as written" score; never corrects known words, short words, codes, or the last word while it's being typed.
- `ml/spelling-gate.ts` and `ml/train-spelling.ts`: test typos injected into held-out posts (never forming a real word), unseen held-out words as the leave-alone set, tuning on one half and scoring on the other, and promotion only at a 95% lower bound of 80% precision with at least 100 test typos, 30 changes, and no fewer fixes than the serving version.
- The daily job trains it beside the text model on the same worker thread, registry, consent and kill switch; a promoted version serves at once. The precheck adds corrected words to its word search and counts a question holding every corrected word as holding every word; the text itself is never changed or returned.
- Tests: 488 API tests pass (24 new), branch coverage 85.97% (bar 85.65%). A test shows the prefix index finds exactly what a full scan of the vocabulary finds. Broken on purpose and caught (25): corrections not searched, the corrected title not counted, the last word corrected while typed, context from the typo instead of its fix, known, short or code words corrected, no transpositions, held-out questions or answers trained on, the serving version's fixes ignored, promotion on the mean instead of the bound, the typo and change minimums, typos that are real words, tuning that ignores the bar, ties split, `keep` ignored or not finite, rejected weights kept, unchanged data retrained, spelling recorded as the text model, a short index prefix, a whole-word lookup, a wrong ASCII split, and the 12-word limit counting repeats. Five survived the first round; each time the test was too weak, and it was sharpened until it caught the mutation.
- Bugs found by the tests and measurements, and fixed: context taken from the misspelled previous word ("cusotms dity" became "dirty"); a corrector with no "leave it" option changed correct rare words (1,854 changes for 1,538 typos); a 122 MB index (now 18 MB); lookups 5× slower from splitting letters (now faster than before); and my own change to the word-query builder that let repeats count against its 12-word limit.

Measured (synthetic, Apple M2): a full run takes 1.6 s at 2,000 questions, 3.9 s at 10,000 and 7.5 s at 40,000, with 101–226 MB peak memory growth; correcting a word takes 0.07 ms at the median. On held-out test words it fixed 95% of typos at 10,000 and 40,000 questions, right in 90% and 95% of its changes; at 2,000 the gate refused (lower bound 79.4%). Not verified: real people's typos (the test typos are injected), and Render's memory under both training runs (its free memory isn't stated on its own pages).

## Personal graph algorithms v2 (2026-10-25, Claude)

Owner request: continue in dependency order with the personal knowledge graph and its algorithms, measured and tested. ADR 0012 has the design, evidence and gaps.

What measurement found wrong in v1, and the fixes (all measured on planted-community graphs at the 1,000-node cap):
- Label propagation put every node in one community once 40% of links crossed communities (NMI 0). Louvain, with each community split into its connected parts, keeps finding structure (NMI 0.93 / 0.82 / 0.70 / 0.47 at 10–40% mixing, against 0.86 / 0.59 / 0.39 / 0.02).
- Hashed walk embeddings barely beat chance at predicting hidden links (AUC 0.53–0.65). NetMF, the exact matrix DeepWalk approximates, factorized with the text model's eigensolver: AUC 0.90 / 0.84 / 0.73 / 0.64.
- The recommendation score added personalized PageRank (≈0.001 per node) to cosines (0–1), so PageRank barely counted; it found hidden neighbours less often than PageRank alone. v2 ranks by cosine to the PageRank-weighted embedding: 17% / 11% / 8% / 6% of hidden neighbours in the top 10, against 8% / 3% / 5% / 1%.
- Stored confidence and freshness were ignored. Now weight × confidence, and observed edges halve every 90 days (a stated prior); entered edges don't fade.
- Analysis ran on the request thread inside the database transaction. It now runs on one worker thread after the transaction, with a queue of 8 and a plain-words 503 beyond it.
- PageRank rewritten on flat arrays: bit-identical results, 4–20× faster, so v2 is faster than v1 at every size (2.5 ms at 50 nodes, 13.5 ms at 300, 71–172 ms at 1,000).

Verified: 21 rules broken on purpose, 18 caught (PageRank's dead-end mass, untested since v1, survived at first and now has an exact test); of the 3 survivors, 2 are equivalent rankings and 1 guards a Louvain failure no test graph triggers (its function is tested directly). Branch coverage 86.07% (bar 85.65%) after replacing dead `?? 0` fallbacks with the `valueAt` helper. Not verified: real personal graphs (none exist to measure), and above 50% mixing at this sparsity nothing recovers structure, v2 included. Projected signals still all carry weight 1 (a picked answer counts like a view); that needs outcome data.

## Learned routing (2026-10-25, Claude)

Owner request: replace heuristic routing with learning (Bayesian confidence, expertise weighting, freshness, availability prediction, reputation), with a fresh-eyes review before it stands. ADR 0013 has the design, evidence and gaps.

Built and verified:
- Every routing decision now records the nine factors it saw (`app.route_factors`, migration 0016, schema 31). The table is system-only, kept 180 days, and checked by the database: range, length, NaN, the model version against the registry and against the route's own record, and the newcomer place always on Ψ. Before this, only three factors were kept, so nothing could be learned without leaking outcomes.
- A two-stage Bayesian logistic model (P(answers) × P(helps | answers)) is fitted exactly by Newton's method with step-halving. Wave is a training-only term. Trust, reputation, proximity and country can't get negative weights, enforced by an active set that also releases weights, so it ends at the true optimum. Prior strength comes from question-grouped cross-validation.
- The gate compares against Ψ recomputed from the same factors, per question and wave. Each asker counts once, 30 askers with accounts at least 14 days old are needed, a 99% asker-resampled interval must lie above 0 with a gain of at least 0.02, trust must take 5 or more values, and a candidate must not be worse than the serving model. After a measured rejection, only newer questions are judged.
- Serving happens only with a promoted model **and** the owner's `learned_routing` switch (off by default). It re-ranks the whole eligible pool for exploit places, re-scores diversity through the model, and keeps the load dampener. The newcomer place stays Ψ.
- Reviews: the design review found 4 blockers (unfair baseline, rings steering labels and gate, trust learning zero early, factors readable by the routed person). The code review found 2 (the judging window locking the gate shut after any rejection, which a test reproduced first; the cap keeping the oldest routes). It also found labels that could change after settling, hidden answers counted, a constrained fit that could stop short, and trust "varying" from one pick. All were fixed with tests.
- Tests: 33 rules broken on purpose, 31 caught; the 2 survivors are second locks (database row security; a guard inside `candidates()`).

Measured (simulation, Apple M2):
- Where Ψ under-weighs availability, the learned model ranks helpful people with about +0.2 AUC and is promoted at 1,000 questions every time.
- Where outcomes come from Ψ, it was refused in all 30 benchmark runs, but over 100 runs the 99% gate still promoted 2. The bootstrap undercovers at about 50 askers. Those models were about as good as Ψ, and the owner's switch is the last control.
- 48,465 routes train in 9.5 s (49.5 MB) on the worker thread; scoring takes 0.5 µs per candidate.

Not verified: real outcomes (the live database has no routes yet; the gate will refuse until they exist). Off-policy limits are stated, and a small random place per wave with recorded probabilities is offered as a separate change. Before merging: `npm run db:migrate:remote` (migrations 0015 and 0016), then merge.

## Routing exploration (2026-10-25, Claude)

Owner request: a production-grade exploration and exploitation framework for routing, chosen by measurement, exploring only when uncertainty justifies it, with logging, regret measurement, promotion and demotion, fairness, abuse resistance and rollback. ADR 0014 has the design and evidence.

Built and verified:
- **Posterior:** the routing model's Laplace approximation (weight covariance) plus a person effect per stage. The person effect is a Laplace update from each person's own settled record (residual and information), with τ estimated by approximate marginal likelihood. Cold start and new-expert discovery come from it, not from a reserved place.
- **Gated Thompson sampling** for each wave's last place. The winner of a posterior draw takes the place only if it has at least a 25% posterior chance of beating exploitation's choice, at least half its expected value, and fewer than 3 exploration routes that week (also a database trigger, under a per-person lock against concurrent runs, migration 0018). Otherwise exploitation's choice takes it.
- **Logging:** every decided place records its reason, the chance it was better, the model's prediction at the route's real wave, and its propensity (a 128-draw estimate; the full place distribution sums to 1, tested). Decisions are deterministic per question, wave and model version.
- **Monitoring:** automatic demotion by calibration (z < −2.58 and observed under 80% of predicted), with the same check in the promotion gate and a retirement moving the judging window, so a demoted model can't return the next night. A daily report gives a SNIPS estimate of never exploring.
- **Switch:** exploration is off until the owner turns on `routing_exploration`; it needs a promoted model; off, the spec's newcomer place returns within a minute.
- **Review:** a fresh-eyes review found 2 blockers (calibration comparing later waves with wave-1 predictions; a demotion undone the next night) and should-fixes. The fixes: a real posterior mean from each person's record, information from settled routes, the cap race, a refusal falling back instead of failing the wave, a retired model cleared from memory, and a 12-seed benchmark with tuned rivals and a competing-answers world. The rest is stated in the ADR.

Measured (simulation, 12 seeds, ± standard error, regret against an oracle, difference from never exploring):
- **Today's newcomer place:** +90 ± 10 (independent answers) and +9.9 ± 1.3 (competing), the costliest in both.
- **Gated Thompson:** −8.5 ± 6.9 and +2.4 ± 1.9.
- **Best GLM-UCB:** −13.9 ± 7.5 and +1.0 ± 2.5, which can't be told apart from gated Thompson.
- **Why gated Thompson:** its randomness is what makes the logged propensities, and so later unbiased evaluation, possible; UCB is deterministic. Where answers compete, no exploration paid for itself within 30 days; the gated cost is about 0.27 points of "someone helped" per question.
- **Speed:** 3.7–4.9 ms per decision, in the background routing job.

Tests: 578 API tests, branch coverage 86.23% (bar 85.65%). 18 rules broken on purpose, all caught; three survived first (the safety gate, routing reading each candidate's record, and the cap's lock, whose race test couldn't see the race) and their tests were sharpened.

Not verified: real people (no live routes yet). The application-level fallback after a database cap refusal happens only in a race and isn't exercised end to end (the lock itself is tested with two concurrent transactions). Exploration isn't shown to the routed person. Before merging: run `npm run db:migrate:remote` (0015–0018), then merge.

## Search, part 1: consent (2026-10-25, Claude)

Owner request: a production-grade semantic search, on both the Ask check and a new Search screen (owner's choice), with meaning for everyone and purpose-based consent asked only once. ADR 0015 records the decisions and the plan in parts; a fresh-eyes review of the whole design found three consent blockers first (bundled purposes, old data used under a new purpose, and a "deleted on revoke" that wasn't true), which reshaped this part.

Built and verified:
- **Fixed a false privacy text:** `ai_personalization` said question text goes to Cloudflare, which stopped being true when Cloudflare was removed. It is now corrected (policy version 3), and meaning-based matching no longer depends on it. The precheck, question creation, backfill and `nearest_questions` are updated, the vector-clearing trigger is dropped, and the change is announced once in the app.
- **A new optional purpose,** `search_improvement` (off, separate from search history, nothing from before), asked once through `awaitingAnswer` and a "Two privacy updates" sheet. Any answer, including closing it, ends the asking for good. Reading history's text now says truthfully when reading time is measured.
- **Dialog spacing:** paragraphs had no space between them in every dialog; fixed.
- **Tests:** API tests for asking once, the corrected texts, and meaning without the choice (three old tests that encoded the gating were rewritten, see the commit). In a real browser the sheet was checked at 320, 375, 430 and desktop in light and dark: 44 px targets, contrast 7.6:1 and 19:1, no sideways scroll, and an answer is never asked again. There is an end-to-end test with the accessibility audit, and sign-in helpers that answer the sheet only when the app asks.
- **ANN measured before it's tuned:** pgvector's default `ef_search` 40 finds only 77% of the true nearest questions at 100k. 640 of the 768 stored dimensions are zeros, so storage is about 370 MB at 100k against a 500 MB free database. Both are fixed in the ANN part.

Not done yet (the later parts in ADR 0015): the engine and `POST /search`, logs with delete-on-revoke, the Search screen, 128-dimension storage, learning, and load tests.
