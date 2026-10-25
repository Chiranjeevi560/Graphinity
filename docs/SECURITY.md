# Security

How Graphinity protects people, and how an attacker might try to break it. Update this whenever
the design changes. A threat with no defence listed is an open problem, not a solved one.

## Assumptions

These must stay true. If one stops being true, revisit everything that depends on it.

1. **The server is reachable only through its host's load balancer.** Render instances can't be
   reached directly. This is why counting proxy hops is a safe way to find a visitor's real
   address. Fastify 5.12 refuses a plain hop count for exactly this reason, so we pass an explicit
   rule (`server.ts`).
2. **`TRUST_PROXY_HOPS` is measured, not guessed.** Too low: everyone shares one rate-limit
   bucket. Too high: visitors can forge their address. How to measure: deploy with `0`, call
   `/health` from your own connection with a made-up `X-Forwarded-For: 198.51.100.1`, and read
   the server's view (a temporary log line, removed after). Count the entries our host added to
   the right of yours.
3. **The website's public Supabase key can read nothing.** Our tables are in schema `app`, which
   the Supabase data API doesn't expose, and roles `anon` and `authenticated` get no grants there
   (tested).
4. **Secrets live only in host environment settings and `.local/`.** Never in git, chat or logs.
5. **Supabase access tokens live at most one hour** (Supabase's default). The verifier refuses any
   token whose lifetime is longer than 1 hour plus 60 seconds, because deleted accounts are locked
   out for 2 hours: a longer-lived token could outlast that. Don't raise the expiry in Supabase.
6. **Supabase signs tokens with an asymmetric key (ES256 or RS256).** Tokens signed with the legacy
   shared secret (HS256) are refused. That fails closed: if the project still uses the legacy
   secret, nobody can sign in until it's migrated (SETUP-ACCOUNTS.md).
7. **The Supabase secret key is the most powerful secret we hold.** It can do anything in the
   project. It is used for exactly one call (deleting a person's sign-in), sent only to Supabase,
   and lives only in Render's environment. Supabase also refuses secret keys sent from browsers.

## What is in place (steps 1–2)

| Area | Defence | Proven by |
|---|---|---|
| Database access | API logs in as a role that owns nothing, can't create objects, bypass RLS or become the owner. **The server refuses to start** if its login is a superuser, can bypass RLS, or owns the tables | `db.integration.test.ts`; built server refuses the owner login |
| Row-level security | Enabled and forced on every table in `app` | Integration test fails on any table without it |
| Identity leakage between requests | Identity set with `set_config(..., true)`, scoped to one transaction | Integration test; fails when made session-wide |
| Request flooding | Global (400, refilling 100/s) and per-visitor (300, refilling 10/s) token buckets; visitor = HMAC of address (IPv6 by /64). The visitor allowance is generous because mobile carriers share one address among many people; per-person write limits and new-account limits sit on top | `server.test.ts`, `rate-limit.test.ts` |
| Forged `X-Forwarded-For` | Only measured hops trusted; with 0, header ignored | `server.test.ts` |
| Large bodies | 4 KB limit before any route runs | `server.test.ts` |
| Slow clients | 15 s connection and request timeouts | Config in `server.ts` (not load-tested) |
| Cross-site calls | CORS for the one website origin, no credentials | `server.test.ts` |
| Clickjacking, sniffing | CSP `frame-ancestors 'none'`, nosniff, X-Frame-Options on API and site | Tests on both |
| Script injection on the site | CSP `script-src 'self'`, no `unsafe-inline`; build fails on inline scripts | `headers.test.ts`, browser check |
| Data in logs | Route pattern, status, time only; no addresses, headers, query, bodies, error messages, hostnames | `server.test.ts` |
| Weak configuration | Server refuses to start without https origin, proxy count, 32-byte key | `config.test.ts` |
| Forged or stolen tokens | Server verifies every token against Supabase's public keys: ES256/RS256 only (no `none`, no HS256 with the public key), issuer, audience, role, not anonymous, user id shape, max 1 h lifetime | `auth.test.ts` |
| Login CSRF (someone feeds you their sign-in) | Our own random `state`, returned by Google and checked against this tab before anything is exchanged | `apps/web/test/auth.test.ts`; 11 tests fail when the state is fixed |
| Stolen or replayed Google ID token | OIDC nonce: Google only sees the SHA-256 of a random value kept in this tab; Supabase accepts the token only with the raw value (checked in its source, `token_oidc.go`). A token copied from the address bar or a log is useless without it | Unit tests fail when the nonce is sent hashed; the local stand-in checks the nonce the same way, and the browser audit signs in through it |
| ID token left in the address bar | It arrives after `#`, which browsers never send to a server, and is wiped with `history.replaceState` before any request | Browser check: address is `/auth/callback` with nothing after it by the time setup shows |
| Token theft from storage | Access token in memory only; refresh token in sessionStorage; localStorage never used | Web test with a localStorage that throws on access; fails 7 tests when broken |
| Unposted drafts left on a shared computer | Drafts live in sessionStorage (this tab only), are checked for shape when read back, and are cleared on posting, signing out and deleting the account | Browser tests: reload and failed post keep the text; sign-out and deletion leave no draft keys (each fails when its clearing is removed) |
| One person editing another | RLS: insert/update/delete only where `id = app.current_user_id()` | `profile.integration.test.ts`; fails with `USING (true)` |
| Deleted account's live token | Keyed hash of the id remembered for 2 h, refreshed when Supabase confirms the deletion, and checked on every signed-in request | Integration test; fails when the check is removed |
| Half-finished deletion (Supabase down) | The id is kept in `app.pending_auth_deletions` until Supabase confirms; a job retries with backoff; the account is refused while pending; a deferred database trigger refuses any profile for a pending id (also closes the create/delete race) | Integration tests; each fails when its protection is removed |
| Input "fixed" instead of refused | Fastify's coercion and property-stripping turned off | Integration test; fails with the defaults |
| Someone posting as another person, or answering their own question | RLS: questions and answers only as `app.current_user_id()`; the answer policy also refuses the asker. No UPDATE or DELETE granted yet | `questions.integration.test.ts`; fails when the policy check is removed |
| Learning who was asked, or who someone is, from the graph | `/graph` nodes are field sets with no names or ids, freshly sampled; the asker gets per-wave counts only, through `app.routing_summary`, which returns nothing to anyone else; "why you got this" reads the viewer's own route, which row-level security limits to them | `graph.integration.test.ts`; fail when the function's asker check is removed |
| Gaming the routing score | Points need a real pick from another person (pair cap applies); answering counts only answers moderators haven't removed. Graph trust (φ4, 12%) flows only from moderators along picks (TrustRank), so accounts picking each other in a ring gain nothing; the routing job alone may read the moderator list (`moderators_system`). Closeness in meaning (φ1) comes from `app.experience_proximity`, which answers only the routing job and leaves out hidden and removed posts. The newcomer bonus counts only in the newcomer place, so it can't push proven people out. Known gap: fake accounts acting as askers can still raise someone's reputation and pick rate (φ2, φ5, φ6: 36% together); the pair cap and new-account limits slow this | `routing.integration.test.ts`, `routing-score.test.ts`; each rule fails a test when removed |
| Using an embedding provider or sending draft text without consent | Visitor rate limits bound precheck; drafts under 10 characters aren't sent; no content goes to any embedding provider: meaning is computed by Graphinity's own model on its own server (ADR 0010) for everyone, no longer behind `ai_personalization` (owner decision, ADR 0015, announced once in the app); with no model promoted, search fails closed to word matching in production. The owner's 2026-10-22 self-hosting directive is not yet fulfilled: no self-hosted model runtime or capacity has been deployed. | `precheck.integration.test.ts`, `embeddings.test.ts` |
| Middlemen soliciting through answers ("DM me on WhatsApp +91…") | Answers with phone numbers (10+ digits, any separators, full-width digits normalised), email addresses or messaging links and invitations are refused with a plain reason, in the API and by a database check with the same patterns. Refused, not silently edited. Known gap: numbers spelled out in words, or split by other characters, get through; moderators and reports remain the backstop | `solicitation.test.ts`, `questions.integration.test.ts` |
| Hidden or spoofing characters in posts | Control characters (C0, DEL, C1) and direction overrides and isolates (U+202A-202E, U+2066-2069, which make text display in another order) refused in the API and by database checks on titles, bodies, answers, report notes and block reasons; the marks right-to-left writing needs (U+200E, U+200F, U+061C) stay allowed; titles one line with single spaces. Lookalike letters from other scripts (homoglyphs) are not refused: real names and languages use them | `text.test.ts` and database tests |
| Getting points that didn't happen | See T8a. Every rule tested by an attack that must fail, and each test proven to fail when its rule is removed | `points.db.integration.test.ts`, `points.integration.test.ts` |
| Learning who was asked a question | Routes readable only by their recipient (and the server's routing job, which sets its own `app.system` flag; no request does); only the job can create them; never to the asker; 3 a day per person, in the database | `routing.integration.test.ts`; fails when the policy or budget is loosened |
| Live stream outliving sign-in or flooding the server | Ends a minute before the token expires; 3 per person, 300 in all; carries only an event type and question id; ended first on shutdown | `live.integration.test.ts`; shutdown test fails with the hook on `onClose` |
| Making the server call other addresses (SSRF) through push | Push only to the browsers' push services over https (Google, Mozilla, Apple, Microsoft), checked when subscribing and again when sending; database requires https | `push.test.ts`, `push.integration.test.ts`; fail when the allowlist is opened |
| Notifications reaching the wrong person on a shared device | A browser already registered to another account is refused, and the website makes a fresh subscription; the settings screen asks the server whether this browser is the signed-in person's (`POST /me/push/status`) rather than trusting the browser; a subscription the server refused is cancelled; signing out and deleting the account turn push off for that device; at most 10 devices per person | `push.integration.test.ts` |
| Reading notifications in transit | Encrypted for the device (RFC 8291), signed by us (VAPID); checked byte for byte against RFC 8291's example, and by decrypting what the server sends | `push.test.ts`, `push.integration.test.ts` |
| Search query injection | Matching builds its query only from letters and digits, passed as a parameter | `text.test.ts`; operator characters return no query |
| Identity in the database | Only a chosen name, country, fields, 18+ time. No Google name or email copied | Integration test checks the stored row |
| Supply chain | Install scripts disabled, exact versions, lockfile, versions over 2 weeks old, audit in CI, actions pinned to commits, read-only CI token | `.npmrc`, `ci.yml` |

## Threat model

Each line answers: *if a hostile researcher spent a day on this, what would they try?*

| # | Attacker tries to… | Defence | Status |
|---|---|---|---|
| T1 | Read or change another person's data through the API | RLS on every table keyed to the transaction's identity; API never owns tables | Foundation in place; per-table policies come with each table |
| T2 | Use the public Supabase key to query tables directly | Tables in unexposed schema `app`; no grants to `anon`/`authenticated` | In place, tested |
| T3 | Flood the server so it is slow or suspended | Global + per-visitor limits, per-person write limits, new-account limits (3 questions, 10 answers on day one), 10 push devices and 3 live streams per person | In place |
| T4 | Forge their address to dodge limits | Measured hop count; HMAC key | In place; hop count must be measured at deploy |
| T5 | Inject script into pages (XSS) | React escapes text; strict CSP; plain-text posts, links never made clickable | In place |
| T6 | Steal a sign-in token | Access token in memory, refresh token in sessionStorage; CSP with no inline or third-party scripts | In place |
| T7 | Forge the OAuth return (login CSRF), or replay a Google ID token | Our own state checked in the tab that started it, plus an OIDC nonce whose raw value never leaves the tab | In place |
| T8 | Farm points with a second account | Pair cap (3 awards per asker per person per 30 days), trust counted once per asker; shared-network flags in step 6 | Pair cap and trust in place; flags step 6 |
| T8a | Forge or replay points | Ledger rows only for a real pick or mark by the signed-in asker, amount fixed by reason, take-backs mirror their award, capped awards kept as 0 so they can't be paid later, one lock per question then per pair in a fixed order, READ COMMITTED required, real clock time; no UPDATE/DELETE granted | In place; `points.db.integration.test.ts` attacks each, three adversarial reviews |
| T9 | Flood people with notifications | Daily per-person budget, waves | Step 5 |
| T10 | Post abuse, spam or private info | Reports, auto-hide after 3, owner review, new-account limits | Step 6 |
| T11 | Exhaust the free tier to get the service suspended | Rate limits, body limits, no file uploads in v1 | Partly in place |
| T12 | Make the server fetch internal addresses (SSRF) | The server fetches no user-supplied URLs | Not applicable by design. Revisit if link previews are ever added |
| T13 | Slip malicious code in through a dependency | See supply chain row above | In place |
| T14 | Learn who someone is from logs or error messages | Log policy; generic errors | In place, tested |

| T15 | Impersonate staff or another person by name | Reserved names, no all-digit names, unique names regardless of capitals, one name change per week enforced by the database's own clock (it stamps the time and ignores any value sent). Freed names can be taken at once: owner decision pending | In place |
| T16 | List all members by probing names | Name availability needs sign-in; public profiles are one-at-a-time by exact name | In place; per-account read limits come with step 6 |

## Data kept on purpose

- `app.pending_auth_deletions` holds a deleted person's user id **only** while Supabase has not yet
  confirmed removing their sign-in. It is the one value needed to finish the deletion, and the row is
  removed the moment Supabase confirms. Normally that is within the same request.

## Consent and personal graph

Optional first-party graph data is separate from public Q&A and defaults to off by purpose. The API
checks active consent before writing a personal graph node; the database repeats the check through
forced RLS. The system-owned projection function rechecks the event's active category before adding
generated graph nodes or edges. A revoked choice blocks future graph inserts and must be excluded by
every future personalization reader. The owner can still inspect and remove stored data after revocation. Consent
history allows API-role reads and inserts only, never edits or deletes; account deletion cascades it.

Known gaps: the finite question recommender enforces feed, search-history, and reading-history
consent. An owner-only graph insights route runs bounded PageRank, personalized PageRank, label
propagation, and graph recommendation over active categories; this is not global graph analytics.
The graph projection is limited to question interactions. Signal-event expiry is enforced
by an hourly, narrow definer purge function, but restore/retention drills are still pending. Partner
sharing, enterprise outputs, differential privacy, and named-recipient authorization are not
implemented. The JSON export covers documented content and interaction categories; re-audit it
whenever a user-linked table is added.

## Graphinity's own models (ADR 0010)

- Training reads only public, non-hidden posts of people who turned on `model_training` (off by
  default); hidden posts are excluded by the query and again by the read policy. Turning it off
  removes a person's text from every later run; a version already serving keeps the statistics it
  learned until a newer one replaces it.
- `app.ml_models` is readable and writable only by system transactions (forced RLS); no request can
  see or change a model. Weights never leave the database, and the repository's public CI never
  sees user data.
- A served model's weights are checked against their stored SHA-256 every time they're loaded; a
  mismatch refuses to serve (tested by altering a byte).
- A model's vocabulary holds words from consented posts, including rare ones. It is never sent to
  a client; only similarity scores are used, inside the database query.
- Spelling correction (ADR 0011) learns only words seen at least twice. Its corrections are used
  inside the precheck's word search and never returned, so the response carries no word that
  wasn't typed or isn't in a question the caller may already see. Corrected words reach the full-text
  query through the same letters-and-digits filter as typed ones, so they can't change the query's
  meaning. The serving speller loads with the same SHA-256 check.

## Personal graph analysis (ADR 0012)

- Analysis runs on one worker thread per server, after the database transaction ends, so a
  maximal graph (~70–175 ms of CPU) can't hold up other requests or a pooled connection. At most 8
  analyses wait; beyond that the route refuses with 503, which bounds the CPU any group of callers
  can queue. Input is the caller's own consented graph only, loaded under RLS as before.
- Logs carry only the analysis time and the queue depth.

## Learned routing (ADR 0013)

- `app.route_factors` holds each routing decision's nine factors, including internal scores and
  how similar the person is to others asked. Forced RLS admits system transactions only, so a
  routed person can read their route but not these numbers. Rows go with the route (cascade on
  account deletion) and after 180 days (hourly job).
- The database refuses malformed factors: wrong length, outside [0, 1], NaN or gaps. It refuses a
  model version not in the registry, a route whose `ranking_version` disagrees with the model
  recorded, and a learned model on the newcomer place.
- Abuse:
  - Askers control the labels (picks, helpful marks), so the gate counts each asker once, requires
    30 different askers with accounts 14 days old, and resamples askers.
  - Trust, reputation, proximity and country weights can't go negative.
  - A model can't be promoted until trust has taken 5 distinct values.
  - Residual: about 30 aged accounts and one moderator pick satisfy those rules. The owner's
    `learned_routing` switch (off by default) is the last control.
- Training reads routing's own records (routes, answers, picks, helpful marks), not post text, so
  it isn't gated by `model_training` consent. The artifact is about 930 bytes of standardization
  constants and weights, with no per-person parameter. Weights trained partly on a since-deleted
  account remain until the next retrain.

## Routing exploration (ADR 0014)

- Exploration decisions (reason, propensity, the model's prediction) are stored in the same
  system-only `app.route_factors`, kept 180 days. Logs carry counts and rates only.
- No one is explored more than 3 times in 7 days. The routing job checks this, and a database
  trigger enforces it under a per-person advisory lock, so two servers at once can't both
  explore the same person. A refusal makes that place exploitation's choice.
- A farm of N fresh accounts can draw at most 3N exploration routes a week, each costing at most
  half a place's expected value (the safety gate). The spec's newcomer place it replaces had no
  cap at all.
- Automatic demotion retires a serving routing model whose helpful answers fall clearly short of
  its predictions (99%, and below 80%), and the promotion gate applies the same check, so a
  retired model can't return the next night. Exploration is off until the owner turns on
  `routing_exploration`.

## Consent for search (ADR 0015)

- Learning from searches is its own optional purpose, `search_improvement`, separate from
  `search_history`, so declining it costs nothing else. It covers only data collected while it is on.
- Ask-once purposes are asked a single time (`awaitingAnswer`); any answer is recorded with the
  consent audit log and ends the asking. Nothing is collected under `search_improvement` until the
  search tables exist with their delete-on-revoke trigger (part 3).
- `ai_personalization` text no longer claims question text goes to Cloudflare; nothing goes to any
  outside AI.

## Search (ADR 0015 part 2)

- **Searches stay out of addresses and logs.** `POST /search` takes the query in the body; there is
  no GET form (tested). Request logs carry the route pattern, status and time only; `Server-Timing`
  carries stage durations only (tested by its exact shape).
- **Nothing about other people.** Results carry a question's id, title, field, answer count, last
  answer time and reasons as words; no author, trust, reputation or score (tested by the exact set of
  keys; a mutation adding `similarity` fails it).
- **Hidden questions stay hidden.** `app.word_search` and `app.nearest_questions` run as the schema
  owner (row-level security would force a scan of every question) and leave hidden questions out
  themselves; the details are then fetched as the reader under row-level security, which drops
  anything they may not see, including a question hidden since. Tested through both.
- **The word statistics can't be read or written by the API.** `app.search_lexemes` and
  `app.search_corpus` have row-level security forced and no grants to `app_api`; only owner-run
  triggers write them. Tested: every read and write as `app_api` is refused (42501).
- **Pattern injection.** The word being typed reaches `LIKE` with `\`, `%` and `_` escaped; the rest
  is passed as `to_tsvector` text, never assembled into a query string. Tested with `%` and `d_`.
- **Cost of a search is bounded.** At most 1,000 candidates from rare words (2,000 when one common
  word is all there is), at most 16 completions of the word being typed, at most 50 from meaning, 20
  shown. Each person and visitor address has its own search allowance (30, then one per 2 s) besides
  the server-wide limits, and the `search` switch turns the endpoint off.
- **Known trade-off:** the statistics count words in hidden questions too, so a word used only in
  hidden posts still shapes rarity slightly. It never makes a hidden question appear.
- **Known trade-off:** every new question updates one shared row (`app.search_corpus`), so question
  inserts briefly queue behind each other. Fine at today's rate; revisit if inserts ever contend.

## Searches recorded to improve search (ADR 0015 part 3)

- **Only under the choice.** `app.searches`, `app.search_results` and `app.search_opens` are written
  only while the person has `search_improvement` on. The database enforces it twice: row-level policies
  (own rows, choice on), and a trigger that locks the person's consent row `FOR SHARE` and refuses when
  it is off. Each is tested with the other switched off where they can be separated.
- **No row survives turning it off,** in either order of a race. A write that started first holds the
  lock, so the revoke waits and then deletes it; a write that arrives during a revoke waits and is
  refused. Both orders are tested with held transactions.
- **Turning it off deletes everything recorded under it,** whatever the change to the consent row
  (turned off, deleted, or moved, which no request can do: the API role may update only `enabled`,
  `policy_version`, `source` and `updated_at`). Turning it back on never brings anything back, and a
  search begun before an off-and-on is not recorded under the new "on": the insert requires the
  consent row unchanged since the search began.
- **The database sets the facts:** creation and expiry dates, the opened time and the consent version
  (the one the person accepted) are set by the trigger, and the API role can't send them at all
  (column grants). Search ids given to clients are random (`public_id`), so they reveal nothing about
  how many others searched.
- **Retention:** 365 days at most, checked by the database; purged hourly; in the person's export;
  deleted with the account (`ON DELETE CASCADE`).
- **Only the Search screen:** drafts typed into the Ask check are never recorded here.
- **Nobody reads another person's rows;** only the training job (`app.is_system()`) reads everyone's.
- **Reviewed:** a fresh-eyes review found a race test that didn't race, a revoke that a column change
  could slip past, writer-chosen dates and consent versions, an off-and-on window, and sequential ids;
  all fixed and tested (the race tests now wait until the other session is blocked on the lock).
- **Known overlap:** the own-rows check and the consent check can't be tested apart.
  `app.search_improvement_on` runs as the caller, and row-level security shows a person only their own
  consent row, so the consent check alone already restricts writes to oneself. The API's own checks
  (consent before writing, the searcher's own search for opens) are defence in depth over the database
  and can't be told apart from it by any request.

## Question vectors (ADR 0015 part 5)

- `app.question_embeddings` has row-level security forced. A request may only add the vector of a
  question its own asker just posted (policy `question_embeddings_own_new`); reading, changing and
  removing vectors is the background job's alone (`app.is_system()`). Searching goes through the
  owner-run `app.nearest_questions`, which leaves out hidden questions and other fields itself.
  Tested: another person's question refused (42501); reads, updates and deletes as a person see and
  touch nothing.
- `app.store_question_embeddings` (the job's batch store) refuses any transaction that isn't the
  job's (42501), and skips a question deleted meanwhile. Tested.
- Vectors go with their question (`ON DELETE CASCADE`), so deleting an account deletes them. Tested.
- Models and sizes never mix: a search compares only vectors of the model and size it was given.

## Known gaps

- The daily limit of 3 questions per person is counted without a lock. One server routes one
  question at a time, so it holds today; before running two servers, lock per person while routing.
- Routing scores everyone in the question's field (three indexed lookups each). Fine at today's
  size; at thousands of members per field, narrow the pool first.
- In a very small field, the asker can guess who was asked from the field's public members even
  without counts (the first wave goes to everyone eligible). Counts under 5 are hidden to make
  this harder; it can't be closed fully while fields and profiles are public.
- Rate-limit counts live in memory and reset when Render restarts the server. That only ever errs
  towards letting people in. Durable limits come in step 6.
- The 15-second timeouts are configured but not tested under load.
- Closing the tab signs you out: the refresh token lives in sessionStorage by design (the brief
  rules out localStorage). Opening a link in a new tab means signing in again.
- Checked on 2026-10-18 against the real Supabase project and Google: sign-in, profile creation
  and account deletion work end to end (Supabase listed one Google-only user, then none after
  deletion; our database kept no rows; the server log held no emails or ids). That was the earlier
  flow through Supabase's own Google page. The current flow (Google returns to our site with an ID
  token; see below) is tested against the local stand-in only, until the owner adds the redirect
  address in Google Cloud. Not checked: the keyboard covering fields on a real phone.
- Sign-in uses Google's ID-token flow in the address fragment, without Google's script library.
  Google's docs call this flow harder to get right and suggest their library; we don't load it
  because the brief rules out third-party scripts, and the parts that make it safe (state, nonce,
  wiping the fragment, strict CSP) are each tested. Browser extensions with access to the page can
  read the token for a moment, but can't use it without the nonce.
- Google's screen names the site the sign-in returns to. Until Google verifies the brand (needs a
  domain we own, verified in Google Search Console), it shows the address, e.g. "Sign in to
  graphinity.pages.dev", not the name "Graphinity". Whether a `pages.dev` address can be verified is
  unconfirmed; a free domain may be needed at launch.
- Points trust the user id the API sets after verifying the token (`app.current_user_id()`), like
  every other table. A compromised API role could act as any person; the database stops it from
  inventing points that no pick or mark backs.
- Several people (sock accounts) can each give one person points up to the pair cap. Step 6 adds
  flags for shared networks; nothing slows sock accounts before that.
- The API role could hold the advisory-lock keys to stall picks for a question or pair (denial of
  service by our own server role, accepted).
- Re-picking an answer whose award the cap stopped, after the 30-day window, is a new award (still
  under the cap). "Better answer later" leaves an earlier "turned out right" verdict standing.
- A pick change racing the picked author's account deletion can fail once (deadlock or foreign key)
  and needs a retry.
- - Email sign-in is switched off in the Supabase dashboard, which is a setting, not code. The server
  does not yet refuse tokens whose provider isn't Google (`app_metadata.provider`); adding that is a
  recommended second lock, not yet done.
- Not yet checked: CI on GitHub (no repository yet), and headers on the real Cloudflare and Render
  hosts.
