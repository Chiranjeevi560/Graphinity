# API reference

Base URL: `http://localhost:3000` locally; the Render URL in production.

## Conventions

- JSON in and out. Every response carries the security headers listed in SECURITY.md and
  `Cache-Control: no-store`.
- Browsers may call the API only from the website's origin (CORS). No cookies are used.
- Errors always have this shape, with a message written for people:

  ```json
  { "error": "rate_limited", "message": "Too many requests. Wait a minute, then try again." }
  ```

| Status | `error` | When |
|---|---|---|
| 400 | `invalid_request` | Missing or malformed input |
| 404 | `not_found` | No such address |
| 413 | `too_large` | Body over the limit (4 KB before sign-in) |
| 415 | `unsupported` | Wrong content type |
| 429 | `rate_limited` | Too many requests. A `Retry-After` header gives the seconds to wait |
| 500 | `server_error` | Our fault. Details are never returned or logged |

## Endpoints

### `GET /health`

Checks that the server can reach the database as its restricted role. Used by the keep-awake
worker, and to confirm a deploy reached the database.

- `200 {"status":"ok","schemaVersion":1}`
- `503 {"status":"unavailable"}`: the database didn't answer within 3 seconds.
