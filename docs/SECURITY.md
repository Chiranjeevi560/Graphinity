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
| Request flooding | Global and per-visitor token buckets; visitor = HMAC of address | `server.test.ts`, `rate-limit.test.ts` |
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
| One person editing another | RLS: insert/update/delete only where `id = app.current_user_id()` | `profile.integration.test.ts`; fails with `USING (true)` |
| Deleted account's live token | Keyed hash of the id remembered for 2 h, refreshed when Supabase confirms the deletion, and checked on every signed-in request | Integration test; fails when the check is removed |
| Half-finished deletion (Supabase down) | The id is kept in `app.pending_auth_deletions` until Supabase confirms; a job retries with backoff; the account is refused while pending; a deferred database trigger refuses any profile for a pending id (also closes the create/delete race) | Integration tests; each fails when its protection is removed |
| Input "fixed" instead of refused | Fastify's coercion and property-stripping turned off | Integration test; fails with the defaults |
| Identity in the database | Only a chosen name, country, fields, 18+ time. No Google name or email copied | Integration test checks the stored row |
| Supply chain | Install scripts disabled, exact versions, lockfile, versions over 2 weeks old, audit in CI, actions pinned to commits, read-only CI token | `.npmrc`, `ci.yml` |

## Threat model

Each line answers: *if a hostile researcher spent a day on this, what would they try?*

| # | Attacker tries to… | Defence | Status |
|---|---|---|---|
| T1 | Read or change another person's data through the API | RLS on every table keyed to the transaction's identity; API never owns tables | Foundation in place; per-table policies come with each table |
| T2 | Use the public Supabase key to query tables directly | Tables in unexposed schema `app`; no grants to `anon`/`authenticated` | In place, tested |
| T3 | Flood the server so it is slow or suspended | Global + per-visitor limits; durable per-account daily limits later | Partly in place (step 6 adds per-account limits) |
| T4 | Forge their address to dodge limits | Measured hop count; HMAC key | In place; hop count must be measured at deploy |
| T5 | Inject script into pages (XSS) | React escapes text; strict CSP; plain-text posts | CSP in place; posts arrive in step 3 |
| T6 | Steal a sign-in token | Access token in memory, refresh token in sessionStorage; CSP with no inline or third-party scripts | In place |
| T7 | Forge the OAuth return (login CSRF), or replay a Google ID token | Our own state checked in the tab that started it, plus an OIDC nonce whose raw value never leaves the tab | In place |
| T8 | Farm points with a second account | Pair cap, trust counted once per asker, shared-network flags | Step 4 |
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

## Known gaps

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
- Email sign-in is switched off in the Supabase dashboard, which is a setting, not code. The server
  does not yet refuse tokens whose provider isn't Google (`app_metadata.provider`); adding that is a
  recommended second lock, not yet done.
- Not yet checked: CI on GitHub (no repository yet), and headers on the real Cloudflare and Render
  hosts.
