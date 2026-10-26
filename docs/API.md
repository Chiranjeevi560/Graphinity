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
| 400 | `contact_details` | An answer holding a phone number, email address or invitation to message elsewhere (spec §21.2). Amounts, codes and dates are fine |
| 409 | `already_answered` / `own_question` | One answer per person per question; never on your own |
| 400 / 403 / 409 | `not_an_answer` / `reason_required` / `not_your_question` / `no_changes_left` / `not_picked` | Picking, marking, verdicts and ratings (see below) |
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
`200 {"status":"ok","schemaVersion":29,"environment":"staging","release":"<commit>"}` · `503 {"status":"unavailable"}`.
`environment` is `development`, `staging` or `production`; `release` is the commit the running image
was built from (`null` on your computer). The pipeline waits until `release` is the commit it deployed.

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

`{ questions: [{ id, title, createdAt, lastAnsweredAt }] }`: questions with at least one answer a visitor
can see, newest first, up to 5000, for the website host's sitemap (docs/SPEC.md §19.2: no
unanswered pages go to search engines). Cached for an hour.

### `POST /questions/precheck`

`{ title, details?, field? }` → `{ verdict, questions: [{ id, title, answerCount, similarity }] }`, used
while someone writes a question (docs/SPEC.md §11.1, §12.1). Same engine as `POST /search` (ADR 0015):
questions are ranked by meaning (Graphinity's own embedding, cosine) and by words (BM25, migration
0020), fused by Reciprocal Rank Fusion (k 60, the two weighted equally), within `field` when given.
Words match whole and stemmed ("imports" finds "importing"); only the last word, which may still be
half-typed, also matches the words it could become. `verdict`: `duplicate` when one is at least 0.88
similar in meaning and has an answer from the last 180 days; `related` from 0.72, or when a question
holds every word typed (exact codes and names mean little to the model), or on any word match when
meaning is unavailable; `clear` otherwise, with no questions. Up to 5 are returned: a recent duplicate
first, then those holding every word, then the rest in fused order. `similarity` is `null` for a match
by words alone.
Titles under 10 characters aren't searched. Hidden questions never appear. Once Graphinity's own
spelling model serves (ADR 0011), typos widen the word search: "cusotms" also looks for "customs",
except in the last word while it may still be half-typed, and a question holding every corrected
word counts as holding every word typed. Corrections are not returned here; the text is never changed.
Meaning is computed on Graphinity's server for every request, signed in or not (migration 0019);
nothing is sent to an outside AI. Until a model has been promoted (or with the `embeddings` switch off)
it answers by words only, and never says `duplicate`. Authentication is optional. A signed-in query is
saved only with separate `search_history` consent, at most once per exact query and field every five
minutes, and expires within 365 days. No query is sent to a commercial partner. The response's
`Server-Timing` header gives each stage's milliseconds (`embed`, `words`, `meaning`, `fetch`).

### `POST /search`

`{ query, field? }` → `{ results: [{ id, title, field, answerCount, lastAnsweredAt, reasons }],
corrections: [{ from, to }], meaning }`, for the Search screen (ADR 0015 part 2). POST, so a search
never appears in a URL, a browser history or a proxy log. Same engine as the precheck, every word
matched whole. Up to 20 results, best first. `reasons` says why each is there, in words the screen can
say: `every_word` (it holds every word searched, as typed or as corrected), `some_words`, `meaning`
(close in meaning, at least 0.72). A question found by meaning alone and less close than that is left
out. `corrections` lists the words the spelling model also searched for; the query itself is never
changed. `meaning` is `false` when matching by meaning was unavailable. Nothing about other people is
returned: no authors, trust, reputation or scores. Hidden questions never appear.

- `query`: 2 to 200 characters once cleaned. Shorter answers `{ results: [], corrections: [], meaning:
  false }`; longer, or with control characters, is 400 `invalid_query` with `reason` (`too_long`,
  `invalid_characters`). Unknown properties and wrong types are 400.
- Authentication is optional. Each signed-in person, and each visitor address, has its own allowance
  (a burst of 30, then one every 2 seconds) on top of the server-wide limits; past it, 429
  `rate_limited` with `retry-after`.
- With the `search` switch off: 503 `search_off`.
- A signed-in search is saved to the person's own `search_history` only with that consent, as above.
- `Server-Timing` as for the precheck.
- Order: the engine's fused order, or, with the owner's `learned_search_ranking` on and a learned model
  serving, that model's (ADR 0015 part 6). For a recorded search only, the order may also swap two
  neighbours among the top five, or mix in a ranking being compared, as the privacy page says.
- With `search_improvement` on (and only then), the search, the results shown in order with what the
  ranking knew about each, are recorded to improve search (ADR 0015 part 3), and the response carries
  `searchId`, a random id. Without it, there is no `searchId` and nothing is recorded. Visitors are
  never recorded. A choice turned off and on again while a search runs records nothing for it.

### `PUT /searches/:searchId/opens/:position` (signed in)

`{ dwellMs? }` → 204. Records that the result at `position` (1 to 20) of a recorded search was
opened, and, sent again when the person leaves the question, how long it was read (`dwellMs`, 0 to
3,600,000; the longest reported is kept). Only the person who searched, only while
`search_improvement` is on. Nothing to record against (someone else's search, a position not shown,
the choice turned off): 404 `not_recorded`. Its own allowance per person (60, then one a second).
Unknown properties and wrong types are 400.

### `GET /questions/:id`

`{ question: summary + { body }, answers: [{ id, body, answerer: { handle }, createdAt, helpful, author, claim,
minorityPinned, rank }], selection, consensus }`, answers in order of the spec's rank Ω (§11.5: 0.30 picked,
0.22 Wilson of the asker's vote, 0.18 author's reputation, 0.12 their group's share, 0.10 trust, 0.08
specificity). `author` is `{ reputation, accepted, medal }` in this question's field. `claim` is the
amount the answer reports (`{ minor, currency }`, minor units) or `null`. `consensus` is `null` until 3
visible answers report an amount, then `{ confidence, clusters: [{ currency, lowMinor, highMinor, share,
answers }] }`: groups within 8%, largest share first, shares weighted by authors' standing;
`minorityPinned` marks the strongest answer of every smaller group. `selection` is `null` until the asker
picks, then `{ answerId, changesLeft, correct, stars }` (`answerId` is `null` if the picked answer's author deleted their
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

### `PUT /answers/:id/rating` (asker only, counts as a write)

`{ stars }` (a whole number, 1 to 5) → `{ rating: { stars } }`. Only for the current pick (409
`not_picked` otherwise); sending again replaces it. A pick rated 2 stars or less counts against its
author's reputation instead of for it.

### Standing

`GET /profiles/:handle` and `GET /me` also return:

```json
"standing": {
  "points": [{ "field": { "slug": "imports-customs", "name": "Imports & Customs" }, "points": 15,
              "medal": "verified", "reputation": 34.6, "accepted": 3, "wilson": 0.44 }],
  "trust": { "correct": 4, "askers": 5 }
}
```

Per field, as docs/SPEC.md §11.3 defines it: `reputation` (0 to 100) is TrueSkill's cautious
μ − 3σ × 2, replayed from every judgement on the person's answers in that field (a standing pick or
helpful mark is a win unless the pick was rated 2 stars or less; "turned out right" a win, "wrong" a
loss); `accepted` counts picks that still stand; `wilson` is the Wilson lower bound of answers picked or
marked helpful over answers given. `medal`: `verified` (3 accepted, reputation 25), `bronze` (10, 45,
Wilson 0.65), `silver` (30, 68, 0.78), `gold` (75, 85, and the top 1% by accepted answers among people
active in the field and country in 90 days), else `null`. `points` stays as the ledger total. `trust`
counts each asker once (their latest verdict) and is `null` until 3 different askers have said. Who gave whom points is never shown.

The pair cap: one asker can give one person points 3 times in 30 days. After that, picks and marks
still work, but no points move for them.

## Routing and the inbox

New questions are put to people in staged waves by a job inside the server (every minute, and
straight after each new question), as docs/SPEC.md §11.2 sets out: 5 people at once; 5
more 20 minutes after asking if fewer than 3 of them have opened it or answered; 5 more at 60 minutes
while it has fewer than 3 answers (the least a consensus needs). People are chosen from those who
know the question's field, by a score (docs/GRAPH.md): 35% points in that field, 20% same country,
20% how many questions put to them in the last 60 days they answered (one sent in the last day counts
only once answered; removed answers don't count), 15% how often askers said their picked answers in
that field turned out right, 10% chance. One place in each wave of 5 is kept for people who joined in
the last 14 days. Nobody gets more than 3 a day (enforced by the database too), and never their own
question. Who was asked is visible only to them.

### `GET /me/inbox` (signed in)

`{ questions: [summary + { routedAt, seen }], unseen }`, newest first, up to 30. Opening a question
(`GET /questions/:id` while signed in) marks it seen.

## The graph

### `GET /graph`

Public, cached 5 minutes. `{ members, fields: [{ slug, name, members }], people: [[fieldIndex…]], links:
[{ a, b, shared }], activity: { lastDay: { questions, answers }, recent: [{ field, kind }] } }`. `people`
is a random sample of up to 300 members, each only as the positions in `fields` of the fields they know:
no names or ids; it is for drawing, not counting. `links` counts, from everyone, how many people know
both of two fields (positions, `a < b`, only pairs someone knows together); `shared` is `null` under 5,
decided in the query, so a small overlap never leaves the server as a number.
`members` counts everyone with a profile once.
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

- `GET /review` → `{ items: [{ kind, id, questionId, text, author, reports, reasons, notes, hidden, lastReportAt }], sharedNetworks: [{ giver, recipient, points }], collusion: [{ id, members: [{ handle }], picks, expected, lift, foundAt, seenAt }] }`. `collusion` lists open groups picking each other (ADR 0017), the most extreme first, at most 50
- `POST /review/collusion` `{ id, decision: 'dismiss' | 'confirm' }` → `{ decision: { id, decision, awardsTakenBack } }`. Confirming takes back every award the members gave each other. 404 `not_found`, 409 `already_decided`, 403 `own_group` (the moderator is in it), 503 `busy` (points were moving for them; nothing changed, try again)
- `POST /review/decision` `{ kind, id, decision: "keep" | "remove" }`
- `POST /review/block` `{ handle, reason? }`, `DELETE /review/block` `{ handle }` (400 `invalid_reason` for a reason over 500 characters or with hidden characters)
- `GET /ops/status` → `{ objectives: [{ name: 'availability' | 'latency', target, good, budgetRemaining, burn: { hour, day } }], alerts: [{ objective, severity: 'page' | 'ticket', long, short, burnLong, burnShort }], routes: [{ method, route, requests, errors, p50, p95, p99 }], jobs: [{ job, expectedSeconds, lastSuccessAt, lastFailureAt, lastErrorKind, runs, failures, healthy }] }` (ADR 0020). `good` is the 30-day share of good requests (null before any); routes are the 20 slowest by p95 over the last day, in ms; nothing about any person

A blocked person can still read and delete their account, but can't ask, answer or report
(403 `blocked`). `GET /me` also returns `moderator` and `blocked`.

### Limits for new accounts

In its first day an account can ask 3 questions and give 10 answers (429 `new_account_limit`).

## Consent and personal data

### `GET /me/consents` (signed in)

Returns the purpose inventory and current choices. Optional categories default to `enabled: false`.
Each category includes its purpose, information description, retention statement, recipients, and
policy version. `identity` is required to provide the account service and cannot be disabled here.
`awaitingAnswer` lists the ask-once purposes (today `search_improvement`) the caller has never answered:
the web app asks about them once, and any answer recorded through `PUT` removes them for good.
`unanswered` lists every optional purpose put to the caller that they have never answered: the
welcome consent screen (ADR 0023) asks about exactly these, and any recorded answer removes one.
Purposes not put to the caller are left out: the advertising purposes (`ads_*`, ADR 0022) while the
`ads` switch is off, or where the rule for the caller's country isn't approved by a lawyer or
prohibits it (migration 0035), unless the caller has one on, so they can always turn it off.

### `PUT /me/consents` (signed in, counts as a write)

`{ choices: [{ category, enabled }], source? }` updates one or more independent choices; `source` is
`settings` (the default) or `onboarding` (the welcome screen), kept in the history. Duplicate and
unknown categories are refused, and so is turning on a purpose that isn't put to the caller now
(`unknown_consent_category`); turning one off is always accepted. Changed choices append to an account-private audit history; an
unchanged choice creates no extra event. `GET /me/consents/audit` returns the caller's latest 500
choice events. Audit history cannot be edited or deleted through the API; account deletion removes
it with the account.


### `GET /me/ad-interests` (signed in)

The caller's advertising profile (ADR 0022): `{ interests: [{ field: { slug, name }, strength, updatedAt }] }`,
strongest first; `strength` is 0–100 relative to the strongest. Empty unless they allow personalized ads
and the platform is on. `DELETE /me/ad-interests/:field` (counts as a write) removes one topic
(`{ removed: { field } }`, 404 `not_found` if absent). The data export includes `adInterests`.


### Ads on a page (ADR 0022 part 4)

- `POST /ads/select` `{ placement: 'search' | 'question', questionId?, query?, field? }` (signed in optional)
  → `{ ads: [{ token, headline, body, domain, advertiser, label: 'Sponsored' }] }`. Empty while advertising is off,
  and for a hidden question. Asked for on its own: no knowledge response ever includes ads.
- `POST /ads/click/:token` → `{ destination }`; counted once, charged only when valid; 404 `not_found`
  when unknown, older than an hour, or advertising is off. Both have their own rate limit (429).


### Audiences (ADR 0022 part 7)

Available while `ads` and `ads_audiences` are on (otherwise 404 `ads_off`, or 403 `not_allowed`).

- `POST /ads/advertisers/:id/audiences` (a member of the business) with `{ name, kind }` and, by kind:
  `segment` → `rule: { all: [condition…], any?: [condition…] }` (a condition is `{ interest, min? }`,
  `{ country }` or `{ field }`); `retargeting` → `campaignId` (one of the business's campaigns);
  `lookalike` → `seedAudienceId` (one of its audiences, not a look-alike) and `expansion` (0.01, 0.02 or 0.05).
  → 201 `{ audience: { id, name, kind, status: 'building', size: null, builtAt: null } }`; 400 `invalid`
  (wrong fields for the kind), 400 `not_own` (another business's campaign or audience), 400
  `too_many_audiences` (50).
- `GET /ads/advertisers/:id/audiences` → `{ audiences: [{ id, name, kind, status, size, builtAt }] }`.
  `status` is `building`, `ready` or `insufficient` (under 100 people); `size` is rounded down to a
  hundred, and `null` unless ready. Who is in an audience is never returned.
- `DELETE /ads/audiences/:id` → `{ removed: true }`. Campaigns targeting it then match nobody.
- Targeting (`PUT /ads/campaigns/:id/targeting`) accepts `{ kind: 'audience', value: <audience id> }`,
  one of the business's own.

### Conversions (ADR 0022 part 6a)

- `POST /ads/advertisers/:id/keys` (owner) → 201 `{ key: { value, prefix } }`, shown once; 400 `too_many_keys` (10),
  403 `not_owner`. `DELETE /ads/advertisers/:id/keys/:prefix` revokes one for good.
- A click by someone who allows measurement returns its destination with `gr_click=<id>` added.
- `POST /ads/conversions` with `authorization: Bearer grk_…` and `{ clickId, externalId, valueMicros?, currency?, convertedAt? }`
  → 201 `{ conversion: { counted: true } }`, or 200 with `duplicate: true` for an order id already reported;
  401 `bad_key` for a malformed key; 404 `not_counted` for any other refusal, all alike.
- `GET /ads/campaigns/:id/report` (a member of the business) → 200 `{ report: { days: 30, impressions, clicks,
  spentMicros, businessConversions, joinedPaths, credited: { last_click, first_touch, linear, time_decay, position,
  data_driven } } }`; each model gives `{ conversions, valueMicros }`, the campaign's share of the business's
  conversions and their value (ADR 0022 part 6b). 404 `not_found` for anyone else, moderators included.

### Advertising: advertisers, campaigns, ads, targeting (ADR 0022 part 3)

Everything here answers 404 `ads_off` while the `ads` switch is off. Money is in micro-units of the
campaign's currency (1 rupee = 1,000,000), as whole numbers.

- `POST /ads/advertisers` `{ name, country }` → 201 `{ advertiser: { id, name, country, status: 'pending' } }`;
  the caller becomes its owner. 400 `too_many_advertisers` (3 per person), 403 for blocked accounts.
- `GET /ads/advertisers` → `{ advertisers: [{ id, name, country, status, role }] }`, the caller's own.
- `POST /ads/advertisers/:id/campaigns` `{ name, objective, dailyBudgetMicros, maxCpcMicros, currency?, totalBudgetMicros?, frequencyCap?, startsAt?, endsAt? }`
  → 201 `{ campaign }`; `GET /ads/advertisers/:id/campaigns` → `{ campaigns }`.
- `PATCH /ads/campaigns/:id` `{ name?, status?: 'active' | 'paused' | 'ended', dailyBudgetMicros?, maxCpcMicros?, frequencyCap? }`;
  409 `not_allowed_now` for a move backwards (an ended campaign stays ended).
- `POST /ads/campaigns/:id/creatives` `{ headline, body, destinationUrl }` → 201 `{ creative: { id, status: 'pending' } }`;
  400 `invalid` for lengths, hidden characters or a destination that isn't plain `https`.
- `PUT /ads/campaigns/:id/targeting` `{ targets: [{ kind: 'field' | 'keyword' | 'country' | 'interest', value }] }`
  replaces the set; a refused set leaves the old one.
- Moderators: `GET /ads/review` → `{ advertisers, creatives }` waiting; `POST /ads/review/advertiser` `{ id, status: 'active' | 'suspended' }`;
  `POST /ads/review/creative` `{ id, decision: 'approve' | 'reject', reason? }` (a rejection needs a reason).
  403 `own_advertiser` for one's own business.

### Personal graph

- `GET /me/graph` returns the caller's nodes, edges, signal events, and collections for inspection.
  Generated temporal edges include `evidenceSignalId`, linking the edge to its source event.
- `POST /me/graph/nodes` accepts `{ category, entityType, label, attributes?, source? }`. It requires
  active consent for the category, supports only an allow-listed set of first-party entity types, and
  enforces the entity type's data-use category (for example, `purchase` requires `purchase_history`,
  while expertise and learning nodes require `learning_expertise`), and bounds attributes to 2 KiB.
  Unknown categories return 400, mismatched entity/category pairs return 400, and disabled categories
  return 403.
- `POST /me/graph/edges` accepts `{ category, sourceNode, targetNode, relation, weight?, confidence? }`.
  Both endpoints must be the caller's nodes in currently consented categories, the edge category must
  also be active, and self-edges are refused. Weight and confidence are bounded from 0 to 1.
- `POST /me/graph/insights` accepts `{ seedNodeIds: [uuid, ...], limit? }`. It analyzes only the
  caller's nodes and edges whose purpose remains active. It returns algorithm version, iteration
  counts, per-node PageRank, personalized PageRank, deterministic communities, and recommendation
  scores (`personal-graph-v2`, ADR 0012: Louvain communities, NetMF embeddings, edges weighted by
  confidence and, for edges observed from your activity, halved every 90 days). Seeds are distinct
  and limited to 10; graph analysis is capped at 1,000 nodes, 5,000 edges, and 100 returned
  results. Results are computed on demand and are not persisted as user features. Analyses run one
  at a time off the request thread; when too many are waiting it returns 503 `graph_busy` ("Graph
  analysis is busy right now. Try again in a few seconds.").
- `DELETE /me/graph/nodes/:id` removes only the caller's node; linked edges cascade. Owners can
  inspect and remove stored information after revoking its optional consent.
- `GET /me/data-export` returns a JSON export of the caller's profile, their questions and answers,
  selections, helpful marks, routed questions, reports, points, network activity by day, push-device
  identifiers, consent inventory/history, and personal graph records. It excludes provider
  authentication secrets and other people's records. `DELETE /me/graph` deletes all graph nodes,
  edges, collections, and signal events but leaves core account content and consent history intact.
  Account deletion cascades personal graph and consent data.

Question asks, views, selections, and authored/helpful answers with active `interaction_history` or
`reading_history` consent are projected asynchronously by a bounded Postgres worker. It creates
topic and question nodes plus one weighted edge per event; labels never copy question text. The
worker rechecks consent when it processes an event. Deleting or expiring a source event removes its
evidence edge. The worker claims at most 100 events per 15-second pass (the database function caps
any call at 500); unsupported events and events whose consent was revoked are acknowledged without
projection.

The graph tables are inaccessible to anonymous and Supabase browser roles. RLS is enabled and
forced; inserts require the matching consent in PostgreSQL as well as in the API. No automatic
purchase or travel event collector is wired yet, so those categories are not currently used to
personalize or commercialize a person's experience. Partner sharing and enterprise data products
are also not implemented; their catalog entries describe intended purposes, not an active data
transfer.

### `GET /me/recommendations` (signed in)

Returns at most 20 public questions with their field, answer count, ranking score, algorithm version
and a reason in words. `feed_personalization` is independently opt-in and defaults off. When it is on,
`feed-rrf-v3` (ADR 0016) builds the list in tiers, each filling only what the one before left:

1. **The person's own recent searches,** from the Search screen and the Ask check, run through the
   search engine, only while `search_history` is on. **Questions answered by the same people** as
   ones they opened (public answers), only while `reading_history` is on.
2. **Questions similar to ones they opened,** by meaning (by words while no meaning model serves),
   only while `reading_history` is on.
3. **Their profile fields, and recent questions.**

Within a tier, each source contributes `1 / (60 + rank)`. The reason names the strongest contribution:

- "Related to your recent Graphinity searches"
- "Answered by people who answered one you opened"
- "Similar to a question you opened"
- "In one of your selected topics"
- "Recently asked in Graphinity"

It excludes the caller's own questions, hidden questions, questions they answered or already opened,
and questions older than 180 days. It stores no recommendation history, uses no affiliate or
commercial signal, and doesn't optimize clicks. Revoking search or reading history takes effect on the
next request. The result is a finite discovery list, not an endless feed.

