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
| Run the API on http://localhost:3000 | `npm run dev:api` |
| Run the website on http://localhost:5173 | `npm run dev:web` |
| Design gallery (development only) | http://localhost:5173/design |
| All tests | `npm test` |
| Typecheck | `npm run typecheck` |
| Production build | `npm run build` |
| Production build served with production headers | `npm --workspace apps/web run preview` (port 4173) |
| Stop the local database | `npm run db:stop` |

`npm run db:start` writes two private files in `.local/` (git-ignored, readable only by you):
`api.env` (the API's database login and hashing key) and `test.env` (for integration tests).

To use the real Supabase project and Google instead of the stand-in, put the project's public
values in `apps/web/.env.supabase`, put `SUPABASE_URL` and the secret key in `.local/api.env`, and
start the website with `npm --workspace apps/web run dev -- --mode supabase` (don't run
`dev:auth`). Never paste the secret key into chat or a Terminal command; edit the file with
`open -e .local/api.env`.

To try sign-in locally, run `db:start`, then `dev:auth`, `dev:api` and `dev:web` in three
terminals, and open http://localhost:5173. "Continue with Google" opens a local page where you pick
a test person. To try the production build with its strict security headers, run
`npm --workspace apps/web run build`, then `preview`, and start the API with
`WEB_ORIGIN=http://localhost:4173`. Restart `preview` after changing headers: it computes them once
at startup.

## Tests

- **Unit tests** cover pure logic: rate limiting, config checks, springs, squircles, headers.
- **Server tests** run the real server in memory with a fake database.
- **Integration tests** create a throwaway database, apply the schema twice, connect as a
  restricted login role exactly like production, and check what that role can and cannot do.
  They need the local database running. They fail, never skip, when it isn't.

When adding a rule that matters, break it on purpose, confirm a test fails, and then restore it.

## Schema changes

- Edit `db/schema.sql`. It must stay safe to run twice and additive only: add, never rename or
  drop in the same release as the code that stops using something.
- Bump the version in the `INSERT INTO app.schema_meta` line (now 2).
- Every new table needs `ENABLE` and `FORCE ROW LEVEL SECURITY`, explicit grants to `app_api`,
  and policies. The integration test fails if RLS is missing.

## Deploy (step 7, not done yet)

Order matters: **database, then server, then website.** A website that needs a new API must not
go live before that API does.

1. Apply `db/schema.sql` in the Supabase SQL editor.
2. Create the API login role once per environment, with a password you generate and store only
   in Render's environment settings:
   `CREATE ROLE graphinity_api LOGIN PASSWORD '…' IN ROLE app_api;`
3. Deploy the server on Render. Check that `GET /health` returns `{"status":"ok","schemaVersion":N}`
   with the version you just applied.
4. **Measure the proxy hops** before trusting `X-Forwarded-For` (see SECURITY.md). Set
   `TRUST_PROXY_HOPS` to that number.
5. Deploy the website on Cloudflare Pages with `VITE_API_ORIGIN` set to the Render URL.
6. Check the live site at 320, 375 and 430 wide, plus desktop, in light and dark mode. Check the
   response headers.

Exact click-by-click account steps will be written when we get there.
