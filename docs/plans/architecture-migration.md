# Architecture migration plan

Date: 2026-10-20. Status: **approved by the owner on 2026-10-20**, with every recommendation in section 6
(the domain is decided later). Phase 0 in progress. It extends ADR 0002 (environments, one promoted build), whose Phase 1 is already
shipped.

Every limit quoted here was checked on the provider's own page on 2026-10-20; each is re-checked in
the phase that relies on it. "Free" means it suspends or refuses at its limit, never bills, and needs
no card (CLAUDE.md).

---

## 1. Where Graphinity stands today

**Stronger than most early products** (keep all of it):

- **Small surface.** The API has 4 runtime dependencies (Fastify, CORS, jose, pg), the website 2
  (React, React DOM). 30 API routes. No UI framework, no ORM, no third-party scripts.
- **Security in depth.**
  - Row-level security forced on every table, and the API connects as a restricted role.
  - Every rule enforced in both the API and the database, with tests that break each rule on purpose.
  - Parameterised SQL only (Semgrep in CI), strict request schemas (unknown fields refused,
    no type coercion).
  - Strict CSP with no inline scripts; CORS allows one origin.
  - Logs carry no URLs, headers, bodies or addresses. No `innerHTML` or `eval` anywhere.
- **Tests.**
  - About 555 unit and real-database tests, with coverage ratchets.
  - Playwright in three engines, plus axe, Lighthouse and size budgets.
  - gitleaks, osv-scanner and Semgrep in CI, plus a floor guard against silenced checks.
- **One build is promotable** (ADR 0002, phase 1).
  - The website build names no environment; a tested stamp step writes each environment's settings.
  - The API knows `APP_ENV` and `RELEASE`, and `/health` reports them.

**Gaps against the target**, each covered by a phase below:

| Area | Today | Target |
|---|---|---|
| Git flow | `ship.sh` pushes straight to `main` after local checks | Feature branches → PR → required checks → review → merge; `main` protected |
| Formatting, licences | ESLint only | + Prettier check, licence allow-list |
| Migrations | One idempotent `db/schema.sql`, pasted into Supabase by hand | Numbered forward-only migrations, applied by the pipeline, tested from empty and from the last release |
| Artifacts | Render builds the API from source per service | One image per commit, promoted by digest |
| Environments | Development only; one Supabase project used from the laptop | Development, Preview, Staging, Production, nothing shared |
| Previews | None | A deployment per PR |
| Infrastructure | Clicked by hand in dashboards | Declared in code (Terraform) where providers allow |
| Secrets | `.local/api.env` on the laptop; Render asks once | Platform-encrypted secrets per environment; laptop holds only throwaway dev values |
| Feature flags | None | Typed flags, per environment and per person, with kill switches |
| Observability | Privacy-safe logs only | Structured logs with request ids, metrics, traces, error tracking, dashboards |
| Monitoring | A keep-awake ping | Uptime checks, health, latency, error rate, job lag, database size, alerting |
| Backups | None (Supabase Free has no backups at all) | Nightly encrypted off-site dumps, monthly restore test |
| Multiple API servers | Rate limits, live updates and the minute jobs live in one process's memory | Shared state in Postgres; jobs behind locks |
| Sessions | Refresh token in sessionStorage (the domain split prevents cookies) | `__Host-` HttpOnly cookie on a custom domain |

---

## 2. Where I recommend not following the target literally, and why

These are the places where following the diagram exactly would add cost or debt instead of
removing it.

1. **Redis: not now.** Graphinity's uses for Redis (rate limits, a job queue, locks, live-update
   fan-out, caching) all work in Postgres:
   - unlogged tables for rate limits
   - `FOR UPDATE SKIP LOCKED` for queues
   - advisory locks for jobs
   - `LISTEN/NOTIFY` for live updates

   That's one fewer system to secure, back up, monitor and keep in sync per environment. Render's
   free Key Value has no persistence ([Render](https://render.com/docs/key-value)), so a restart
   would forget every limit and queued job. Many large products ran Postgres-only queues well past
   this stage.
   - **Recommendation:** put each use behind a small interface (`RateLimiter`, `JobQueue`,
     `EventBus`) backed by Postgres. Swap in Redis only when a measurement says Postgres is the
     bottleneck.
   - **Trade-off:** a later swap, if one is ever needed, against four extra environments' worth of
     Redis today.
   - Local Redis and object storage are left out for the same reason: nothing uses them yet.
2. **Preview environments: full per-PR stacks aren't free on this stack.** Render's preview
   environments need its paid Pro workspace ([Render](https://render.com/docs/preview-environments)),
   and Supabase branching isn't on Free ($0.01344 per branch-hour on paid plans,
   [Supabase](https://supabase.com/pricing)).
   - **Free design:**
     - **Website:** a Cloudflare Pages preview per PR (unlimited previews).
     - **Database:** a Neon Postgres branch per PR. Neon Free gives 10 branches per project, needs no
       card, suspends at limits, and includes pgvector ([Neon](https://neon.com/pricing)).
     - **Sign-in:** the sign-in stand-in, so reviewers sign in as test people and no Google
       credentials exist in previews.
     - **API:** one preview API slot in its own Render workspace, deployed with the PR's image and
       pointed at that PR's branch.
   - **Trade-off:** one PR's backend live at a time, which is fine for a solo founder. Parallel
     full stacks mean upgrading Render (price checked then).
3. **Monitoring vendors and privacy.** The rule "no analytics, trackers or third-party scripts"
   stays.
   - **Recommendation:**
     - **API:** OpenTelemetry to **Grafana Cloud Free**. It covers logs, metrics and traces, uptime
       checks, and alerting. Free tier: 10k metric series, 50 GB logs and 50 GB traces a month, 14
       days' retention, 100k API checks a month, "no charges ever"
       ([Grafana](https://grafana.com/pricing/)).
     - **Errors:** **Sentry** for the API only (5k errors, one user, 30 days on Developer,
       [Sentry](https://sentry.io/pricing/)), with personal data scrubbed before sending.
     - **Browser errors:** sent to our own API (first-party), which forwards them scrubbed. No
       third-party script ever loads in a visitor's browser.
   - **Trade-off:** two vendors instead of one, and the privacy page must name them. That's the
     owner's decision.
4. **Backup storage needs a no-card home.** Cloudflare R2's free tier reportedly asks for a card
   and bills past it ([community](https://community.cloudflare.com/t/why-using-r2-free-tier-involves-giving-card-info/945179)),
   which our rule doesn't allow.
   - **Recommendation:** nightly `pg_dump`, encrypted with a key only the owner holds, pushed by
     Actions to a separate **private** GitHub repository. That's free, needs no card, and is fine
     while the database is under 500 MB.
   - **Trade-off:** git isn't made for backups. Move to object storage when size or policy demands
     it.
5. **Infrastructure as code where providers allow, and honestly no further.**
   - **Can be declared:** Cloudflare, GitHub and Render (official provider,
     [Render](https://render.com/docs/terraform-provider)), Neon, and probably Supabase's project
     settings (provider to verify).
   - **Can't be declared:** Google OAuth clients (no supported API for consent screens and clients),
     plus first-time account creation. These stay as click-by-click steps in SETUP-ACCOUNTS.md.
   - **Terraform rather than Pulumi:** it has more official providers, including Render's; it's
     the industry default reviewers know; and plans are readable diffs. Pulumi's appeal (TypeScript)
     matters less for about 30 resources.
   - **Trade-off:** state needs a safe home (HCP Terraform's free tier, to verify), and every
     dashboard change must go through code from then on.

---

## 3. Target design

### 3.1 Environments (nothing shared)

| | Development | Preview (per PR) | Staging | Production |
|---|---|---|---|---|
| Website | Vite on your computer | Pages preview URL | Pages project `graphinity-staging` | Pages project `graphinity` (+ custom domain) |
| API | Node on your computer | Render, preview workspace | Render, staging workspace | Render, production workspace |
| Database | Local Postgres (`db.sh`) | Neon branch, deleted on merge/close | Supabase project A (the existing one) | Supabase project B (new, never on a laptop) |
| Sign-in | Local stand-in | Stand-in (test people) | Supabase A + Google client "staging" | Supabase B + Google client "production", own Google Cloud project |
| Secrets | Generated, throwaway, in `.local/` | Generated per PR by CI | GitHub Environment `staging` + Render/Pages dashboards | GitHub Environment `production` (approval required) + dashboards |
| Data | Test data, resettable | Seeded fixtures | Seeded + QA accounts | Real people |

**Local secrets differ in kind, not just value:**
- Development secrets are random throwaways made by `db:start`, valid only against local services.
- Staging and production secrets are made once per environment, live only in that platform's
  encrypted store, and are never typed into chat, files or the laptop.
- The production database password exists only in Render (runtime) and in the production GitHub
  Environment (migrations), which needs the owner's approval for every run.

### 3.2 Pipeline

```
feature branch ──push──▶ CI: install · Prettier · ESLint · types · unit · integration ·
                         migrations (empty→latest, last release→latest) · build · size ·
                         Playwright (3 engines) · Lighthouse · gitleaks · osv (vulns + licences) ·
                         Semgrep · CodeQL · dependency review
               ──PR────▶ Preview: Neon branch + preview API (PR image) + Pages preview; smoke tests
               ──review + all checks green──▶ merge (squash) to protected main
main ──────────▶ build ONCE: website dist (neutral) + API image (digest) + migration bundle,
                 attested; tagged with the commit
               ──▶ Staging: migrate → deploy digest → wait for /health release → stamp + upload site
                   → smoke + k6 load test + migration check
               ──manual QA (Google login, moderation, routing) + owner approval──▶
                 Production: migrate → same digest → /health → same dist, stamped → smoke →
                 tag vYYYY.MM.DD.N + GitHub Release notes
rollback ──────▶ promote the previous release's digest and dist (migrations are expand-only)
```

**Required checks:** nothing merges unless every check above passes. `main` accepts only PRs: no
force pushes, linear history.

### 3.3 Database workflow

- **Migrations:**
  - `db/migrations/0001_baseline.sql`: today's schema, version 16.
  - Then one forward-only file per change, recorded in `app.schema_migrations`.
  - Each runs in a transaction with a lock timeout.
  - Expand/contract: add, backfill and switch in one release; drop in a later one.
  - A lint step refuses `DROP` or `RENAME` without an explicit contract marker.
- **Validation:**
  - CI applies the migrations to an empty database, and to a copy of the last release's schema.
  - CI checks the result equals the declared schema (diff of `pg_dump --schema-only`).
  - Staging is always migrated first.
- **Rollback:** code rolls back by re-promoting. Schema changes don't roll back, because they're
  additive, so old code still works with them. A bad migration is fixed forward with a new file.
  This is the practice at most large SaaS companies, since down-migrations on live data are
  where data gets lost.
- **Backups:** nightly encrypted dumps of staging and production, kept 30 days. Before every
  production migration, a fresh dump.
- **Restore test:** monthly, CI restores the latest production dump into a throwaway Postgres,
  runs the migration check and smoke queries, and reports. A backup that was never restored isn't
  a backup.
- **Versioning:** `/health` already reports `schemaVersion`. The pipeline refuses to deploy code
  that needs a newer schema than the target has.

### 3.4 Testing pyramid

| Layer | What belongs there | Where today |
|---|---|---|
| Unit | Pure logic: scoring, consensus, reputation, text rules, settings, stamping, springs | ✅ Vitest, both apps |
| Integration | One module against real Postgres: RLS, constraints, triggers, policies, role permissions | ✅ (API) |
| API | HTTP contracts: schemas, error codes, auth required, rate limits, CORS, headers | ✅ partly; add an OpenAPI contract check |
| Authentication | Token checks (issuer, audience, expiry, nonce), refresh, sign-out, deletion, roles | ✅ web `auth.test.ts`, API token tests; add cookie-session tests in phase 7 |
| Migration | Empty→latest, last release→latest, schema diff, destructive-change lint | ○ phase 2 |
| End-to-end | Real browsers through user journeys; accessibility (axe), widths, keyboard | ✅ Playwright ×3; split the 851-line spec by journey |
| Performance | Lighthouse budgets, bundle size; k6 load tests against staging; slow-query check | ✅ / ○ k6 in phase 8 |
| Security | Semgrep, CodeQL, gitleaks, osv, dependency review; attack tests in integration | ✅ / ○ CodeQL and dependency review |

### 3.5 Observability and how a problem gets diagnosed

- **Logs:**
  - JSON lines with route pattern, status, duration, a **request id**, the trace id,
    `environment` and `release`. Never personal data, as today.
  - Shipped from Render to Grafana Loki.
- **Metrics (RED + USE):**
  - Per route: requests, errors and latency (p50, p95, p99).
  - DB pool in use, query time, live-update connections.
  - Job lag (oldest due routing wave), Workers AI quota left, database size against 500 MB.
- **Traces:** OpenTelemetry spans: request → each SQL query (statement name only) → outbound calls
  (Supabase, Workers AI, push).
- **Errors:** Sentry with release tagging, so an error points to the commit that introduced it.
- **Example diagnosis.** An alert fires: "p95 latency over 800 ms on `POST /questions` for 5
  minutes". The dashboard shows which release and route. A trace from that window shows the time is
  in the `nearest_questions` query. Its metric shows it started at the last release. The database
  dashboard shows index misses. The fix is to roll back by re-promoting the previous release, then
  fix forward.

### 3.6 Monitoring and alerting

- **Uptime:** website and `/health` from several regions every minute (Grafana synthetics).
- **Alerts** go to email or phone through Grafana's free alerting, each linking its runbook:
  - `/health` failing for 2 minutes
  - `schemaVersion` or `release` not matching what was deployed
  - error rate over 1%
  - p95 over budget
  - routing job lag over 5 minutes
  - database over 80% of its size
  - Render hours over 90% of the month
  - backup older than 26 hours

### 3.7 Security review

**Good today:** everything listed in section 1.

**Improvements:**

1. **Sessions.** The refresh token in sessionStorage can be read by injected script. On a custom
   domain (site and API same-site), the API sets the refresh token as a `__Host-` HttpOnly,
   Secure, SameSite=Lax cookie (backend-for-frontend). The access token stays in memory.
   Supabase's refresh-token rotation with reuse detection does the rest (to verify).
   **CSRF:** today there is none to defend against (bearer tokens only). With the cookie: SameSite,
   plus an `Origin` check, plus a CSRF header on state-changing requests.
2. **Trusted Types** in the CSP (`require-trusted-types-for 'script'`). There are no DOM sinks
   today; this keeps it that way.
3. **Rate limits shared across servers** (Postgres), plus Cloudflare's edge rate limiting in front
   of the API (free rules, to verify).
4. **GitHub (free on public):** secret scanning with push protection, Dependabot alerts, CodeQL,
   dependency review on PRs, branch protection, signed release attestations.
5. **Roles.** Generalise `app.moderators` to `app.roles` (moderator, admin) with an append-only
   audit log of every role change and moderation action. The production role grant is approved
   through the pipeline, not pasted by hand.
6. **`security.txt`, CSP violation reports** to our own endpoint, and a written key-rotation
   runbook (Supabase keys, VAPID, IP hash key).

### 3.8 Authentication in production

- Google OAuth through Supabase Auth, one OAuth client per environment. Production's sits in its own
  Google Cloud project, with its own verified consent screen.
- Sign-in flow as today (ID token, nonce, state, `openid email` only). After that, the refresh
  cookie per 3.7, access tokens short-lived and verified on every request, refresh on expiry and
  on focus, and sign-out revokes the session in Supabase.
- **Trust system unchanged.** Moderators are the roots of graph trust (ADR 0001); the roles audit
  log makes those roots accountable.

### 3.9 Scalability

- **API servers:** stateless once phase 6 moves rate limits, live updates and jobs into Postgres.
  Then the number of servers is a setting.
- **Database:** HNSW and full-text indexes hold to millions of rows. Two known hotspots:
  - The routing query scans every member of a field per wave. Precompute per-person field stats
    in a table updated by triggers or jobs.
  - Supabase's pooler, in transaction mode, for many servers.
  - Partition `routes` by month once large. Archive old routes.
- **Caching:** CDN for the static site (already). Short-lived per-instance caches stay
  (`/graph`, `/meta`). Add HTTP caching headers for public question pages at the edge.
- **Jobs and queues:** one `jobs` table with `SKIP LOCKED` workers, retries, dead-letter state and
  lag metrics, replacing `setInterval`.
- **Search:** Postgres hybrid search to millions of questions. Revisit only with measurements.
- **Object storage:** none needed (no uploads). If profile photos ever arrive, R2 or similar,
  behind an interface.

### 3.10 Feature flags

- In-house, because a third-party flag service would be another vendor seeing traffic.
- Flags declared in code with a type and an owner. Values live in an `app.feature_flags` table per
  environment: on, off, moderators only, a percentage of people (stable hash), or a list of people.
- The API evaluates flags and sends the client only its own results. Every flag doubles as a kill
  switch.
- Unfinished work merges behind a flag that is off in production. Flags older than 90 days fail a
  lint until removed.

### 3.11 Branches and releases

- **Trunk-based:** short-lived branches (`change/…`, made by `ship.sh`), a PR for every change,
  **rebase-merged** into protected `main`. Rebase rather than squash, because each one-concern commit
  and its message are part of the record.
- Every merge is a release candidate. Production releases are tagged `vYYYY.MM.DD.N`, with
  release notes generated from merged PRs.
- `ship.sh` becomes "check, commit on a branch, push it, print the PR link". No GitHub CLI needed:
  the PR is opened and merged on GitHub.

---

## 4. Technical debt found (fix before more features)

| # | Issue | Risk | Fix (phase) |
|---|---|---|---|
| D1 | Rate limits, live-update bus and minute jobs in one process's memory | A second server would double routing waves and split rate limits | Postgres-backed interfaces, advisory locks (6) |
| D2 | Hand-applied single schema file | Drift between environments; no upgrade test | Migrations (2) ✅ done |
| D3 | `/questions/similar` kept "for older clients" next to the precheck | Two search paths to secure and keep correct | Remove after checking no client calls it (2) ✅ done |
| D4 | "Helped" and pick counts written as separate SQL in `points.ts` and `routing.ts` | They can drift and score people differently | One shared query or view (6) |
| D5 | Contact-details rules written twice (TypeScript and SQL), on purpose | They can drift | One shared case list run against both (6) |
| D6 | One 851-line Playwright file; test data piles up across runs (it caused flaky tests this week) | Slow, flaky, hard to review | Split by journey; fresh database per run (3) |
| D7 | Routing SQL scans every field member with correlated subqueries | Slow in big fields | Precomputed per-person stats (8) |
| D8 | Hand-written `API.md` | Docs drift from the code | OpenAPI generated from the route schemas; contract test (8) |
| D9 | Ten documents with overlap (PLAN, BUILD_PLAYBOOK, SPEC, ADRs, GRAPH, RUNBOOK…) | Hard to onboard | Docs structure in 4.1 |
| D10 | Refresh token in sessionStorage | XSS could read it | Cookie session on a custom domain (7) |
| D11 | Bundle-size ratchet raised nine times recently | Gradual bloat | Review the graph chunk; hold the line (8) |

### 4.1 Documentation (target)

- `docs/ARCHITECTURE.md`: one picture and how the parts talk.
- `docs/ONBOARDING.md`: zero to a running app in 15 minutes.
- `docs/DEVELOPMENT.md`: local setup and daily commands (from today's RUNBOOK).
- `docs/DEPLOYMENT.md`: pipeline, promotion and rollback.
- `docs/ENVIRONMENT.md`: every setting, per environment.
- `docs/OPERATIONS.md`, with `docs/runbooks/`: health failing, high latency, restore a backup,
  rotate a key, bad migration, Render hours, Workers AI quota.
- SECURITY, API (generated) and ADRs, as today.
- `BUILD_PLAYBOOK.md` moves to `docs/archive/`.

---

## 5. Phases (each ships alone and leaves everything working)

Ordered so the riskiest gaps close first and nothing waits on accounts until it must.

| Phase | Content | Needs from the owner |
|---|---|---|
| 0 | Repository made public. Branch protection and required checks on `main`. PR-based workflow (`ship.sh` opens PRs). Prettier (one formatting commit, hidden from blame). Licence check. CodeQL, dependency review, secret scanning with push protection, Dependabot alerts | Flip to public (steps given). OK to install the GitHub CLI |
| 1 | ✅ Done: environments in code, neutral build, stamp step | — |
| 2 | ✅ Done: migrations (runner, baseline, CI upgrade-equals-fresh check, destructive-change lint; `db/migrations/README.md`). `/questions/similar` removed | — |
| 3 | API image (pinned, non-root, attested, scanned). Release workflow building website dist, image and migration bundle **once** per `main` commit. Split the E2E file; fresh database per run | — |
| 4 | Infrastructure as code (Terraform) for GitHub, Cloudflare, Render, Neon and Supabase settings. Staging and production created from it. GitHub Environments with secrets and production approval | Accounts: Supabase production project, two Render workspaces, Google OAuth clients (click-by-click) |
| 5 | Pipeline: staging auto-deploy, smoke tests, manual-QA checklist, approved production promotion, rollback, release tags. Per-PR previews (Neon branch + preview API slot + Pages preview) | Approve the first promotion |
| 6 | Scale readiness: Postgres job queue with locks, LISTEN/NOTIFY events, shared rate limits behind interfaces. Feature flags. Shared queries (D4, D5) | — |
| 7 | Security: custom-domain cookie sessions with CSRF checks, Trusted Types, roles plus audit log, `security.txt`, CSP reports, rotation runbook | Buy a domain (your decision; price checked then) |
| 8 | Observability (OpenTelemetry → Grafana, Sentry for the API, first-party browser errors). Monitoring and alerts. Nightly encrypted backups with monthly restore test. k6 load tests on staging. OpenAPI. Routing precompute. Docs restructure. First production release | Grafana, Sentry and backup-repo accounts; privacy-page wording |

## 6. Decisions only the owner can make

1. **Redis:** Postgres-backed interfaces now, Redis only when measured (recommended), or Redis in
   every environment from the start.
2. **Previews:** a free single preview backend (recommended), or parallel full stacks on paid
   Render (price checked then).
3. **Error tracking:** Grafana plus Sentry for the API only, with browser errors first-party
   (recommended); or Grafana only. Either way, the privacy page names them.
4. **Backups:** encrypted dumps in a private GitHub repository (recommended, free, no card), or
   object storage that needs a card.
5. **A custom domain:** needed for cookie sessions (phase 7) and clean production addresses.
6. **Infrastructure as code:** Terraform (recommended) or Pulumi.
