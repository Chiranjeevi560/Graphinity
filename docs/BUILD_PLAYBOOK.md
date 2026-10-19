# Graphinity: 0-to-Launch Execution Playbook & Claude Code Master Prompts

## 1\. Quick-Start Repository Initialization

Before running any AI coding prompts, initialize the workspace directory on your machine and place the two foundational context files so Claude has permanent, zero-hallucination access to the architecture specification:

\# 1\. Create the repository root and documentation directory

mkdir \-p graphinity/docs

cd graphinity

git init

\# 2\. Save Graphinity\_Engineering\_Bible.md into docs/GRAPHINITY\_BIBLE.md

\# (Download from Google Drive and place at ./docs/GRAPHINITY\_BIBLE.md)

\# 3\. Create the root CLAUDE.md constitution file (copy Section 2 below into ./CLAUDE.md)

---

## 2\. Complete `CLAUDE.md` File (Save as `./CLAUDE.md` in Project Root)

Copy the following block verbatim into `./CLAUDE.md` at the root of your repository. [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview) and Cursor automatically load this file into every session.

\# Graphinity Engineering Constitution (CLAUDE.md)

\#\# 1\. Primary Source of Truth

The complete architecture, mathematics, design system, and database specification for \*\*Graphinity\*\* (\*"Ask once. Reach people who've actually done it."\*) lives in \`docs/GRAPHINITY\_BIBLE.md\`.

Before planning or writing code for any feature, ALWAYS read the referenced sections of \`docs/GRAPHINITY\_BIBLE.md\` first.

\#\# 2\. Product Anti-Goals (Strictly Forbidden)

\- NEVER build a public social feed, trending timeline, or infinite scroll stream.

\- NEVER build manual user following, friend requests, or public follower counts.

\- NEVER use a single global reputation score; reputation is strictly partitioned by \`(user\_id, field\_id, country\_iso)\`.

\- NEVER generate synthetic AI answers to user questions; AI is restricted to embeddings, duplicate detection, structured number extraction, and spam moderation.

\- NEVER add nested reply threads under answers; disagreements are resolved mathematically via the Consensus Engine.

\#\# 3\. Non-Negotiable Code & Architecture Rules

1\. \*\*Zero Placeholders\*\*: Never output \`// TODO\`, \`// implement later\`, \`pass\`, or mocked return values in production modules. Every function, SQL query, shader, and worker must be 100% implemented.

2\. \*\*Strict TypeScript\*\*: Enable \`"strict": true\`, \`"noUncheckedIndexedAccess": true\`, \`"exactOptionalPropertyTypes": true\` in \`tsconfig.json\`. Zero \`any\` types (\`@typescript-eslint/no-explicit-any: error\`).

3\. \*\*Hexagonal / DDD Backend (\`apps/api\`)\*\*:

   \- Runtime: Node.js 22 LTS \+ \[Fastify\](https\://fastify.dev/docs/latest/) \+ TypeScript.

   \- Database: PostgreSQL 17 \+ \[pgvector\](https\://github.com/pgvector/pgvector) (\`halfvec(1536)\`) queried via Kysely or Drizzle with 100% parameterized SQL.

   \- Primary Keys: UUIDv7 (RFC 9562 time-ordered UUIDs) for all entity tables (\`users\`, \`questions\`, \`answers\`).

   \- Text Hygiene: Normalize all user string inputs with \`.normalize('NFC')\` at the API boundary.

   \- Currency & Numbers: Store monetary values in \`NUMERIC(18, 2)\` and integer minor units; clamp graph weights to \`\[0.01, 0.999\]\`.

4\. \*\*Apple-Grade Spatial Frontend (\`apps/web\`)\*\*:

   \- Stack: \[React 19\](https\://react.dev/reference/react) \+ \[Vite\](https\://vite.dev/guide/) \+ TypeScript following Feature-Sliced Design (\`app\`, \`pages\`, \`widgets\`, \`features\`, \`entities\`, \`shared\`).

   \- Color System: Exclusively use the OKLCH CSS custom properties from Section 6.1 of \`docs/GRAPHINITY\_BIBLE.md\` meeting \[WCAG 2.2\](https\://www\.w3.org/TR/WCAG22/) AA/AAA contrast. Never hardcode raw \`\#hex\` or \`rgb()\` values in components.

   \- Motion Physics: All interactive transitions must use the damped harmonic spring solver (\`m \* x'' \+ c \* x' \+ k \* x \= 0\`) from Section 8.1 and respect \`prefers-reduced-motion: reduce\`.

   \- Living Graph Canvas: Run force layout physics and WebGPU/WebGL2 instanced rendering inside a dedicated Web Worker (\`OffscreenCanvas\`) with a synchronized keyboard-navigable shadow DOM (\`\<nav aria-label="Knowledge Graph Topology"\>\`).

5\. \*\*Mandatory Self-Verification Gate\*\*:

   \- After completing any prompt, run:

     \`pnpm typecheck && pnpm lint && pnpm test\`

   \- Fix all compiler, linter, and test failures autonomously before reporting completion.

---

## 3\. The 10 Sequential Master Prompts for Claude

Run these prompts **one by one in sequential order**. Wait until Claude runs the verification suite (`pnpm typecheck && pnpm test`) and passes 100% before issuing the next prompt.

### Phase 1: Monorepo Scaffolding & Local Docker Infrastructure

**Estimated AI Execution Time**: \~15 minutes

Read Sections 13.1, 14.1, and 15.1 of \`docs/GRAPHINITY\_BIBLE.md\`.

Task:

1\. Initialize a \`pnpm\` workspaces monorepo with:

   \- \`packages/shared\`: Shared TypeScript domain types, UUIDv7 generator (RFC 9562), NFC Unicode normalizer, Homoglyph detector, Wilson score math, and damped spring physics solver.

   \- \`apps/api\`: Node.js 22 \+ Fastify v5 \+ TypeScript \+ Kysely \+ BullMQ \+ Pino structured logging \+ OpenTelemetry hooks \+ Vitest.

   \- \`apps/web\`: React 19 \+ Vite \+ TypeScript \+ TanStack Query v5 \+ Vitest.

2\. Create \`docker-compose.yml\` running:

   \- PostgreSQL 17 with \`pgvector\` (\`pgvector/pgvector:pg17\`) on port 5432, pre-configured with \`shared\_preload\_libraries \= 'pg\_stat\_statements'\`.

   \- Redis 7.4 Alpine on port 6379 with AOF persistence enabled.

3\. Configure strict root \`tsconfig.base.json\`, ESLint 9 flat config, and \`.env.example\`.

4\. Write unit tests in \`packages/shared\` verifying UUIDv7 monotonic ordering, NFC Unicode normalization, and Wilson score lower-bound accuracy.

5\. Run \`pnpm install\`, \`pnpm typecheck\`, and \`pnpm test\` until everything passes.

### Phase 2: PostgreSQL 17 Schema, HNSW Indexes, RLS & Seed Taxonomy

**Estimated AI Execution Time**: \~20 minutes

Read Sections 15.2, 15.3, 15.4, and 22.3 (Items 2, 3, 4, 5, 6, 14\) of \`docs/GRAPHINITY\_BIBLE.md\`.

Task:

1\. Create a deterministic SQL migration runner in \`apps/api/src/shared/infra/db/migrations/\`.

2\. Implement Migration \`0001\_initial\_schema.sql\` containing:

   \- Extensions: \`citext\`, \`pg\_trgm\`, \`vector\`.

   \- All 7 core tables from Section 15.2 (\`users\`, \`fields\`, \`user\_field\_expertise\`, \`user\_affinity\_edges\`, \`questions\`, \`question\_routings\`, \`answers\`) plus \`outbox\_events\` (for transactional CQRS events) and \`refresh\_tokens\`.

   \- Include optimistic concurrency \`version INTEGER NOT NULL DEFAULT 1\` on mutable tables.

   \- Configure \`fillfactor \= 80\` and aggressive autovacuum parameters on \`user\_field\_expertise\` and \`user\_affinity\_edges\`.

3\. Implement Migration \`0002\_indexes\_and\_rls.sql\` containing:

   \- All HNSW (\`halfvec\_cosine\_ops\`), GIN (\`search\_tsv\`, \`gin\_trgm\_ops\`), partial composite, and covering indexes from Section 15.3.

   \- PostgreSQL Row Level Security (RLS) policies from Section 15.4.

4\. Create a seed script (\`pnpm \--filter api db:seed\`) that populates 25 high-stakes expertise fields (Imports & Customs, Horology & Watches, Study Abroad, Cross-Border Tax, Immigration Visas, Hardware Manufacturing, Maritime Logistics, Distributed Systems, etc.) with appropriate \`decay\_half\_life\_days\`.

5\. Write database integration tests verifying schema constraints, HOT update fillfactor settings, and HNSW cosine similarity queries.

### Phase 3: Zero-Trust Authentication & Node Genesis API

**Estimated AI Execution Time**: \~25 minutes

Read Sections 7.2 (Screen 1), 14.1, and 16.1 of \`docs/GRAPHINITY\_BIBLE.md\`.

Task:

1\. Implement the \`identity\` module in \`apps/api/src/modules/identity/\`:

   \- \`GET /api/v1/auth/google/start\` and \`GET /api/v1/auth/google/callback\` implementing OAuth 2.0 with PKCE (\`S256\`) and cryptographic \`state\` nonce validation.

   \- Issue short-lived (15-minute) EdDSA (\`Ed25519\`) JWT access tokens and rotating refresh tokens stored in \`\_\_Host-graphinity\_rt\` (\`HttpOnly\`, \`Secure\`, \`SameSite=Lax\`, \`Path=/\`) cookies with family-based reuse detection and instant revocation.

   \- \`GET /api/v1/users/check-username?username=...\`: \<15ms uniqueness check against \`citext\` with UTS \#39 confusable homoglyph rejection.

   \- \`POST /api/v1/users/onboarding\`: Sets \`@username\`, \`country\_iso\` (defaulting to Cloudflare \`CF-IPCountry\` header), \`timezone\_iana\`, and initial \`field\_ids\`, initializing \`user\_field\_expertise\` rows with TrueSkill \`(mu \= 25.0, sigma \= 8.333)\`.

2\. Add rate-limiting (\`@fastify/rate-limit\` backed by Redis) and strict security headers (\`@fastify/helmet\` with nonce CSP).

3\. Write integration tests covering PKCE verification, refresh token rotation, stolen refresh token family revocation, and onboarding validation.

### Phase 4: Hybrid Semantic Precheck & Duplicate Interceptor

**Estimated AI Execution Time**: \~25 minutes

Read Sections 7.2 (Screen 2), 11.1, and 12.1 of \`docs/GRAPHINITY\_BIBLE.md\`.

Task:

1\. Implement the \`EmbeddingProvider\` interface in \`apps/api/src/modules/inquiry/infra/\` supporting 1536-dimensional \`halfvec\` generation (with a deterministic local test embedding adapter and production OpenAI/Cloudflare Workers AI adapter) plus Redis L2 caching by normalized text SHA-256 hash.

2\. Implement the 3-stage Semantic Precheck pipeline (\`POST /api/v1/questions/precheck\`):

   \- Stage 1: Extract structured entities (sub-location, currency/value mentions, core intent).

   \- Stage 2: Execute single-roundtrip hybrid SQL query combining \`pgvector\` HNSW cosine similarity (\`halfvec\_cosine\_ops\`) and PostgreSQL \`ts\_rank\_cd\` BM25 lexical matching via Reciprocal Rank Fusion (\`k \= 60\`, \`w\_sem \= 0.65\`, \`w\_lex \= 0.35\`) partitioned by \`(field\_id, country\_iso)\`.

   \- Stage 3: Score top 10 candidates with cross-encoder equivalence scoring; return \`INTERCEPT\_DUPLICATE\` when similarity \>= 0.88 (within the field's freshness window), \`SHOW\_RELATED\` when 0.72 \<= similarity \< 0.88, or \`CLEAR\_TO\_ASK\` when \< 0.72.

3\. Implement \`POST /api/v1/questions\` to atomically create a new Question Node (with deterministic semantic slug \+ short ULID/UUIDv7) and append a \`QuestionAsked\` event to \`outbox\_events\`.

4\. Write unit and integration tests verifying duplicate interception on variations of "How much customs did you pay importing a Rolex watch through Chennai?".

### Phase 5: The 11-Factor Intelligent Routing Engine & Staged Wave Worker

**Estimated AI Execution Time**: \~30 minutes

Read Sections 10.2, 11.2, and 14.3 of \`docs/GRAPHINITY\_BIBLE.md\`.

Task:

1\. Implement \`QuestionRoutingService\` in \`apps/api/src/modules/routing/\` using the exact 11-factor mathematical formulation from Section 11.2 and Section 14.3:

   \- Factors: Semantic Experience Proximity (0.24), TrueSkill Conservative Reputation (0.18), Country/Sub-region Match (0.15), Personalized PageRank Trust (0.12), Wilson Helpful Score (0.10), Best Answer Selection Rate (0.08), Responsiveness/Latency (0.06), Circadian & Temporal Activity Fit (0.04), Topological Diversity via greedy submodular penalty (0.03), UCB1 Cold-Start Bonus (beta \= 0.12), and Notification Budget Dampener.

2\. Implement the BullMQ Outbox Processor & Staged Wave Scheduler (\`WaveRoutingWorker\`):

   \- Wave 1 (t \= 0m): Route to top 5 candidates (4 exploit \+ 1 cold-start explore), decrementing their daily notification budget and recording \`question\_routings\`.

   \- Wave 2 (t \= 20m delayed job): Triggered automatically if \< 3 experts have viewed or started answering.

   \- Wave 3 (t \= 60m delayed job): Triggered if consensus confidence \< 0.70.

3\. Implement the real-time Server-Sent Events endpoint (\`GET /api/v1/questions/:id/pulse-stream\`) backed by Redis Pub/Sub that streams anonymized subgraph topology coordinates, active wave pulses, and expert response states to the client.

4\. Write comprehensive unit tests proving circadian timezone filtering, notification cap enforcement, cold-start inclusion, and greedy submodular clique avoidance.

### Phase 6: Empirical Answers, DBSCAN Consensus Engine & Graph Learning

**Estimated AI Execution Time**: \~30 minutes

Read Sections 10.2, 11.3, 11.4, 11.5, and 21.2 of \`docs/GRAPHINITY\_BIBLE.md\`.

Task:

1\. Implement \`POST /api/v1/questions/:id/answers\` with:

   \- Anti-scam / anti-AI guardrails (strip WhatsApp/Telegram solicitation numbers; reject low-specificity generic boilerplate).

   \- Structured numerical & currency claim parser.

2\. Implement \`ConsensusEngine\` in \`apps/api/src/modules/inquiry/domain/ConsensusEngine.ts\`:

   \- Execute Trust-Weighted 1D DBSCAN clustering (\`epsilon\_rel \= 0.08\`) over extracted numerical claims (e.g., grouping ₹92k–₹98k into the ₹95,000 majority cluster while isolating ₹80,000 and ₹1,40,000 into minority clusters).

   \- Compute cluster mass weighted by responder TrueSkill and PPR trust.

   \- Compute normalized Shannon entropy \`H\_norm(q)\` and \`ConsensusConfidence(q) \= 1 \- H\_norm(q)\`.

   \- Automatically set \`is\_minority\_pinned \= true\` on the highest-trust answer in each minority cluster so minority lived experiences never disappear.

3\. Implement \`POST /api/v1/answers/:id/helpful\` and \`POST /api/v1/questions/:id/best-answer\`:

   \- Recompute Wilson lower bound (\`z \= 1.96\`) and Composite Answer Rank Score \`Omega(a\_i, q)\` (Section 11.5).

   \- Atomically update responder's field-specific TrueSkill \`(mu, sigma)\`, recompute Medal Tier (\`NONE | VERIFIED | BRONZE | SILVER | GOLD\`), update responder's \`experience\_centroid\` running vector average, and strengthen \`user\_affinity\_edges\` using the exponential half-life decay equation from Section 10.2.

4\. Write property-based tests using \`fast-check\` verifying that edge weights always stay in \`\[0.01, 0.999\]\` and minority clusters are always preserved.

### Phase 7: Apple-Grade Design System, OKLCH Tokens & Core Epistemic UI

**Estimated AI Execution Time**: \~30 minutes

Read Sections 3, 4, 5, 6, 7, and 8.1 of \`docs/GRAPHINITY\_BIBLE.md\`.

Task:

1\. Create the CSS design token system in \`apps/web/src/shared/ui/tokens.css\`:

   \- Implement every Light Mode and Dark Mode OKLCH color variable from Section 6.1 (\`--surface-canvas\`, \`--surface-card\`, \`--surface-glass\`, \`--text-primary\`, \`--text-secondary\`, \`--accent-pulse\`, \`--status-consensus\`, \`--status-variance\`, \`--status-danger\`).

   \- Implement the typography tokens from Section 5.1 (\`--font-display-xl\` through \`--font-micro-mono\`) with \`tabular-nums\`, optical sizing, and the dynamic tracking formula \`Tracking(S) \= \-0.032 \+ 0.42/S em\`.

   \- Implement the 4px/8px spatial grid tokens and CSS logical properties (\`margin-inline\`, \`padding-block\`) for automatic RTL support.

2\. Build the reusable primitive components in \`apps/web/src/shared/ui/\`:

   \- \`SquircleCard\` (continuous curvature mask \+ specular dark-mode hairline).

   \- \`SpringSheet\` & \`useSpringPhysics\` hook (solving \`m \* x'' \+ c \* x' \+ k \* x \= 0\` with velocity preservation on interruption).

   \- \`LogoLivingNexus\` (the golden-ratio \`24x24\` G2 continuous lemniscate SVG mark with optical center correction from Section 4.1).

3\. Implement the core screens in \`apps/web/src/pages/\`:

   \- Screen 1: Onboarding & Node Genesis.

   \- Screen 2: The Inquiry Composer with 250ms debounced Semantic Precheck and slide-up Semantic Match Sheet.

   \- Screen 4: The Empirical Answer Workspace featuring the horizontal stacked Consensus Distribution Bar, 6-token Miller's Law credibility header, Minority Outcome pinned badge, and 1-click Best Answer selector.

### Phase 8: 120Hz OffscreenCanvas WebGPU/WebGL2 Living Graph Engine & Accessibility Tree

**Estimated AI Execution Time**: \~35 minutes

Read Sections 7.1, 7.2 (Screen 3), 8.3, 18, and 20.1 of \`docs/GRAPHINITY\_BIBLE.md\`.

Task:

1\. Build the \`living-graph\` widget in \`apps/web/src/widgets/living-graph/\`:

   \- Create a dedicated Web Worker (\`graphPhysics.worker.ts\`) maintaining pre-allocated \`Float32Array\` buffers (zero GC allocations per frame) and integrating force-directed node positions with delta-time clamping for 120Hz ProMotion and 60Hz displays.

   \- Implement the 3-tier progressive renderer on \`OffscreenCanvas\`:

     \* Tier 1 (WebGPU) & Tier 2 (WebGL2 \`drawArraysInstanced\`): Signed Distance Field (SDF) circle shader with \`fwidth\` analytical anti-aliasing and GPU-computed photon pulses traveling along cubic Bézier edges from the asker node to routed expert nodes.

     \* Tier 3 (SVG fallback): Automatic fallback if WebGL context is unavailable or lost.

   \- Implement Battery & Visibility Governance: Automatically throttle to 30fps on low battery (\`level \< 0.25 && \!charging\`) and 0fps when \`document.visibilityState \=== 'hidden'\` or after 8s of pointer inactivity once pulses settle.

2\. Connect the graph widget to the backend SSE \`/pulse-stream\` endpoint so Layer 0 shifts from 18% ambient opacity to 100% active telemetry during question routing.

3\. Implement the WCAG 2.2 Synchronized Shadow Accessibility DOM (\`\<nav aria-label="Knowledge Graph Topology"\>\`):

   \- Support full keyboard graph traversal (\`Tab\`, \`ArrowRight\`/\`ArrowLeft\` by edge weight, \`Enter\` to inspect node, \`Escape\` to return) and \`aria-live="polite"\` routing milestone announcements.

   \- Honor \`prefers-reduced-motion: reduce\` by replacing traveling particle waves with calm 150ms opacity cross-fades.

### Phase 9: Technical SEO (`QAPage`), Anti-Sybil PageRank & Edge-Case Hardening

**Estimated AI Execution Time**: \~25 minutes

Read Sections 16.1, 19.1, 19.2, 21.1, and 22.3 of \`docs/GRAPHINITY\_BIBLE.md\`.

Task:

1\. Implement SSR / dynamic head rendering for canonical question URLs (\`/q/:fieldSlug/:countryIso/:questionSlug\`):

   \- Emit valid Schema.org \`QAPage\` JSON-LD (Section 19.1) populating \`mainEntity\`, \`acceptedAnswer\`, and \`suggestedAnswer\`.

   \- Emit \`\<meta name="robots" content="noindex, follow" /\>\` when \`status \=== 'ROUTING'\` and flip to \`index, follow\` once \`status IN ('ANSWERED', 'CONSENSUS\_LOCKED')\`.

   \- Implement dynamic XML sitemap shards (\`/sitemaps/questions-:field-:country.xml\`) and canonical \`301\` redirects if a question slug is accessed via a non-canonical path.

2\. Implement the background Personalized PageRank (\`PPRTrustWorker\`) in \`apps/api\`:

   \- Compute field-specific trust scores over the verified Best-Answer graph with cycle discounting (mutual A\<-\>B selections discounted by 95%) and \`/24\` subnet vote-velocity shadow dampening.

3\. Implement the GDPR / India DPDP "Delete Means Delete" endpoint (\`DELETE /api/v1/users/me\`) executing cryptographic erasure and cascade cleanup in \<500ms.

4\. Implement the 7-second Undo buffer on passing routed questions and offline \`IndexedDB\` draft persistence in \`apps/web\`.

### Phase 10: End-to-End Verification, Performance Budgets & Cloud Deployment Config

**Estimated AI Execution Time**: \~20 minutes

Read Sections 17.1, 17.2, 18, and 21.1 of \`docs/GRAPHINITY\_BIBLE.md\`.

Task:

1\. Write Playwright E2E and \`axe-core\` accessibility tests in \`apps/web/e2e/\`:

   \- Test 1: Full keyboard-only journey (Onboarding \-\> Ask Question \-\> Semantic Precheck \-\> Live Routing Graph \-\> Expert Answer \-\> Consensus Bar \-\> Select Best Answer).

   \- Test 2: Verify zero WCAG 2.2 AA violations across Light Mode, Dark Mode, and RTL (\`dir="rtl"\`).

   \- Test 3: Verify Core Web Vitals & bundle budgets (\`initial JS \< 65 KB Brotli\`, \`CLS \=== 0.000\`).

2\. Create production deployment configurations:

   \- Multi-stage reproducible \`Dockerfile\` for \`apps/api\` pinned by SHA-256 digest.

   \- \`render.yaml\` Infrastructure-as-Code blueprint for the Fastify API service and BullMQ worker service.

   \- Cloudflare Worker edge proxy script (\`infra/cloudflare/worker.ts\`) handling \`Cache-Tag\` surrogate-key caching, \`stale-while-revalidate\`, and \`CF-IPCountry\` injection.

   \- GitHub Actions CI/CD workflow (\`.github/workflows/ci.yml\`) running typecheck, lint, unit tests, Testcontainers Postgres integration tests, bundle size-limit checks, and Playwright E2E tests.

3\. Run the entire verification suite and output a final readiness report.

---

## 4\. Solving the Day-1 Cold-Start Problem (How to Launch with High Liquidity)

Even the best routing algorithm fails if a new user asks a question in `Field: Watchmaking · Country: Peru` on Day 1 when zero nodes exist in that cell. To guarantee an `85%+` Verified Resolution Rate within 4 Hours (\$VRR\_4\$) from launch day, execute this **Concentric Liquidity Seeding Strategy**:

| Launch Stage | Target Scope | Node Seeding Action | Routing Engine Configuration |
| :---- | :---- | :---- | :---- |
| **Stage 0: Private Alpha (Weeks 1–2 before launch)** | **1 Country (`India`) × 3 High-Friction Fields** (`Personal Imports & Customs`, `Study Abroad & Visas`, `Luxury Watches & Electronics`) | Recruit 150 verified practitioners from Reddit (`r/indianostalgia`, `r/watchesindia`, customs threads), Discord, and trade forums. Pre-seed 50 canonical lived-experience Q\&As by interviewing them. | Set Wave 1 size to `8` nodes and `daily_notification_budget = 5` for founding alpha experts. |
| **Stage 1: Controlled Public Beta (Month 1\)** | **3 Countries (`IN`, `US`, `AE`) × 8 Fields** | Unlock a field+country cell publicly **only when it reaches \$\\ge 25\$ active verified expert nodes**. Display a live "Cell Liquidity Meter" on locked fields so experts can join to unlock their domain. | Enable UCB1 Cold-Start Exploration (\$\\beta \= 0.12\$) so every new expert receives 2–3 questions in their first 48 hours. |
| **Stage 2: Viral Epistemic Loop (Months 2–6)** | **30 Countries × 50 Fields** | Every time a question reaches `CONSENSUS_LOCKED`, generate a clean, high-craft OpenGraph summary card (showing the Consensus Distribution Bar and top practitioners' field medals) optimized for sharing back into WhatsApp, Telegram, and Reddit threads. | Standard 11-factor routing (\$5 \\to 5 \\to 5\$ staged waves) \+ automated Schema.org `QAPage` long-tail organic search acquisition. |

