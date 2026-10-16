# Environment

Every setting, where it lives, and the free-tier limits it runs under.

## API server (`apps/api`)

| Variable | Required | Example | Notes |
|---|---|---|---|
| `NODE_ENV` | production | `production` | Turns on the strict checks below |
| `PORT` | no | `3000` | Render sets this itself |
| `HOST` | no | `0.0.0.0` in production, `127.0.0.1` locally | |
| `DATABASE_URL` | yes | `postgres://graphinity_api:…@…/postgres` | The **restricted** login role, never the owner. Secret |
| `WEB_ORIGIN` | production | `https://graphinity.pages.dev` | The one origin allowed by CORS. Must be https |
| `TRUST_PROXY_HOPS` | production | `1` | **Measured** at deploy (SECURITY.md). No default in production |
| `IP_HASH_KEY` | yes | 64 hex chars | `openssl rand -hex 32`. Secret. Changing it resets rate-limit identities |

Locally, `npm run db:start` generates `DATABASE_URL` and `IP_HASH_KEY` into `.local/api.env`.

## Website (`apps/web`)

| Variable | Required | Example | Notes |
|---|---|---|---|
| `VITE_API_ORIGIN` | for deploys | `https://graphinity-api.onrender.com` | Goes into the CSP `connect-src`. Cloudflare builds refuse http |

`VITE_` variables are baked into the public website. **Never put a secret in one.**

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
| GitHub Actions | 2,000 minutes/month for private repos | Blocked, not billed, with no payment method |
| Web push | Free; iPhone needs Home Screen install, iOS 16.4+; no Apple developer account needed | None |

Still to confirm at signup: whether Cloudflare asks for a card for Pages or Workers, and Render's
exact bandwidth allowance.
