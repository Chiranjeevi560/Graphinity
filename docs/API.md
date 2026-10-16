# API reference

Base URL: `http://localhost:3000` locally; the Render URL in production.

## Conventions

- JSON in and out. Every response carries the security headers listed in SECURITY.md and
  `Cache-Control: no-store`, unless a route says otherwise.
- Browsers may call the API only from the website's origin (CORS). No cookies are used.
- **Signed-in routes** need `Authorization: Bearer <Supabase access token>`. The server checks the
  token itself (see SECURITY.md). Order on every request: rate limit → sign-in check → body
  parsing.
- Input that doesn't match a route's schema is refused, never "fixed": unknown properties, wrong
  types and `"true"` for `true` all get 400.
- Errors always look like this, with a message written for people (extra fields only where noted):

  ```json
  { "error": "handle_taken", "message": "That name is taken. Try another." }
  ```

| Status | `error` | When |
|---|---|---|
| 400 | `invalid_request` | Missing or malformed input, or a database rule refused it |
| 400 | `invalid_handle` | Name breaks the rules. Includes `reason`: `length`, `characters`, `edges`, `dots`, `digits`, `reserved` |
| 401 | `signed_out` | No token, a bad or expired token, or the account was deleted |
| 404 | `not_found` / `no_profile` | Nothing there / set up your profile first |
| 409 | `handle_taken` / `profile_exists` / `handle_change_too_soon` | The last one includes `availableAt` (ISO time) |
| 413 | `too_large` | Body over the limit (4 KB) |
| 415 | `unsupported` | Wrong content type |
| 429 | `rate_limited` | Too many requests. `Retry-After` gives the seconds to wait |
| 500 | `server_error` | Our fault. Details are never returned or logged |
| 502 | `delete_incomplete` | Profile deleted, sign-in removal failed. Retry `DELETE /me` |
| 503 | `auth_unavailable` | Supabase's signing keys couldn't be loaded. Not the person's fault |

## The Profile object

```json
{
  "handle": "chiru.k",
  "country": { "code": "IN", "name": "India" },
  "fields": [{ "slug": "imports-customs", "name": "Imports & Customs" }],
  "joined": "2026-10",
  "handleChangeAvailableAt": null
}
```

`handleChangeAvailableAt` appears only on your own profile: `null`, or when the name may change again.

## Endpoints

### `GET /health`
Checks that the server can reach the database as its restricted role. Used by the keep-awake worker
and to confirm a deploy reached the database.
`200 {"status":"ok","schemaVersion":2}` · `503 {"status":"unavailable"}`

### `GET /meta`
The 20 fields and 250 countries for the profile form. Public. `Cache-Control: public, max-age=3600`.
`{ "fields": [{slug, name}], "countries": [{code, name}] }`

### `GET /me` (signed in)
`{ "profile": Profile }`, or `{ "profile": null }` when the person hasn't set up yet.

### `POST /me/profile` (signed in, counts as a write)
Body: `{ "handle": "Chiru.K", "country": "IN", "fields": ["imports-customs"], "adult": true }`.
The handle is trimmed and lowercased. 1-8 distinct known fields. `adult` must be exactly `true`.
`201 { "profile": Profile }` · 400 · 409 `handle_taken` / `profile_exists`

### `PATCH /me/profile` (signed in, counts as a write)
Any of `handle`, `country`, `fields` (fields replace the whole set). A name can change once every 7
days. `200 { "profile": Profile }` · 404 `no_profile` · 409 `handle_change_too_soon`

### `GET /handles/:handle` (signed in)
Live availability while typing. Signed-in only, so it can't be used anonymously to list members.
`{ "handle", "available": true }` or `{ "handle", "available": false, "reason", "message" }`.
Your own current name counts as available.

### `GET /profiles/:handle`
Public. `{ "profile": { handle, country, fields, joined } }`: no id, no timestamps beyond the
month joined. 404 `not_found` with "There’s no one with that name."

### `DELETE /me` (signed in, counts as a write)
Body: `{ "confirm": true }`. Deletes the profile and everything that cascades from it, remembers a
keyed hash of the id for 2 hours so live tokens stop working at once, then deletes the sign-in in
Supabase. `204` · `502 delete_incomplete` (safe to retry with the same token).
