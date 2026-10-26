# Graphinity plan

Approved 2026-10-17. This is the record of what we agreed; change it when a decision changes.

## The product

One global graph of people. A question is routed to the people most likely to have lived
experience with it. The asker selects the most useful answer.

- Selected answer: +5 points in the question's field. Answers the asker marks helpful: +2.
- Medals per field. Trust score from the asker saying, later, whether the answer turned out correct.
- Public can read. Signing in (Google) is needed to ask, answer, report.
- Website first, installable to the home screen. A native app later reuses the same server.

## Decisions

| Topic | Decision |
|---|---|
| Audience | Global, English only |
| Address | Free `*.pages.dev` until there are enough users to justify a domain |
| Sign-in | Google only. Sign in with Apple later (needs a $99/year Apple developer account) |
| Display name | Chosen by the person. Never taken from Google |
| Country | Asked at signup, used for routing, shown as a badge on profiles |
| Minimum age | 18+ at launch. **Lawyer to confirm** before launch |
| Region | Singapore for both the server and the database |
| Photos | None in version 1 (object storage can bill with no hard cap) |
| Notifications | Live while open; web push when closed (iPhone needs Home Screen install, iOS 16.4+) |
| Changing a selection | Allowed at most 2 times per question, with a reason: turned out wrong / better answer came later / picked by mistake |
| Pair cap | The same asker can award the same answerer points 3 times per 30 days; after that selection still works, no points move |
| Trust | Counted once per distinct asker |
| Shared network | Flagged for owner review, never auto-blocked (mobile carriers share addresses) |
| Collusion rings | Found daily by measured detection (ADR 0017) and shown on the review page; a moderator decides. Confirmed: the points members gave each other are taken back, later picks between them move none |
| Moderation | Owner only. Report reasons, auto-hide after 3 distinct reports, owner review page, new-account limits (3 questions / 10 answers on day one), block |
| Account deletion | Deletes sign-in, profile, questions, answers, subscriptions. Points others already earned stay, with no link back |

## Cost rule

Everything is on free tiers that suspend or refuse rather than bill. **Never add a payment card to
Render or Supabase.** Limits checked on the services' own pages on 2026-10-17 are in
[ENVIRONMENT.md](ENVIRONMENT.md).

## Architecture

- **Website**: React + TypeScript + Vite, static on Cloudflare Pages. Code-split per screen.
  Reloads itself once if a deploy lands while a page is open.
- **Server**: Node 24 + Fastify on Render free (Singapore). Built by `buildServer(deps)` so tests
  can swap the clock, database and notifier. No in-memory state that matters (Render restarts it).
- **Database**: Supabase Postgres (Singapore). One idempotent schema file. Tables live in schema
  `app`, which Supabase's public data API does not expose. The server connects as a login role that
  is a member of `app_api`: no table ownership, row-level security forced on every table.
- **Sign-in**: Google (ID token, OIDC nonce, returning to our own site so Google's screen names it), exchanged at Supabase Auth; no Google or Supabase script library.
  Access token in memory, refresh token in sessionStorage, never localStorage. The server verifies
  every token itself; all data goes through the server.
- **Keep-awake**: a Cloudflare Worker cron hits `/health` every 10 minutes. `/health` touches the
  database, so neither the server sleeps nor the database pauses.
- **Matching**: one search engine (ADR 0015) for the Ask check and the Search screen: BM25 by
  words in Postgres (whole stemmed words; only the word being typed matches as a beginning),
  Graphinity's own embedding by meaning, fused by reciprocal rank. Typos are handled by Graphinity's
  own spelling model (ADR 0011) rather than trigrams.
- **Routing**: staged waves of 5, 5 and 5 at 0, 20 and 60 minutes, ranked by expertise,
  responsiveness and country, with a daily notification budget per person and reserved slots
  for newcomers. Each decision's factors are recorded, and a learned model of who helps (ADR 0013)
  may rank the main places once it beats Ψ on held-out questions and the owner switches it on. With exploration on (ADR 0014), the last place goes by gated Thompson sampling instead of to a newcomer, and a model that stops matching what happens is retired automatically.
- **Points**: an append-only ledger. Reversals are new rows, never edits.

## Build order

1. ✅ Foundations: repo, CI, schema base, server factory, design system, app shell.
2. ✅ Sign-in and profile: Google, display name, country, fields, delete account (built and tested
   locally; first real Google sign-in pending accounts, see SETUP-ACCOUNTS.md).
3. ✅ Ask, answer, read: public reading, live matching while typing (built and tested locally;
   editing and deleting posts not offered yet; question pages' link previews and the sitemap of
   questions need a server-side step at deploy, step 8).
4. ✅ Select, helpful, points, medals, trust, change-with-reason, pair cap (built and tested locally;
   medals now follow the spec's per-field tiers, docs/SPEC.md §11.3).
5. ✅ Routing waves, live updates, web push (built and tested locally; a real push delivered to a
   phone is checked at deploy, step 8).
6. ✅ Reporting, auto-hide, owner review page, limits, blocking, shared-network flags (built and
   tested locally; moderators are added by the owner in the SQL editor, SETUP-ACCOUNTS.md Part G).
7. ✅ The living graph (docs/GRAPH.md): routing score that learns from picks, helpful marks,
   verdicts and ignored questions, per field; reasons kept per route; `/graph`; the home graph, the
   asker watching their question travel and answers return, "why you got this" (built and tested
   locally; semantic search and answer consensus left for the owner's decision, see GRAPH.md).
8. Launch prep: privacy policy, terms, hostile review, phone checks, accounts, deploy (server
   first, then website), verify live.

## Owner's 2026-10-22 product extension

The owner asked to extend Graphinity into a consent-first first-party intelligence and commercial
platform. This is a new scope, not a claim that launch prep is complete.

| Stage | Status |
|---|---|
| Purpose-specific consent catalog, private settings, append-only audit | ✅ Implemented in migrations 0003–0004 and `/me/consents` |
| Personal graph layers, owner RLS, consent-gated nodes/edges, and evidence-linked event projection | 🟡 Typed consent categories, relationship writes, event projection, and owner-only PageRank/PPR, Louvain communities, NetMF embeddings and recommendations (v2, ADR 0012, measured against v1 on planted graphs) on a worker thread, with confidence and age weighting; per-signal weights for projected events and real-graph evaluation remain |
| Data controls and export | 🟡 Basic screen, individual/bulk graph deletion, and documented JSON export implemented; browser QA and export audit ongoing |
| Automatic first-party event collection with retention cleanup | 🟡 Question interaction and consented search/view signals are captured; bounded async projection and aggregate queue-depth/lag warnings exist; provider alert routing and broader collectors remain |
| Consent-aware personalization and explainability | 🟡 Finite opt-in discovery v3 (ADR 0016): the search engine for own searches, answered-by-the-same-people from public answers, similar-by-meaning, in measured tiers, each result with its reason (Recall@20 0.173 against 0.007 for v2 on a known-interest benchmark). Search learns its ranking from consented searches (ADR 0015 part 6). Not built: a learned recommendation ranking (needs the owner's decision on a new purpose) |
| Model monitoring and continuous learning | 🟡 Registry with gates, candidates, online interleaving and rollback (ADRs 0013–0015); collusion-flagged accounts left out of learning (ADR 0017); daily drift monitoring of every serving model, features and the text model's vocabulary, with a measured rule that starts retraining (ADRs 0018, 0019). Not yet: canary and shadow serving |
| Observability and reliability | 🟡 Request metrics by route with latency histograms, persisted per minute and rolled up hourly; availability and latency SLOs with multiwindow burn-rate alerting; health of every background job; `GET /ops/status` and the Operations screen for moderators (ADR 0020). Not yet: alert delivery by push |
| Commercial ranking firewall and affiliate disclosures | ⬜ Not implemented |
| Named-recipient partner authorization and audit | ⬜ Not implemented |
| Suppressed enterprise intelligence and differential privacy | ⬜ Not implemented |
| Production cost/capacity, deployment and accessibility gates | ⬜ Not completed for this extension |

See `docs/adr/0003-consent-based-data-and-commercial-intelligence.md` and `project report.md` for
the exact current state and the next delivery sequence.
