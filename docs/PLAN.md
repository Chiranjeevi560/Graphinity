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
- **Matching**: Postgres full-text search with prefix matching (finds words still being typed),
  ranked by relevance. Trigram typo tolerance was left out on purpose: on Supabase it needs grants
  in the `extensions` schema we couldn't verify; add it if matching misses misspelled questions.
- **Routing**: staged waves of 5, 5 and 5 at 0, 20 and 60 minutes, ranked by expertise,
  responsiveness and country, with a daily notification budget per person and reserved slots
  for newcomers.
- **Points**: an append-only ledger. Reversals are new rows, never edits.

## Build order

1. ✅ Foundations: repo, CI, schema base, server factory, design system, app shell.
2. ✅ Sign-in and profile: Google, display name, country, fields, delete account (built and tested
   locally; first real Google sign-in pending accounts, see SETUP-ACCOUNTS.md).
3. ✅ Ask, answer, read: public reading, live matching while typing (built and tested locally;
   editing and deleting posts not offered yet; question pages' link previews and the sitemap of
   questions need a server-side step at deploy, step 8).
4. ✅ Select, helpful, points, medals, trust, change-with-reason, pair cap (built and tested locally;
   medal thresholds bronze 10 / silver 50 / gold 200 are a default for the owner to confirm).
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
