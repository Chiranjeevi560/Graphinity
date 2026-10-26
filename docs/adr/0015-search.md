# ADR 0015: Search, built in measured slices

- **Status:** In progress. Part 1 (consent) accepted and built 2026-10-25. Part 2 (the engine)
  part 5 (ANN), part 3 (search logs), part 4 (the Search screen), part 6 (learning the ranking) and part 7 (load
  tests, locally) built 2026-10-26. Later parts are recorded here as they land.
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

## Part 3: what learning needs, recorded only under the choice (migration 0022, schema 37)

Recorded, only for a signed-in person with `search_improvement` on, and only from the Search screen
(never Ask-screen drafts):

- **Each search:** query, field, the ranker and meaning model that ordered it, and the consent version
  the person accepted.
- **The results shown, in order,** with what the ranking knew about each at that moment: word and
  meaning ranks, similarity, every-word, answer count, answer age. Point-in-time, so a model learns
  from what the ranking actually saw.
- **Which were opened,** and the longest time reported on each (`PUT /searches/:searchId/opens/:position`).

Guarantees, each tested:

- **Enforced twice in the database:**
  - row-level policies (own rows, choice on);
  - a trigger that locks the person's consent row `FOR SHARE` and refuses when the choice is off.
  A race with turning it off leaves nothing behind in either order; both orders are tested with the
  other session blocked on the lock.
- **Off deletes all** of it, whatever the change to the consent row. On again never resurrects it. A
  search begun before an off-and-on records nothing, because the consent row must be unchanged since
  it began.
- **The database sets the dates and the consent version;** the API role can't send them.
- **Ids are random,** at most 365 days are kept, purged hourly, in the export, gone with the account.
- **A fresh-eyes review** found five issues before this stood; all fixed (docs/SECURITY.md).

The 6 survivors of 23 rules broken on purpose are layers that another layer also enforces:

- the API's own checks over the database's;
- the own-rows check, which the invoker-run consent check already implies.

## Part 7: load tests (locally)

`node scripts/load-search.mjs`:

- **What it runs:** the real API server (`buildServer`) over a seeded 100,000-question database (the
  benchmark's own seeding), driven over HTTP for 10 s at each concurrency.
- **Who searches:** visitors, and signed-in people with recording on (the heaviest path).
- **Limits:** rate limits raised, so it measures the engine, not the limiter. The client shares the
  server's Node process, so throughput is a lower bound.

| 100,000 questions | 1 at a time: req/s, p50 / p95 | 8 at a time | 32 at a time |
|---|---|---|---|
| `POST /search`, visitor | 47, 23 / 27 ms | 190, 43 / 57 ms | 184, 178 / 195 ms |
| `POST /search`, recorded | 43, 26 / 30 ms | 169, 48 / 64 ms | 166, 191 / 233 ms |
| `POST /questions/precheck` | 93, 11 / 14 ms | 366, 22 / 28 ms | 362, 88 / 99 ms |

- **No errors at any level.** The process (client included) held about 320 MB throughout.
- **Throughput levels off** at about 190 searches a second, set by the server's 5-connection database
  pool: past 8 concurrent searches, requests queue. That is far above anything a free single instance
  will see.
- **One person at a time,** the whole HTTP round trip is 23 ms p50, inside the 30 ms target.
- **Not measured:** the deployed services. Render's free instance has a fraction of one CPU, so
  latencies there will be higher; this runs after the branch is merged and deployed.

## Part 6: learning the ranking from consented searches (migration 0023, schema 38)

Replaces the fixed fusion weights with a ranking learned from what people open and read. It's built in
three pieces, each measured.

### The model: LambdaMART, chosen against a linear ranker

`ml/lambdamart.ts` is gradient-boosted regression trees fitted to LambdaRank gradients (Burges 2010):
the algorithm LightGBM and XGBoost run as `lambdarank`.

- **Same essentials:** quantile-histogram splits, Newton leaf values, L2, shrinkage, per-result weights.
- **Written out** because those libraries need native installs, which this repository disables.
- **Features** (`search/features.ts`) are the logged point-in-time ones (word and meaning reciprocal
  ranks, similarity, found-by flags, every-word, log answers, answer freshness), computed by one
  function for training and serving.

`scripts/benchmark-ltr.mjs`, a simulated world with known true relevance (interactions between
features). Clicks follow a position-based model with η = 1, from today's fusion order. NDCG@10 against
the truth on 1,000 held-out queries:

| Searches | Fusion today | Linear (IPS) | LambdaMART raw clicks | LambdaMART IPS | IPS, propensities estimated | True labels (ceiling) |
|---|---|---|---|---|---|---|
| 2,000 | 0.633 | 0.828 | 0.797 | **0.833** | (too few clicks) | 0.890 |
| 10,000 | 0.630 | 0.818 | 0.811 | **0.854** | (too few clicks) | 0.879 |
| 50,000 | 0.639 | 0.830 | 0.825 | **0.877** | **0.876** | 0.892 |

- **Against the linear ranker,** LambdaMART IPS gains:
  - at 2,000 searches, +0.005: **not significant** (99% interval −0.004 to +0.014);
  - at 10,000, +0.036 (0.028 to 0.044);
  - at 50,000, +0.047 (0.040 to 0.054).

  So the trees earn their place once there is data, and the job trains only then: measuring
  position bias needs about 50,000 searches (below).
- **The bias correction matters:** raw clicks lose 0.035 to 0.052.
- **Cost, measured on an otherwise idle machine:** training takes about 3 s, 14 s and 75 s (worker
  thread, daily), reranking 50 candidates 0.23 ms, and the model is about 200 KB.

### Position bias, measured from people's own behaviour

`search/interventions.ts` uses RandPair (Wang et al. 2018):

- **The intervention:** on 10% of recorded searches, one neighbouring pair among the top five swaps
  places.
- **The estimate:** the same two results seen in both orders give each position's examination ratio,
  in which the results' own pull cancels. Past five, a fitted power law.
- **Recovery:** it recovers η = 0.5, 1 and 1.5 in tests; in the benchmark, η 0.97 against a true 1.0.
- **Honest limit:** with swaps on 10% of searches, measuring every pair takes on the order of 50,000
  recorded searches. Until then the job refuses to train, rather than guess a correction.
- **Never for anyone else:** only recorded searches are swapped, as disclosed on the privacy page.

### From training to serving, only by evidence

1. **Offline gate** (`ml/train-search-ranker.ts`):
   - One person in five is held out by a hash.
   - The shown results are reordered by the candidate and by the baseline (the serving model, or the
     logged order) and scored by IPS-NDCG@10, an unbiased estimate under the position model.
   - It passes on a gain of 0.01 or more with a 99% paired bootstrap over people above zero. At least
     200 held-out searches with a click, from 30 people.
   - Passing makes it a **candidate**, at most one per model (unique index).
2. **Online comparison** (`search/rankers.ts`, `search/judge.ts`):
   - While a candidate waits, half of recorded searches show team-draft interleaving (Radlinski et
     al. 2008) of the serving order and the candidate's.
   - Hourly, each search is a win for the side whose results were opened more; outcomes are averaged
     per person and resampled over people at 99%, with at least 200 decided searches from 30 people.
   - A clear win serves; a clear loss, or no winner in 28 days, is rejected and its weights dropped.
3. **Automatic rollback:** for 14 days after a promotion, the replaced version stays the challenger,
   and is restored if it wins.
4. **The owner's switch:** all of it serves and interleaves only with `learned_search_ranking` on,
   off by default; training runs either way.

Registry integrity: a version's weights can be removed, never replaced (trigger), and every artifact is
checked against its hash before it serves.

Tests:

- **34 new:** unit, and the database end to end. The judge's promote, reject, time-out and roll-back
  run against real interleaved logs; the route is tested serving and interleaving.
- **24 rules broken on purpose,** all caught. Six first survived, and got tests or simplifications:
  - the NDCG cutoff line was redundant (removed);
  - the gradients are now tested exactly;
  - the too-few-clicks guard, the gate rule and who is trained on are now tested;
  - interleaved searches really are left out of training.

Not verified: real searches. None are recorded yet; the first learned model needs on the order of
50,000.

## Part 4: the Search screen

- **Entry:** a search field on the home page, for everyone; `/search` for the screen. The query is
  handed over in memory and sent in the request body, so it never appears in an address, a history
  entry or a link (checked end to end for every address visited).
- **When a search runs:** on submit, not on every keystroke.
  - Each search costs an embedding and three queries against a per-person allowance.
  - Half-typed words are noise in what learning reads.
  - The Ask screen keeps its as-you-type check, which is a different job.
- **The results** use the question rows' own shape, with reasons in words ("Has all your words ·
  Similar in meaning"), the spelling model's extra words ("Also searched for “customs”"), and "Matched
  by words only right now" while no meaning model serves.
  - With no match, it says so and offers to ask.
  - Too many searches, or search paused, get the server's own words.
- **Back returns to the same results:** they're kept in memory for this tab, and forgotten on sign-out
  and account deletion so the next person on the device doesn't see them.
- **Reading time** is recorded only for a search the person allowed recording for:
  - an open on the click, and the time read sent once when the question is left (another screen,
    another tab, or closing it, sent with `keepalive`);
  - only time while the page is visible counts, capped at an hour;
  - telemetry never shows an error.
- **Checked in a real browser:** 320, 375, 430 and desktop, light and dark; no sideways scroll; every
  target 44 px or more.
  - One flaw found and fixed: the global focus ring's page-colour band painted a dark bar across the
    field's icon. It is removed for fields, which show focus with their own ring.
- **Tests:**
  - 6 unit tests;
  - an end-to-end test in Chromium and WebKit: allow, search from home, open, read, Back, the
    reading recorded, sign out, nothing remembered;
  - the screen in the accessibility audit.
  - 7 rules broken on purpose, all caught. Two first survived for test reasons: an assertion that
    expected "some" words, and a sign-out helper that reloaded the page, which forgets anyway.

## Part 5: meaning at the model's own size, searched as measured (migration 0021, schema 36)

Taken out of order: part 2's benchmark showed the meaning stage missing the latency target at
100,000 questions.

### What was measured

All at 100,000 questions:

- **Index fit.** Vectors were zero-padded to 768 numbers, though the own model makes 128. The index
  was 195 MB against 128 MB of shared buffers, so searches read it from disk.
- **The default `ef_search` (40)** returns at most 40 rows: recall@50 0.80 against an exact scan.
- **Recall and speed by configuration** (`scripts/benchmark-ann.mjs`, querying with new text, as
  searches do):

  | Stored as | m | Index | Build | Recall@50, ef 200 / 400 | p50, ef 200 / 400 |
  |---|---|---|---|---|---|
  | 768 padded | 24 | 205 MB | 105 s | (ef 160: recall@10 0.96, 8.3 ms) | |
  | 128 | 16 | 57 MB | 22 s | 0.87 / 0.95 | 1.7 / 3.2 ms |
  | **128** | **24** | **68 MB** | 33 s | **0.93 / 0.98** | **2.4 / 4.6 ms** |

  Padding zeros don't change cosine, so 128 and 768 find the same neighbours; 128 does it in a third
  of the memory, up to four times faster.

### Two more costs in the word stage, found while measuring this

- **The hidden-question check ran on every candidate.** `app.is_question_hidden` costs about 60 µs a
  call and can't be inlined (it has a `SET` clause). It took 15 of 17 ms. Both functions now score
  first, then check only twice the rows asked for. Hidden questions are rare.
- **A cached generic plan walked the primary key backwards.** After five calls on one connection,
  PL/pgSQL switched `app.word_search` to a generic plan that can't see how rare the words are, and it
  filtered all 100,000 questions (20 ms against 2.3 ms). Its main query is now planned on every call
  (`RETURN QUERY EXECUTE`, values as parameters).
  - Forcing custom plans for the whole function was tried and rejected: it also re-plans the hidden
    check's queries on every call (16 ms).

### Chosen

- **`app.question_embeddings`**, keyed by question and model, at the model's own size. Several
  models' vectors can coexist (embedding versioning).
  - The background job fills in what the serving model lacks, 500 a minute, newest first, then
    removes other models' vectors, 5,000 a minute.
  - Batches go through `app.store_question_embeddings`, owner-run, because the API role has no
    rights on the extensions schema.
- **One HNSW index per size:** `halfvec(128)`, m 24, ef_construction 200, partial on size.
  `app.nearest_questions` searches it with `ef_search` 400 and an iterative scan, so filtering by
  model and field can't return fewer rows than asked for. Other sizes are compared exactly.
- **Expand, then contract.** The old `questions.embedding` column stays for the previous release
  during a deploy, but is no longer written or read; its 195 MB index is dropped. The column goes in a
  later release.

### Result

`scripts/benchmark-search.mjs`; each ranking measured in its own pass:

| | 10,000: p50 / p95 | 100,000: p50 / p95 |
|---|---|---|
| Meaning stage | 2.2 / 2.8 ms | **5.9 / 10.3 ms** (was 36 / 201; 389 / 1,140 grown incrementally) |
| Word stage | 6.1 / 8.4 ms | **4.0 / 6.8 ms** |
| **Whole search** | **9.7 / 12.3 ms** | **11.9 / 16.8 ms** (target p50 30, p95 100) |
| Vectors + index | 3.4 + 6.8 MB | 34 + 68 MB (was 164 MB of table, 195 MB of index) |

Quality is unchanged: words MRR 0.98 at 10k and 0.87 at 100k; meaning 0.67 and 0.16.

- **Not measured:** Supabase's own hardware.
- **Not seen in tests:** recall at `ef_search` 400 (a test pins the setting, and the benchmark
  measures what it buys).

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
3. ~~Search logs~~: built (above).
4. ~~The Search screen~~: built (above).
5. ~~ANN~~: built (above).
6. ~~Learning~~: built (above). Still to do from the original list:
   - labels only from the searcher's own actions;
   - randomized top-5 swaps on a disclosed small share of consented sessions, so position bias can
     be estimated;
   - team-draft interleaving to confirm a promotion and to demote;
   - fresh held-out data per attempt;
   - synonyms from training users only, with a margin, excluding precheck keystrokes, with a
     5-account minimum and account-age limits.
7. ~~Load tests~~: built and run locally (above). The deployed services are measured after
   deployment.
