# Runbook

How to run, test and (later) deploy Graphinity. Keep this current: if a step changes, change it here
in the same commit.

## First time on a Mac

1. Install Node 24 with nvm: `nvm install 24` (the repo's `.nvmrc` says 24; run `nvm use` in the
   project folder).
2. Install Postgres: `brew install postgresql@17` (17 matches Supabase; 18 also works locally).
3. Install dependencies exactly as locked. Install scripts are disabled by `.npmrc`:

   ```bash
   npm ci
   ```

## Every day

| What | Command |
|---|---|
| Start the local database (creates it the first time) | `npm run db:start` |
| Apply new migrations to the local database (`db/migrations`) | `npm run db:apply` |
| Run the local sign-in stand-in (replaces Google + Supabase Auth) | `npm run dev:auth` |
| Run the API against the local stand-in (no accounts needed) | `npm run dev:api:local` |
| Run the API against your real Supabase project (values in `.local/api.env`) | `npm run dev:api` |
| Run the website on http://localhost:5173 | `npm run dev:web` |
| Design gallery (development only) | http://localhost:5173/design |
| All tests | `npm test` |
| Typecheck | `npm run typecheck` |
| Neutral production build | `npm run build` |
| Cloudflare Pages build (from `apps/web`) | `npm run build:pages` |
| Production build served with production headers | `npm --workspace apps/web run preview` (port 4173) |
| Stop the local database | `npm run db:stop` |

`npm run db:start` writes two private files in `.local/` (git-ignored, readable only by you):
`api.env` (the API's database login and hashing key) and `test.env` (for integration tests).
The database's own files live in `~/.local/share/graphinity`, outside the project: this project sits
in an iCloud-synced Documents folder, and iCloud emptied and locked Postgres's files until it
crashed. If the project's tools ever fail oddly (a package "has no exports", a command hangs), check
for emptied files with `ls -lO node_modules/vitest/package.json`: `dataless` means iCloud emptied it,
and `npm ci` rebuilds them in seconds. The lasting fix is to keep the project out of iCloud.

To use the real Supabase project and Google instead of the stand-in, put the project's public
values in `apps/web/.env.supabase`, put `SUPABASE_URL` and the secret key in `.local/api.env`, and
start the website with `npm --workspace apps/web run dev -- --mode supabase` (don't run
`dev:auth`). Never paste the secret key into chat or a Terminal command; edit the file with
`open -e .local/api.env`.

Starting servers from an app or editor instead of a terminal (the Claude app's preview uses
`.claude/launch.json`): they don't load nvm, so they would get this Mac's Node 20, and the API
can't run on it. `node scripts/node24.mjs <command>` runs any command on Node 24 and says plainly if
Node 24 isn't installed. The launcher's API and sign-in stand-in keep their ports (3000, 54321) or
fail, since the website only looks there.

If the website says "Graphinity isn't responding", the API isn't running or can't be reached; it
says "You're offline" only when the device has no internet. Either way it tries again by itself once
the connection is back.

Search by meaning needs **pgvector** in the local Postgres. Homebrew has no ready build for macOS 27
yet, so it was built from the project's official source once (2026-10-19, v0.8.1):

```bash
cd "$(mktemp -d)" && curl -sSfLO https://github.com/pgvector/pgvector/archive/refs/tags/v0.8.1.tar.gz
```

then `tar -xzf v0.8.1.tar.gz && cd pgvector-0.8.1 && make PG_CONFIG=/opt/homebrew/opt/postgresql@18/bin/pg_config && make install PG_CONFIG=/opt/homebrew/opt/postgresql@18/bin/pg_config`.
`npm run db:start` then turns the extension on in schema `extensions`, as Supabase's dashboard does.
CI uses the pgvector project's own Postgres 17 image.

To try sign-in locally, run `db:start`, then `dev:auth`, `dev:api:local` and `dev:web` in three
terminals, and open http://localhost:5173. "Continue with Google" opens a local page where you pick
a test person. To try the production build with its strict security headers, run
`npm --workspace apps/web run build`, then `preview` (it stamps this computer's settings into
`dist-local` and serves that), and start the API with
`WEB_ORIGIN=http://localhost:4173`. Restart `preview` after changing headers: it computes them once
at startup.

Changed the logo (`apps/web/public/icon.svg`)? Run `node scripts/make-images.mjs` to redraw the PNG
icons and the link-preview image, look at them, and commit them.

To try notifications locally, add push keys once with `node scripts/vapid-keys.mjs .local/api.env`,
restart the API, then use "Turn on for this device" on your profile. Chrome and Firefox deliver
pushes through Google's and Mozilla's push services even locally; Safari on iPhone needs the site on
the Home Screen.

## Tests

- **Unit tests** cover pure logic: rate limiting, config checks, springs, squircles, headers.
- **Server tests** run the real server in memory with a fake database.
- **Integration tests** create a throwaway database, apply the schema twice, connect as a
  restricted login role exactly like production, and check what that role can and cannot do.
  They need the local database running. They fail, never skip, when it isn't.

- **Browser tests** (`npm run test:e2e`) drive the production build in Chromium and WebKit
  against the real API and the sign-in stand-in, with axe, every width from 320 to 1280 and tap
  targets. `AUDIT_SHOTS=1` also saves screenshots. One file per journey in `apps/web/e2e`
  (`screens`, `answers`, `moderation`, `resilience`, `graph`), sharing `helpers.ts`.
  Each run gets its own fresh database, `graphinity_e2e`, made by `scripts/e2e-api.mjs`
  (dropped, created, migrated as a Supabase-shaped owner, new API login each time): nothing a
  test writes outlives the run, and your development database is never touched. It starts the
  local database server itself if it isn't running. Never point them at the real Supabase project.
- **Lighthouse** (`npm run check:perf`) builds the site, serves it on port 4174 with the API on
  3000, and measures it like a visitor would. It refuses to start if something already uses either
  port, since it would measure that instead.

When adding a rule that matters, break it on purpose, confirm a test fails, and then restore it.

## Changing the code: branches and pull requests

`main` changes only through pull requests, merged on GitHub once every check has passed
(docs/plans/architecture-migration.md, phase 0).

1. **Ship a change:** `sh scripts/ship.sh <message-file> <paths…>`.
   - It runs every check first, then commits only the listed paths (`.` for all of them).
   - It refuses when other files have changes, because the checks would then have tested something
     other than the commit: list them too, or stash them first.
   - From `main`, it starts a branch named after the message's first line (`change/<date>-<words>`).
     On a branch, it adds the commit there: one pull request can hold several one-concern commits.
   - It pushes the branch only if the floor guard agrees, and prints the pull request link.
2. **Open the pull request** from that link. CI runs on it: format, lint, types, tests, migrations,
   build, browsers, scanners.
3. **Merge on GitHub** with **Rebase and merge**, once every check is green. That keeps each commit
   and its full message, which are part of the record. Then delete the branch (GitHub offers to).
4. **Back on your computer:** `git switch main && git pull --ff-only`. `ship.sh` refuses to start a
   new branch from an out-of-date `main`.

Once on a new computer: `git config blame.ignoreRevsFile .git-blame-ignore-revs`, so `git blame`
skips formatting-only commits.

## Schema changes

- Add a numbered file to `db/migrations` (how, and the rules, in its README). Never edit one that
  has shipped; CI refuses it.
- Removing or renaming takes two releases (expand, then contract); the lint refuses it otherwise.
- If the API depends on the change, raise the version in `app.schema_meta` (now 16).
- Every new table needs `ENABLE` and `FORCE ROW LEVEL SECURITY`, explicit grants to `app_api`,
  and policies. The integration test fails if RLS is missing.

## Kill switches (feature flags)

Parts that can be switched off without a deploy, from the Supabase **SQL Editor**. Every server
picks a change up within 30 seconds and logs `feature flag changed`. Off is always a working state.

| Flag | Off means |
|---|---|
| `embeddings` | No meaning from Graphinity's own model; the Ask check and Search match by words only |
| `search` | `POST /search` (the Search screen) refuses with `search_off`; the Ask check keeps working |
| `learned_search_ranking` | Off by default. On: a learned search ranking serves once one has won online, and candidates are compared by interleaving recorded searches. Off: fusion orders results and nothing is interleaved; training still runs |
| `push` | No notifications to devices; everything still shows on the site |
| `model_training` | No daily training of Graphinity's own models (text and spelling); serving versions keep serving |

```sql
UPDATE app.feature_flags SET enabled = false, note = 'slow searches, 2026-10-26', updated_at = now()
WHERE name = 'search';
SELECT name, enabled, note, updated_at FROM app.feature_flags;
```

The API can read the flags but never change them. If the database can't be reached, servers keep
the last values they read. A new flag is a migration (see `0002_feature_flags.sql`) plus its name
in `apps/api/src/flags.ts`.

### Measuring search

- `node scripts/benchmark-search.mjs [questions]`: quality and per-stage latency, engine only.
- `node scripts/load-search.mjs [questions]`: the real server under 1, 8 and 32 concurrent searches.
- `node scripts/benchmark-ann.mjs`: index recall and speed.
- `node scripts/benchmark-ltr.mjs`: learning from clicks.

Each needs `npm run db:start`, creates its own scratch database and drops it.

### Operations: request metrics, SLOs and job health

The server counts every response by route pattern and saves the counts once a minute (ADR 0020). A
moderator sees them on the Operations screen (Profile → Operations, or `GET /ops/status`):

- the availability (99.5%) and latency (95% within 500 ms) objectives over 30 days;
- the error budget left, and the alerts firing;
- the slowest routes;
- each background job's last success and failure.

The same numbers in SQL:

```sql
SELECT job, healthy_hint, last_success_at, last_failure_at, last_error_kind, runs, failures
FROM (SELECT *, coalesce(last_success_at, last_started_at) > now() - make_interval(secs => 2 * expected_seconds)
             AND (last_failure_at IS NULL OR last_failure_at < last_success_at) AS healthy_hint
      FROM app.ops_jobs) j ORDER BY job;
```

**Alerts:** every 5 minutes, new problems are pushed to every moderator's devices: a page-level SLO
alert, or a job that isn't working. To receive them, turn on notifications on your profile. They
need the VAPID keys and the `push` switch, like every notification. The same problem repeats at
most every 6 hours while it lasts. The `alerts` job shows on Operations like any other.

**What to do:**

- **An unhealthy job:** read its log lines (`<job> failed`, with the error's kind).
- **A page alert:** look at the slowest routes and failures first; a burst of 5xx after a deploy
  means rolling back on Render.
- **A free uptime check:** wakes the sleeping instance and tells you when it's down. Point one
  (e.g. UptimeRobot's free plan) at `/health`. It's an account of yours, so it's your call.

`node scripts/benchmark-ops.mjs` re-measures the recorder and the histogram (no database).

### Drift monitoring

Daily, 30 minutes after start (logged as `drift monitor`, one line per model with its version, the
features that drifted and the largest PSI). Watched: `routing`, `search-ranker` and
`text-embedding` (word coverage and similarity to its training questions, ADR 0019). Drift starts training straight away; the usual gates
still decide what serves (ADR 0018). The last measurements:

```sql
SELECT model, version, feature, round(psi::numeric, 3) AS psi, p, n, drifted, measured_at
FROM app.ml_drift WHERE measured_at > now() - interval '2 days' ORDER BY model, feature;
```

A feature that keeps drifting while new versions keep failing their gate means the world changed in
a way the model can't learn yet: read its versions' reasons in `app.ml_models`.
`node scripts/benchmark-drift.mjs` re-measures the rule (no database).

### Collusion review

Runs daily, 20 minutes after start (logged as `collusion review`, with `found` and `added` counts).
Groups appear on the Review page; nothing happens to anyone until a moderator decides (ADR 0017).
To see where groups stand:

```sql
SELECT status, count(*) FROM app.collusion_groups GROUP BY status;
```

`node scripts/benchmark-fraud.mjs [accounts]` re-measures the detector on planted rings (no database).

### The learned search ranking

Training runs daily (logged as `model training`, model `search-ranker`). The judge runs hourly while
`learned_search_ranking` is on (logged as `search judge`, with decided searches, people and the 99%
interval). Where each version stands:

```sql
SELECT version, status, reason, metrics -> 'online' AS online, created_at, promoted_at, retired_at
FROM app.ml_models WHERE name = 'search-ranker' ORDER BY version DESC LIMIT 5;
```

To take a learned ranking out of service at once, switch `learned_search_ranking` off: fusion serves
again within 30 seconds, and nothing is interleaved.

### Search word counts

Ranking by words (BM25, migration 0020) needs to know in how many questions each word appears.
Triggers keep `app.search_lexemes` and `app.search_corpus` exact on every insert, edit and delete. Anything
that bypasses triggers (restoring a backup, a bulk load with `session_replication_role = replica`)
leaves them wrong, and word search then ranks badly or finds nothing. Recount, in the SQL Editor:

```sql
SELECT app.rebuild_search_stats();
```

Question vectors live in `app.question_embeddings` at the model's own size (128 numbers; migration
0021), searched through the `question_embeddings_128` index with `ef_search` 400. After a new text
model is promoted, the background job re-embeds every question for it, 500 a minute, newest first,
then removes older models' vectors, 5,000 a minute. While it catches up, matching by meaning sees
only the questions already re-embedded; words are unaffected. To check progress:

```sql
SELECT model, count(*) FROM app.question_embeddings GROUP BY model;
```

The recount above takes a lock that briefly holds back new questions (about half a second per 100,000 questions)
and is safe to run any time. Each response from `POST /search` and `POST /questions/precheck`
carries a `Server-Timing` header (`embed`, `words`, `meaning`, `fetch`, in milliseconds), visible in
the browser's network panel, to see which stage is slow.

## Consent and personal graph

The API drains up to 100 pending personal graph events immediately at startup and every 15 seconds.
Successful batches log only the projected count; failures log a sanitized error kind and are retried
on the next pass. The database function uses `SKIP LOCKED`, so multiple API instances may drain in
parallel. Once a minute the API logs aggregate queue depth and the oldest event age. A backlog older
than five minutes is a warning; configure the hosting provider's log alert for
`personal graph projection queue lag exceeded five minutes`. This is a structured-log warning, not
a built-in SLO dashboard or paging integration. Signal expiry still runs hourly; expired evidence
edges cascade when their source events are deleted.

Migration `0003_consent_controls.sql` adds the purpose inventory, private current settings, and an
append-only audit table. Optional categories default off. Migration `0004_personal_knowledge_graph.sql`
adds user-owned graph records. The database enforces RLS and refuses graph inserts unless the
category is enabled; disabling a choice prevents future writes and personalization use. Existing
records stay visible to their owner for inspection and removal. The API currently offers individual
node deletion, and account deletion cascades all consent and graph records.

Personal signal events expire within 365 days. `interaction_history` captures typed question, answer,
selection, helpful, and report actions without content text. Separate `search_history` stores opted-in
search text (from the Ask check and the Search screen), and `reading_history` stores opted-in
question identifiers (reading time only under `search_improvement`, ADR 0015). Question vectors are
computed on Graphinity's own server for every question, from public text, as the word index is
(migration 0019); they no longer depend on `ai_personalization`. Revocation stops future capture; events
remain visible and removable by their owner. The API runs a narrow
database-owned purge function
on startup and hourly; it deletes only expired events and logs only the number removed. If the purge
fails, it retries on the next hourly run and does not affect requests.

To check schema readiness, inspect `GET /health` for schema version 29. Do not manually edit a
user's consent rows in SQL; a manual change bypasses the user's authenticated action and audit flow.
For incident response, the owner can turn off the `embeddings`, `push`, or `recommendations` kill
switches as above. Turning off recommendations stops the scoring query globally; per-user consent
remains an independent control.
Consent categories are not feature flags: disabling consent is per user and must be respected by
every future collector and recommender at the data-use boundary.

New routed questions have a seven-second recipient-only pass/undo window. The selected routing score,
field expertise weight, country-based local-time fit and diversity fit are saved with algorithm
version 1 and returned only to the recipient. Older routes have null snapshots. See `docs/GRAPH.md`
for the score definition and complexity notes.

The finite `For you` list uses `feed_personalization` as its own default-off choice. `feed-rrf-v2`
fuses bounded PostgreSQL source rankings for selected fields, lexical search matches, related
questions from consented views, and recency using reciprocal-rank fusion (`1 / (60 + rank)`). Each
result explains its strongest source; no click or engagement optimization is used, and the response
is not retained. Revoking search or reading consent immediately removes that source from the query.
The bounded 2,450-candidate in-process algorithm benchmark is `node scripts/benchmark-recommendations.mjs`;
it excludes database and HTTP latency. Changing the formula requires a version change and evaluation
against judged fixtures.

Current limitations: graph nodes are user-entered/imported records; purchase, travel, and learning
event capture are not wired. Feed RRF is a deterministic rank-fusion algorithm, not a trained or
adaptive model. It has synthetic benchmark latency but no production DB/API latency or relevance
measurement. Partner sharing, enterprise aggregate products, and differential privacy are not
implemented. Routing and recommendation values are retrieval scores, not calibrated predictions;
ranking changes require a new algorithm version and judged-data evaluation.

## Graphinity's own models

Trained daily from consented public posts, on a worker thread (ADR 0010). To see every version and
why it was or wasn't promoted, in the Supabase SQL Editor:

```sql
SELECT version, status, reason, metrics ->> 'mrr' AS mrr, baseline ->> 'mrr' AS baseline_mrr,
       dataset ->> 'trainingDocuments' AS documents, created_at
FROM app.ml_models WHERE name = 'text-embedding' ORDER BY version DESC;
```

Spelling correction (ADR 0011) trains in the same daily run; its versions are `name = 'spelling'`:

```sql
SELECT version, status, reason, metrics ->> 'precision' AS precision, metrics ->> 'recall' AS recall,
       metrics ->> 'typos' AS test_typos, params ->> 'lambda' AS lambda, params ->> 'mu' AS mu, created_at
FROM app.ml_models WHERE name = 'spelling' ORDER BY version DESC;
```

Logs show `model training` with the model, status and scores (numbers only). To benchmark on this
machine: `node scripts/benchmark-text-embedding.mjs 10000 50000` and
`node scripts/benchmark-spelling.mjs 2000 10000 40000`.

Learned routing (ADR 0013) trains in the same daily run, as `name = 'routing'`. Its reason says why
a version was refused (too few askers, trust not varied yet, not better than Ψ by enough):

```sql
SELECT version, status, reason, metrics ->> 'candidateAuc' AS auc, metrics ->> 'psiAuc' AS psi_auc,
       metrics ->> 'askers' AS askers, dataset ->> 'modelRankedRoutes' AS model_ranked, created_at
FROM app.ml_models WHERE name = 'routing' ORDER BY version DESC;
```

A promoted version serves only while the owner turns `learned_routing` on (SQL editor:
`UPDATE app.feature_flags SET enabled = true, note = 'why', updated_at = now() WHERE name =
'learned_routing';`). Off again, the next routing run (within a minute) uses Ψ for everyone.
Benchmark: `node --expose-gc scripts/benchmark-routing.mjs`.

Routing exploration (ADR 0014) acts only with a routing model serving and the owner's
`routing_exploration` switch on. The daily `routing monitor` log line gives the serving model's
calibration (z), how many last places exploration decided and explored, and the SNIPS estimate of
never exploring against what was got. A `routing model retired` warning means automatic demotion
took the model out (routing is back on Ψ). Decisions in the SQL editor:

```sql
SELECT explore_reason, count(*), avg(propensity) AS mean_propensity, avg(predicted) AS mean_predicted
FROM app.route_factors WHERE explore_reason IS NOT NULL AND recorded_at > now() - interval '7 days'
GROUP BY explore_reason;
```

Benchmark: `node scripts/benchmark-exploration.mjs 12` (the policy comparison).

Personal graph analysis (ADR 0012) logs `graph analysis` with its time in ms and how many are
waiting, and `graph analysis busy` when it refuses with 503. Sustained `busy` means the one worker
can't keep up: look at the times first. To compare the algorithms with v1 on planted graphs:
`node --expose-gc scripts/benchmark-graph-algorithms.mjs`.

## Deploy

Order matters: **database, then server, then website.** A website that needs a new API must not
go live before that API does. The owner's click-by-click steps are in SETUP-ACCOUNTS.md (Parts G–I);
this is the order and what to check.

1. **Database.** `npm run db:migrate:remote`, with the owner's connection in
   `.local/migrate.env` (SETUP-ACCOUNTS.md, Part I). It prints each migration it applied and the
   schema version. Not the SQL editor any more: the runner keeps the record of what ran.
2. **API login role**, once per environment, with a password generated on your computer and stored
   only in Render: `CREATE ROLE graphinity_api LOGIN PASSWORD '…' IN ROLE app_api;`
3. **Server on Render** from `render.yaml` (free plan, Singapore; deploys only after CI passes).
   It asks once for each secret: `DATABASE_URL` (the restricted role, Supabase's session pooler),
   `IP_HASH_KEY` (`openssl rand -hex 32`), `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `WEB_ORIGIN`,
   and the push keys (`node scripts/vapid-keys.mjs <file>` on your computer, then copy both). Set
   `TRUST_PROXY_HOPS=0` for the first start. The server refuses to start with anything missing or
   unsafe, and refuses an owner or superuser database login.
4. Check `GET /health` returns `{"status":"ok","schemaVersion":N}` with the version from step 1.
5. **Measure the proxy hops** (SECURITY.md) and set `TRUST_PROXY_HOPS` to that number. Until then
   every visitor shares one rate-limit allowance.
6. **Website on Cloudflare Pages**: set the Pages project's **Root directory** to `apps/web`,
   **Build command** to `npm run build:pages`, and **Build output directory** to `dist-pages`.
   Configure `VITE_SITE_ORIGIN`, `VITE_API_ORIGIN`, `VITE_SUPABASE_URL`,
   `VITE_SUPABASE_PUBLISHABLE_KEY`, and `VITE_GOOGLE_CLIENT_ID` in that Pages environment. The
   command first creates the neutral `dist`, then stamps a copy into `dist-pages`; missing or
   invalid deployment values fail the build instead of shipping a blank page. These five values
   are public configuration only, not secrets. Functions come from `apps/web/functions`, inside the Root directory, because Cloudflare looks for
   `functions/` there (question link previews, the readable question page, and the live sitemap; only `/q/*` and `/sitemap.xml` run them, per the built `_routes.json`).
   In the Pages project's settings choose **Fail open**, so pages still load if the free daily
   allowance of 100,000 Function requests is ever used up. For the one-build promotion flow, run
   the neutral build from the repository root and stamp each environment with
   `node apps/web/stamp-dist.ts apps/web/dist <out>` (docs/adr/0002). Add `<site>/auth/callback` to
   the Google client's redirect URIs and `<site>` to its JavaScript origins.
7. **Keep-awake**: a Cloudflare Worker from `workers/keep-awake.js` with a Cron Trigger every 10
   minutes and `API_HEALTH_URL` set.
8. **Check live**: sign in with Google (the screen should name the site), ask, answer from a second
   account, pick, turn on notifications on a phone and receive one, report and review, delete a
   test account. At 320, 375 and 430 wide plus desktop, light and dark. Response headers,
   `<site>/robots.txt`, `<site>/sitemap.xml`, `<site>/llms.txt`, and the link preview in a chat app.
   To see a question page as a crawler does (no scripts): `curl -s <site>/q/<id>` shows the question and its
   answers inside `<div id="root">`. To let Gemini answer from Graphinity, remove `Google-Extended`
   from `TRAINING_CRAWLERS` in `apps/web/seo.ts` (it also allows Gemini training).
9. **Google Search Console**: add the site and submit the sitemap.
