# ADR 0015: Search, built in measured slices

- **Status:** In progress. Part 1 (consent) accepted and built 2026-10-25. Later parts are recorded
  here as they land.
- **Owner decisions (2026-10-25):**
  1. **Both surfaces, one engine:** a Search screen and the Ask screen's "has this been asked?"
     check.
  2. **Meaning for everyone:** matching by meaning runs only on Graphinity's own server now, so it
     is for everyone, without the AI choice.
  3. **Purpose-based consent, asked once:** learning a shared search ranking from what people search
     and open needs consent, asked only once, and never again under the same purpose (model
     upgrades included).
- **Review:** a fresh-eyes review of the whole design found three consent blockers before anything
  was built. They shaped part 1:
  - **Bundled purposes:** widening `search_history` would have bundled two purposes, so declining
    improvement would cost a person their own personalization.
  - **Earlier data:** data recorded under the old purpose could be used once someone accepted the
    new one.
  - **Revocation:** "deleted when you turn it off" wasn't true of anything yet.

## Part 1: consent made accurate and purpose-based (migration 0019, schema 34)

- **A false description fixed.** `ai_personalization` still said question text is sent to Cloudflare
  Workers AI. That has been false since Cloudflare was removed (ADR 0010).
  - **Correction:** its text now says nothing goes to an outside AI, and the choice is kept for any
    future AI-assisted personal feature (policy version 3).
  - **No widening:** describing less sharing than before widens no one's consent.
- **Meaning for everyone.** The precheck, question creation, the backfill and
  `app.nearest_questions` no longer depend on that choice, and the trigger that cleared a person's
  question vectors on revoking it is dropped. Vectors are computed on Graphinity's server from
  public question text, as the word index is.
  - **Announced, not patched quietly:** the change is part of the one-time privacy update below.
  - **Backfill:** 500 questions a run instead of 20, since the own model needs no allowance.
- **A separate purpose for learning.** `search_improvement`, off by default: "Use the searches you
  make in Graphinity, the results you were shown, the ones you opened and how long you spent on
  them, to improve search for everyone."
  - **Unbundled:** it is separate from `search_history`, which stays unchanged for a person's own
    use. Declining improvement costs nothing.
  - **Nothing earlier:** it covers only data collected while it is on ("nothing from before").
  - **Turning it off deletes what it collected:** that ships with the search tables, in part 3.
    Nothing is collected under it before then.
- **Asked once.** `consent_categories.prompt_once` marks purposes to ask about.
  - **The list:** `GET /me/consents` returns `awaitingAnswer`, the ask-once purposes the person has
    never answered.
  - **Any answer ends it:** the web app's one-time sheet ("Two privacy updates") records Allow or
    Not now (closing it counts as Not now) through the usual `PUT`. It never appears again.
  - **Changing your mind:** later changes in Privacy settings never bring the sheet back.
  - **Upgrades:** a new model under the same purpose doesn't prompt.
  - **New purposes:** a new purpose would.
- **Reading time, stated truthfully.** `reading_history` said Graphinity never measures reading time.
  It now says time on a question is measured only under `search_improvement`, and only for questions
  opened from search.
- **Dialogs.** Paragraphs inside a dialog had no space between them (the existing "Delete your
  personal graph data?" dialog too). They now have it, and bold lead-ins read at the primary label
  colour.

Verified for part 1:
- **API tests:** asked once; any answer ends the asking, for good; the texts no longer mention
  Cloudflare; meaning works without the AI choice, signed in and as a visitor; a question keeps its
  vector when its asker turns the AI choice off, and is found by its own vector.
- **In a real browser:** the sheet at 320, 375 and 430 wide and on desktop, in light and dark. Tap
  targets are 44 px. Body text contrast is 7.6:1 and lead-ins 19:1. No sideways scroll. Answering
  "Not now" and reloading doesn't bring it back.
- **Browser suite:** an end-to-end test with the accessibility audit. The sign-in helpers answer the
  sheet only when the app actually asks, so it never covers another test's next step.

## Measured so far for later parts

`node scripts/benchmark-ann.mjs` (pgvector HNSW exactly as built: halfvec(768), cosine, m 24,
ef_construction 200, own-model vectors zero-padded from 128 dimensions):

| Rows | Exact p50 / p95 | HNSW ef 40 (default): recall@10, p50 | ef 160: recall@10, p50 | Index / table | Build |
|---|---|---|---|---|---|
| 10,000 | 1.7 / 1.9 ms | 0.897, 0.5 ms | 0.999, 1.2 ms | 20.5 / 16.4 MB | 2.8 s |
| 100,000 | 16.3 / 24.4 ms | **0.766**, 2.5 ms | 0.960, 8.3 ms | **204.8 / 163.9 MB** | 105 s |

What this shows:
- **The index's default setting is wrong for its purpose.** At pgvector's default `ef_search` of 40,
  it misses almost a quarter of the true nearest questions at 100k, and it can return at most 40
  rows.
- **Storage is mostly zeros.** 640 of the 768 stored dimensions are zeros, so vectors and index are
  about 370 MB at 100k questions, against a 500 MB free database.
- **Next:** both are the subject of the ANN part, which stores 128 dimensions (expand, then
  contract) and sets `ef_search` from measurement.

## Remaining parts, in order (each lands with its own evidence)

2. **The engine:** retrieval (words with corrections and synonyms, meaning), fusion, explanations;
   `POST /search` (no query text in URLs or logs); a tighter visitor rate limit; stage timings;
   kill switches.
3. **Search logs:** shown rows only, with point-in-time features; each row carries its consent;
   inserts checked in the database; deleted on revoke (trigger); export and deletion coverage. No
   numbers about other people (trust, reputation) reach the client: reasons are words.
4. **The Search screen,** and the Ask check on the same engine.
5. **ANN:** 128-dimension storage, measured `ef_search`, a filter-aware candidate count, and a
   rebuild script for the owner connection.
6. **Learning:**
   - labels only from the searcher's own actions;
   - randomized top-5 swaps on a disclosed small share of consented sessions, so position bias can
     be estimated;
   - team-draft interleaving to confirm a promotion and to demote;
   - fresh held-out data per attempt;
   - synonyms from training users only, with a margin, excluding precheck keystrokes, with a
     5-account minimum and account-age limits.
7. **Load tests** against p50 < 30 ms and p95 < 100 ms, locally and on the deployed services.
