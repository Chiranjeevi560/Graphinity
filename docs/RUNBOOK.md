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
| Re-apply the schema after editing `db/schema.sql` | `npm run db:apply` |
| Run the local sign-in stand-in (replaces Google + Supabase Auth) | `npm run dev:auth` |
| Run the API against the local stand-in (no accounts needed) | `npm run dev:api:local` |
| Run the API against your real Supabase project (values in `.local/api.env`) | `npm run dev:api` |
| Run the website on http://localhost:5173 | `npm run dev:web` |
| Design gallery (development only) | http://localhost:5173/design |
| All tests | `npm test` |
| Typecheck | `npm run typecheck` |
| Production build | `npm run build` |
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

To try sign-in locally, run `db:start`, then `dev:auth`, `dev:api:local` and `dev:web` in three
terminals, and open http://localhost:5173. "Continue with Google" opens a local page where you pick
a test person. To try the production build with its strict security headers, run
`npm --workspace apps/web run build`, then `preview`, and start the API with
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
  targets. `AUDIT_SHOTS=1` also saves screenshots. They need the local database, and they write to
  it: test people, questions, answers, a moderator and a blocked account pile up there with each
  run. That is harmless locally, and the tests make fresh names each run.
  Never point them at the real Supabase project.
- **Lighthouse** (`npm run check:perf`) builds the site, serves it on port 4174 with the API on
  3000, and measures it like a visitor would. It refuses to start if something already uses either
  port, since it would measure that instead.

When adding a rule that matters, break it on purpose, confirm a test fails, and then restore it.

To commit and push, use `sh scripts/ship.sh <message-file> <paths…>`. It runs every check first,
commits only the listed paths, and pushes only if the floor guard agrees. It refuses when other
files have changes, because the checks would then have tested something other than the commit:
list them too, or stash them first.

## Schema changes

- Edit `db/schema.sql`. It must stay safe to run twice and additive only: add, never rename or
  drop in the same release as the code that stops using something.
- Bump the version in the `INSERT INTO app.schema_meta` line (now 12).
- Every new table needs `ENABLE` and `FORCE ROW LEVEL SECURITY`, explicit grants to `app_api`,
  and policies. The integration test fails if RLS is missing.

## Deploy

Order matters: **database, then server, then website.** A website that needs a new API must not
go live before that API does. The owner's click-by-click steps are in SETUP-ACCOUNTS.md (Parts G–I);
this is the order and what to check.

1. **Database.** Apply `db/schema.sql` in the Supabase SQL editor (safe to run again). Check the
   result says the new version (`SELECT version FROM app.schema_meta`).
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
6. **Website on Cloudflare Pages**, from the repository root, built with
   `npm ci && npm --workspace apps/web run build`, output `apps/web/dist`. Functions come from
   `/functions` (question link previews and the sitemap; only `/q/*` and `/sitemap.xml` run them,
   per the built `_routes.json`). In the Pages project's settings choose **Fail open**, so pages
   still load if the free daily allowance of 100,000 Function requests is ever used up. Variables and `VITE_SITE_ORIGIN`, `VITE_API_ORIGIN`, `VITE_SUPABASE_URL`,
   `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_GOOGLE_CLIENT_ID` (the build refuses http or missing
   values). Add `<site>/auth/callback` to the Google client's redirect URIs and `<site>` to its
   JavaScript origins.
7. **Keep-awake**: a Cloudflare Worker from `workers/keep-awake.js` with a Cron Trigger every 10
   minutes and `API_HEALTH_URL` set.
8. **Check live**: sign in with Google (the screen should name the site), ask, answer from a second
   account, pick, turn on notifications on a phone and receive one, report and review, delete a
   test account. At 320, 375 and 430 wide plus desktop, light and dark. Response headers,
   `<site>/robots.txt`, `<site>/sitemap.xml`, and the link preview in a chat app.
9. **Google Search Console**: add the site and submit the sitemap.
