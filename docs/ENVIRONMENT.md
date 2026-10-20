# Environment

Every setting, where it lives, and the free-tier limits it runs under.

## API server (`apps/api`)

| Variable | Required | Example | Notes |
|---|---|---|---|
| `NODE_ENV` | production | `production` | Turns on the strict checks below. Staging runs with `production` too: the same code paths as production, no test switches |
| `APP_ENV` | production | `staging` or `production` | Which environment this server is (docs/adr/0002). Required when `NODE_ENV=production`; anything else is refused. Unset (development) on your computer, which can't claim another environment. Reported by `/health` |
| `RELEASE` | no | 40-hex commit hash | The commit the image was built from, written in at build time so it is the same wherever that image runs. Reported by `/health`, so a deploy can wait until its own commit answers. Must be a full hash |
| `PORT` | no | `3000` | Render sets this itself |
| `HOST` | no | `0.0.0.0` in production, `127.0.0.1` locally | |
| `DATABASE_URL` | yes | `postgres://graphinity_api:…@…/postgres` | The **restricted** login role, never the owner. Secret |
| `WEB_ORIGIN` | production | `https://graphinity.pages.dev` | The one origin allowed by CORS. Must be https |
| `TRUST_PROXY_HOPS` | production | `1` | **Measured** at deploy (SECURITY.md). No default in production |
| `IP_HASH_KEY` | yes | 64 hex chars | `openssl rand -hex 32`. Secret. Also hashes deleted-account ids. Changing it resets rate-limit identities and forgets the 2-hour deleted-account lockout |
| `SUPABASE_URL` | production | `https://abcd.supabase.co` | Tokens must be issued by `<this>/auth/v1`. Must be https in production. Local default: the stand-in at `http://localhost:54321` |
| `SUPABASE_SECRET_KEY` | yes | `sb_secret_…` | **Most powerful secret.** Used only to delete a person's sign-in. Never in git, chat, logs or the website |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | no (push is off without them) | 87 / 43 base64url chars | Web push keys, both or neither; the server refuses a mismatched pair. Make them with `node scripts/vapid-keys.mjs <env file>`, which writes them into the file and prints only the public key. The private key is a secret. Replacing them makes every device subscribe again |
| `VAPID_SUBJECT` | no | `https://graphinity.pages.dev` | Who push services can contact about our pushes. Defaults to `WEB_ORIGIN` (no email needed) |
| `CF_ACCOUNT_ID` / `CF_AI_TOKEN` | no (semantic search falls back to words without them) | 32 hex chars / a Cloudflare API token | Cloudflare Workers AI for embeddings (`@cf/baai/bge-base-en-v1.5`, cls pooling). Both or neither. The token needs only the **Workers AI** permission. Secret. Locally, without them, a deterministic local stand-in is used instead |

## Migrations (`apps/api/src/migrate-main.ts`)

| Variable | Required | Example | Notes |
|---|---|---|---|
| `MIGRATION_DATABASE_URL` | yes | `postgres://postgres.<project>:…@…pooler.supabase.com:5432/postgres` | The **schema owner**, the opposite of `DATABASE_URL`: it must own the tables and bypass row-level security (Supabase's `postgres` does). Only the migration step has it, never the running server. For the live project it lives in `.local/migrate.env` on the owner's computer (SETUP-ACCOUNTS.md, Part I). Secret |

Locally, `npm run db:start` generates `DATABASE_URL`, `IP_HASH_KEY`, a local `SUPABASE_URL` and a
random dev `SUPABASE_SECRET_KEY` into `.local/api.env`.

## Website (`apps/web`)

The build compiles in **none** of these: one build is promoted from staging to production. The
deploy writes them into a copy of the build (`npm run build:pages` runs
`node stamp-dist.ts dist dist-pages`), as a
`<meta name="graphinity-settings">` tag in `index.html`, the CSP in `_headers`, `robots.txt` and
`sitemap.xml`. It refuses a build that names any environment, http addresses, a key that isn't the
publishable one, or Google sign-in pointing anywhere but Google. The link-preview Functions read the
same names from the Pages project's settings at request time.

For Cloudflare Pages, set **Root directory** to `apps/web`, **Build command** to
`npm run build:pages`, and **Build output directory** to `dist-pages`. Add the five `VITE_*`
values below to the Pages project's environment variables for the deployment environment. They are
public configuration, not secrets; never add API, database, OAuth token, or Supabase secret values.

| Variable | Required | Example | Notes |
|---|---|---|---|
| `VITE_SITE_ORIGIN` | for deploys | `https://graphinity.pages.dev` | The site's own address: canonical links, sitemap, robots.txt, link previews. Cloudflare builds refuse http |
| `VITE_API_ORIGIN` | for deploys | `https://graphinity-api.onrender.com` | Goes into the CSP `connect-src`. Cloudflare builds refuse http |
| `VITE_SUPABASE_URL` | for deploys | `https://abcd.supabase.co` | Where sign-in happens; also in `connect-src`. Cloudflare builds refuse http |
| `VITE_GOOGLE_CLIENT_ID` | with the real Supabase | `1234-abc.apps.googleusercontent.com` | The Google OAuth client. Public by design: it appears in every sign-in address. Builds against a real Supabase refuse to start without it |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | for deploys | `sb_publishable_…` | Public by design: identifies the project, grants nothing (our tables aren't exposed). Cloudflare builds refuse anything else |

Locally these default to the local API and the sign-in stand-in: `npm run dev` stamps them into
the page it serves, and `npm --workspace apps/web run preview` serves a stamped copy, `dist-local`.

These values end up in every visitor's page. **Never put a secret in one.**

## Tests

| Variable | Where | Notes |
|---|---|---|
| `TEST_DATABASE_ADMIN_URL` | `.local/test.env`, CI | An owner connection that may create and drop throwaway databases |

## Free-tier limits

Checked on each service's own pages on 2026-10-17. Re-check before relying on a number.

| Service | Limit | At the limit |
|---|---|---|
| Render web service | 750 instance-hours/month (one service running all month uses 744); sleeps after 15 min idle; can restart any time; no persistent disk; SMTP ports blocked | Hours: suspended until next month. Bandwidth: **billed if a card is on file**, otherwise suspended. **Never add a card** |
| Supabase | 500 MB database, 5 GB egress, 50,000 monthly active users, 200 concurrent realtime connections, pauses after 1 week inactive, 2 free projects | Database over 500 MB becomes read-only. Egress behaviour on Free isn't stated clearly on their page. **Never add a card** |
| Supabase Auth email | 2 emails/hour with the built-in sender | Not used: Google sign-in only |
| Cloudflare Pages | 500 builds/month, 20,000 files, 25 MiB per file | Builds stop until next month |
| Cloudflare Workers | 100,000 requests/day, 10 ms CPU, 5 cron triggers | Requests refused (error 1027) |
| Cloudflare Workers AI (checked 2026-10-19) | 10,000 neurons/day on the Free plan; bge-base-en-v1.5 costs 6,058 neurons per million input tokens (about 1.6 million words a day); resets 00:00 UTC | "Further operations will fail with an error": not billed. Graphinity then matches by words and fills missing embeddings later |
| GitHub Actions | 2,000 minutes/month for private repos | Blocked, not billed, with no payment method |
| Web push | Free; iPhone needs Home Screen install, iOS 16.4+; no Apple developer account needed | None |

Still to confirm at signup: whether Cloudflare asks for a card for Pages or Workers, and Render's
exact bandwidth allowance.
