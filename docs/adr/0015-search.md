# ADR 0015: Search, built in measured slices

- **Status:** In progress. Part 1 (consent) accepted and built 2026-10-25. Part 2 (the engine)
  built 2026-10-26. Later parts are recorded here as they land.
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

## Part 2: one engine, BM25 by words, `POST /search` (migration 0020, schema 35)

`apps/api/src/search/engine.ts` serves both the Ask check and the new `POST /search`. In order:

1. **Meaning:** the text is embedded on Graphinity's server; `app.nearest_questions` returns up to 50.
2. **Words:** `app.word_search` scores BM25 and returns up to 50.
3. **Fusion:** reciprocal rank fusion of the two.
4. **Fetch:** the details are read as the reader, under row-level security.

Each stage is timed into `Server-Timing`.

### The word ranking was the problem, measured

`node scripts/benchmark-search.mjs` runs the engine itself on a real migrated database. The questions
are synthetic (`scripts/lib/synthetic-questions.mjs`). The model is trained the way the daily job
trains it, on everything but the held-out questions. Each query is a held-out question's details,
and its title is the one right answer. MRR (1 when the right answer comes first) with a paired 99%
bootstrap; 500 queries.

| 10,000 questions | Words MRR | Word stage p50 / p95 | Whole search p50 / p95 |
|---|---|---|---|
| Before: `ts_rank_cd`, every word a prefix | 0.17 | 84 / 108 ms | 89 / 132 ms |
| After: BM25 in `app.word_search` | **0.98** (+0.81, 0.78 to 0.84) | **13 / 22 ms** | **16 / 26 ms** |

| 100,000 questions | Words MRR | Word stage p50 / p95 | Whole search p50 / p95 |
|---|---|---|---|
| Before | 0.02 | 919 / 1,627 ms | (meaning stage below) |
| After | **0.87** (+0.85, 0.83 to 0.88) | **9.5 / 15.6 ms** | **402 / 1,165 ms: misses the target** |

**The target is met at 10,000 questions and missed at 100,000, because of meaning, not words.** The
meaning stage (`app.nearest_questions`, unchanged by this part, and already used by the Ask check)
took 389 ms p50 and 1,140 ms p95 at 100,000, against 1.3 ms at 10,000, and found the right question in
its top 10 only 30% of the time. Diagnosed on a kept 100,000-question database:
- **The index didn't fit in memory.** Zero-padded to 768, it was 195 MB against 128 MB of shared
  buffers, so searches read it from disk. Built once after a bulk load, instead of grown insert by
  insert, it took 36 / 201 ms.
- **pgvector's default `ef_search` (40) returns at most 40 rows,** so a search for 50 lost a fifth of
  the true neighbours. Against an exact scan, recall@50 was 0.80 at 40 and 0.99 at 100.
- **The 30% is mostly the model, not the index.** These synthetic questions differ mainly by item and
  place codes, which a meaning model can't tell apart and words can.

Part 5 (ANN) takes it next; until then the
engine is a strict improvement on what served before at every size measured. Fusion weights at
100,000: equal and the spec's tie (difference -0.001, 99% interval -0.005 to 0).

The causes, each confirmed by measurement:

- **Every typed word was a prefix,** so "item1" also matched "item10" to "item1999" and "in" matched
  "india" and "income". Only the Ask check needs a prefix, and only for its last word. The Search
  screen matches whole words.
- **`ts_rank_cd` ignores how rare a word is.** BM25 doesn't.
- **Row-level security forced a full scan.** It runs its hidden-question check on every row, and the
  planner can't estimate an OR of words, so any ranking computed under it read every question (EXPLAIN:
  87 of 115 ms in a sequential scan). `app.word_search` runs as the schema owner, like
  `app.nearest_questions`, and leaves hidden questions out itself.

### What `app.word_search` does

- **BM25** (k1 1.2, b 0.75, Lucene's idf) on the stored tsvector's stemmed lexemes, so words are split
  and stemmed exactly as the index stores them, Indian scripts included.
- **Title words count twice** (BM25F weights 2 and 1).
- **Candidates:** the rarest query words whose questions add up to 1,000 (MaxScore's essential lists);
  commoner words still add to those candidates' scores. One common word alone: its newest 2,000.
  - A budget of 250, 500, 1,000 or 4,000 gave the same quality on this data, at 4.6, 5.5, 18 and 46 ms
    p50 (prototype). The synthetic questions' rare item and place codes carry all the signal, so the
    data can't show what a small budget costs on real queries.
  - 1,000 keeps the stage inside a third of the 100 ms target with the most headroom for real ones.
- **Word counts:** in how many questions each word appears (`app.search_lexemes`), kept exact by
  statement-level triggers on insert, edit and delete. A new rare word is searchable at once, and a
  periodic refresh would miss it.
  - `app.rebuild_search_stats()` recounts after anything that bypasses triggers (docs/RUNBOOK.md).
  - The benchmark's bulk load is such a case: before the recount, word search found nothing.

### The alternative considered: an inverted index in the API's memory

A Lucene-style index in typed arrays would score in well under a millisecond. It was rejected for now:

- **Egress:** every server start would reload it from the database. At 100,000 questions that is about
  20 MB a load, against Supabase's 5 GB monthly egress.
- **Two copies:** two servers would each hold one, with their own staleness.
- **Time:** the database version already meets the latency target.

Revisit past about a million questions, or if the word stage stops meeting its share of the target.

### Fusion weights: the spec's 0.65 / 0.35 replaced by equal weights

At 10,000 questions, after BM25:

| Ranking | MRR |
|---|---|
| Words alone | 0.98 |
| Meaning alone | 0.67 |
| Fused, 0.65 meaning / 0.35 words (the spec) | 0.85 |
| Fused, equal weights | 0.89 |
| Fused, 0.35 meaning / 0.65 words | 0.92 |

Before BM25, meaning alone (0.67) beat the spec's fusion (0.61). Which ranking deserves more weight
depends on the data, and this synthetic data favours words: every question carries unique item and
place codes, which real queries often won't.

- **Not tuned to this data:** it would be tuning to an artefact.
- **Chosen:** unweighted RRF (Cormack et al. 2009), the literature's default, which also beats the
  spec's weights here (+0.04 MRR, 99% interval 0.03 to 0.06).
- **Next:** part 6 learns the weights from consented searches, on fresh held-out data.

### `POST /search`

- **POST,** so a search is never in a URL, a history or a log.
- **Whole words.** The spelling corrections are searched too and returned as `corrections`.
- **Up to 20 results.** Reasons are words: `every_word`, `some_words`, `meaning`. A result found by
  meaning alone must be at least the spec's "related" (0.72), so the nearest questions to anything
  never pad the page.
- **Nothing about other people:** no authors, trust, reputation or scores.
- **Limits:** each person and each visitor address gets a burst of 30, then one search every 2 s, on
  top of the server-wide limits.
- **The `search` switch** turns the endpoint off; the Ask check keeps working.
- **Own history:** a signed-in search goes to the person's own history only under `search_history`.

Verified for part 2: see the commit. Tests through the API and the database:

- BM25F scores exactly to the formula.
- The statistics equal a full recount after inserts, an edit, an embedding write and a batch delete.
- Whole words versus completing the word being typed.
- Spelling corrections; field; hidden questions, through both functions.
- Wildcard escaping; the API role refused on the statistics; the kill switch; per-person and
  per-address limits; the exact keys returned.

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

2. ~~The engine~~: built (above). Synonyms come with learning (part 6).
3. **Search logs:** shown rows only, with point-in-time features; each row carries its consent;
   inserts checked in the database; deleted on revoke (trigger); export and deletion coverage. No
   numbers about other people (trust, reputation) reach the client: reasons are words.
4. **The Search screen,** and the Ask check on the same engine.
5. **ANN, next:** the meaning stage misses the latency target at 100,000 questions (above). Its query
   plan, 128-dimension storage, measured `ef_search`, a filter-aware candidate count, and a rebuild
   script for the owner connection.
6. **Learning:**
   - labels only from the searcher's own actions;
   - randomized top-5 swaps on a disclosed small share of consented sessions, so position bias can
     be estimated;
   - team-draft interleaving to confirm a promotion and to demote;
   - fresh held-out data per attempt;
   - synonyms from training users only, with a margin, excluding precheck keystrokes, with a
     5-account minimum and account-age limits.
7. **Load tests** against p50 < 30 ms and p95 < 100 ms, locally and on the deployed services.
