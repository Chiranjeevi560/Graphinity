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
| 400 | `invalid_title` / `invalid_details` / `invalid_answer` | Text breaks the rules. Includes `reason`: `too_short`, `too_long`, `invalid_characters` (controls other than line breaks, and direction overrides and isolates U+202A-202E, U+2066-2069) |
| 400 | `invalid_handle` | Name breaks the rules. Includes `reason`: `length`, `characters`, `edges`, `dots`, `digits`, `reserved` |
| 401 | `signed_out` | No token, a bad or expired token, or the account was deleted |
| 403 | `no_profile` | Asking or answering before setting up a profile |
| 404 | `not_found` / `no_profile` | Nothing there / set up your profile first |
| 409 | `handle_taken` / `profile_exists` / `handle_change_too_soon` | The last one includes `availableAt` (ISO time) |
| 409 | `already_answered` / `own_question` | One answer per person per question; never on your own |
| 400 / 403 / 409 | `not_an_answer` / `reason_required` / `not_your_question` / `no_changes_left` / `not_picked` | Picking, marking and verdicts (see below) |
| 413 | `too_large` | Body over the limit (4 KB; 48 KB when asking or answering while signed in) |
| 415 | `unsupported` | Wrong content type |
| 429 | `rate_limited` | Too many requests. `Retry-After` gives the seconds to wait |
| 500 | `server_error` | Our fault. Details are never returned or logged |
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
Body: `{ "confirm": true }`. Deletes the profile and everything that cascades from it, records the
sign-in as pending removal, locks the account out (a keyed hash, 2 hours), then asks Supabase to
delete the sign-in.

- `204`: done, including the sign-in at Supabase.
- `202 { "status": "finishing", "message": "Your account is deleted. Removing your sign-in is taking
  longer than usual; it will finish automatically." }`: Supabase didn't answer. The server retries
  every 5 minutes at first, backing off to 6 hours, until Supabase confirms. The account is refused
  everywhere meanwhile, and the database won't accept a new profile for it. Calling again is safe.

## Questions and answers

Text is plain. Titles are made one line with single spaces; details and answers keep line breaks
(Windows breaks become `\n`, tabs become two spaces); both are trimmed. Lengths count characters as
people do (an emoji is one). Limits: title 15–150, details up to 5,000, answer 20–10,000. Ids are
positive integers, sent as text. No response contains anyone's account id.

The question summary:

```json
{
  "id": "42",
  "title": "How do I import a watch into the UAE?",
  "field": { "slug": "imports-customs", "name": "Imports & Customs" },
  "country": { "code": "AE", "name": "United Arab Emirates" },
  "asker": { "handle": "chiru" },
  "createdAt": "2026-10-18T10:00:00.000Z",
  "answerCount": 3
}
```

`country` is `null` for a question about anywhere.

### `GET /questions?before=:id`

Newest first, 20 at a time: `{ questions: [summary], next }`. Pass `next` as `before` for the
following page; `next` is `null` on the last page.

### `GET /sitemap/questions`

The newest 5,000 questions anyone may see, `{ questions: [{ id, title, createdAt }] }`, for the
website host's sitemap. Cached for an hour.

### `GET /questions/similar?q=:text`

Up to 5 questions matching any word of `q`, including a word still being typed:
`{ questions: [{ id, title, answerCount }] }`. Used while someone writes a question. Text with no
letters or digits returns an empty list.

### `GET /questions/:id`

`{ question: summary + { body }, answers: [{ id, body, answerer: { handle }, createdAt, helpful }], selection }`,
answers oldest first. `selection` is `null` until the asker picks, then
`{ answerId, changesLeft, correct }` (`answerId` is `null` if the picked answer's author deleted their
account; `correct` is `null` until the asker says how it turned out). 404 `not_found` if there's no such question.

Two parts appear only for one person each, and are left out for everyone else:

- `routing` (the asker, once it went out): `{ waves, asked, inCountry }`, how many waves went out, how
  many people they reached, and how many of those live in the question's country. Numbers only,
  never who; under 5 is `null` ("a few"), since in a small field an exact number set against public
  profiles could point at who.
- `whyYou` (someone it was put to): `{ sameCountry, fieldPoints, trustPct, answeredPct, newcomer }`,
  as they stood when it was sent. `trustPct` and `answeredPct` are `null` with nothing to go on yet;
  all are `null` on routes made before reasons were kept.

### `POST /questions` (signed in, counts as a write)

`{ title, details?, field, country? }` → 201 `{ question: { id } }`. `country` may be `null`.

### `POST /questions/:id/answers` (signed in, counts as a write)

`{ body }` → 201 `{ answer: { id } }`. 409 `own_question` or `already_answered`, 404 `not_found`.

## Picking, helpful marks and standing

Points move inside the database when a pick or mark is saved (see SECURITY.md). Ids are sent as text.

### `PUT /questions/:id/selection` (asker only, counts as a write)

`{ answerId, reason? }` → `{ selection: { answerId, changesLeft } }`. The first pick gives the answer's
author 5 points in the question's field. Changing it needs `reason`: `turned_out_wrong`,
`better_answer_later` or `picked_by_mistake`; at most 2 changes. A change takes the 5 points back
from the old author and gives them to the new one. `turned_out_wrong` also records that the old pick
turned out wrong. Picking the same answer again changes nothing.

### `POST /answers/:id/helpful` (asker only, counts as a write)

→ `{ helpful: true }`. 2 points to the author, once per answer; marking twice is fine and changes
nothing. Marks can't be taken back.

### `PUT /answers/:id/verdict` (asker only, counts as a write)

`{ correct }` → `{ verdict: { correct } }`. Only for the current pick (409 `not_picked` otherwise).

### Standing

`GET /profiles/:handle` and `GET /me` also return:

```json
"standing": {
  "points": [{ "field": { "slug": "imports-customs", "name": "Imports & Customs" }, "points": 15, "medal": "bronze" }],
  "trust": { "correct": 4, "askers": 5 }
}
```

Medals per field: bronze at 10 points, silver at 50, gold at 200. `trust` counts each asker once (their
latest verdict) and is `null` until 3 different askers have said. Who gave whom points is never shown.

The pair cap: one asker can give one person points 3 times in 30 days. After that, picks and marks
still work, but no points move for them.

## Routing and the inbox

New questions are put to people in waves by a job inside the server (every minute, and straight
after each new question): 10 people at once, 30 more after 15 minutes without an answer, 100 more
after another hour. People are chosen from those who know the question's field, by a score
(docs/GRAPH.md): 35% points in that field, 20% same country, 20% how many questions put to them in
the last 60 days they answered (one sent in the last day counts only once answered; removed answers
don't count), 15% how often askers said their picked answers in that field turned
out right, 10% chance. Two places in every ten are kept for people who joined in the last 14 days. Nobody gets more
than 5 a day, and never their own question. Who was asked is visible only to them.

### `GET /me/inbox` (signed in)

`{ questions: [summary + { routedAt, seen }], unseen }`, newest first, up to 30. Opening a question
(`GET /questions/:id` while signed in) marks it seen.

## The graph

### `GET /graph`

Public, cached 5 minutes. `{ fields: [{ slug, name, members }], people: [[fieldIndex…]], activity:
{ lastDay: { questions, answers }, recent: [{ field, kind }] } }`. `people` is a random sample of up to
300 members, each only as the positions in `fields` of the fields they know: no names or ids.
`recent` is the last 40 questions (`kind: "question"`) and answers in the last day, newest first,
by field. Hidden and removed posts are left out.

## Live updates

### `GET /events` (signed in)

A stream of server-sent events while the site is open:

```
event: answered
data: {"questionId":"42"}
```

`routed` (a question was put to you), `answered` (someone answered your question) and `sent` (a
wave of your question went out; live only, never a push). Messages carry
only the question id; screens fetch the rest the normal way. A comment line every 10 seconds keeps
the connection open. The stream ends a minute before the sign-in token expires; the website then
reconnects with a fresh token, so a deleted or signed-out account stops hearing. At most 3 open per
person and 300 in total (429 past that). Read it with `fetch` and the `authorization` header
(`EventSource` can't send one).

## Notifications (web push)

### `GET /push/key`

`{ publicKey }`: the key browsers subscribe with. 404 `push_off` when the server has no push keys.

### `PUT /me/push` (signed in, counts as a write)

`{ endpoint, keys: { p256dh, auth } }` (exactly these fields) → `{ push: { on: true } }`. The endpoint must be
a browser push service (Google, Mozilla, Apple, Microsoft) over https: 400 `not_a_push_service`
otherwise. 409 `device_in_use` if this browser is registered to another account (subscribe afresh
and try again); 409 `too_many_devices` past 10.

### `POST /me/push/status` (signed in)

`{ endpoint }` → `{ push: { on } }`: whether this browser gets *your* notifications. A browser's
subscription may belong to whoever used it before, so the website asks rather than trusting it. A POST
so the address stays out of URLs and logs.

### `DELETE /me/push` (signed in, counts as a write)

`{ endpoint }` → `{ push: { on: false } }`. Only your own devices.

Pushes go out for the same events as the live stream (`routed`, `answered`), encrypted for the
device: `{ title, body: the question's title, questionId }`. A device the push service reports gone
(404/410) is removed.

## Reporting and moderation

### `POST /questions/:id/report`, `POST /answers/:id/report` (signed in, counts as a write)

`{ reason, note? }` → 201 `{ report: { received: true } }`. `reason`: `spam`, `abuse`, `private_info`,
`misleading`, `other`; `note` up to 500 characters. Reporting the same post again changes nothing (and
says the same). 400 `own_post`, 403 `blocked`. Reports are private: only moderators see them, and
not who sent them on the page. A post reported by 3 people with accounts over a day old, since the
last moderator decision, is hidden from everyone but its author (who sees `hidden: true` on it) and
moderators.

### Moderators only (403 `not_a_moderator` otherwise)

- `GET /review` → `{ items: [{ kind, id, questionId, text, author, reports, reasons, notes, hidden, lastReportAt }], sharedNetworks: [{ giver, recipient, points }] }`
- `POST /review/decision` `{ kind, id, decision: "keep" | "remove" }`
- `POST /review/block` `{ handle, reason? }`, `DELETE /review/block` `{ handle }` (400 `invalid_reason` for a reason over 500 characters or with hidden characters)

A blocked person can still read and delete their account, but can't ask, answer or report
(403 `blocked`). `GET /me` also returns `moderator` and `blocked`.

### Limits for new accounts

In its first day an account can ask 3 questions and give 10 answers (429 `new_account_limit`).

