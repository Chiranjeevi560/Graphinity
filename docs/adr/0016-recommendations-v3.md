# ADR 0016: Knowledge recommendations v3, measured against v2

- **Status:** Accepted and built 2026-10-26. Supersedes ADR 0006's sources and fusion. Its rules stand:
  - finite (20) and consented (`feed_personalization`, off by default);
  - search and reading only under their own choices;
  - no commercial input; nothing stored;
  - no hand-picked weights without evidence.

## Problem

v2 (`feed-rrf-v2`) had three gaps:

- **It read only Ask-check drafts** from search history, never the new Search screen.
- **It ranked them with `ts_rank_cd`,** which part 2 of ADR 0015 measured as poor.
- **It treated "related to what you opened" as recent questions in the same field.** It also fused
  every source equally with two broad 100-item sources (fields, recent).

## Measurement

`scripts/benchmark-recommendations-v3.mjs` runs on a real migrated database seeded with a world of
known interests. Each person's three most recent opens are held out, and every variant is judged by
whether its 20 include them: Recall@20, per person, 99% paired bootstrap. v2 is run as it shipped (its
SQL, reproduced in the script).

The world has 20,000 questions in six topics (real fields), 200 items and 50 places, and 300 people,
each with two (topic, place) interests:

- **People:** fields, 7 opens and 2 searches each.
- **Experts:** 300, answering about half their (topic, place) questions.

| Variant | Recall@20 | NDCG@20 | p50 / p95 |
|---|---|---|---|
| v2 (as shipped) | 0.007 | 0.003 | 247 / 255 ms |
| v3, all five sources fused together | 0.088 | 0.041 | 39 / 53 ms |
| v3, fields and recent removed | 0.152 | 0.079 | 34 / 44 ms |
| **v3 as built (tiers)** | **0.173** | **0.088** | **33 / 38 ms** |

What each measurement showed:

- **Fused all together,** the two broad sources outvote the personal ones. Removing fields gained
  +0.057, and removing recent +0.061; both intervals exclude zero.
- **"Similar to a question you opened",** fused with the personal sources, lowered recall: by 0.021
  by meaning (interval −0.036 to −0.008) and by 0.011 by words (not significant). The own model,
  trained on short titles, finds the same topic in the wrong place.
- **"Answered by the same people"** (item-to-item collaborative filtering on public answers) carries
  the most: removing it costs 0.068 (0.039 to 0.098).
- **Searches through the engine** are neutral here (−0.012, not significant), because everyone in this
  world has opened questions. They are the only personal source for someone who searched but opened
  nothing, so they stay.

## Decision: tiers, each filling only what the one before left

1. The person's searches through the search engine, and questions answered by the same people as ones
   they opened.
2. Similar to ones they opened: by meaning (`app.similar_questions`, migration 0024, owner-run, by the
   seed's own vector, hidden questions left out), or by words while no meaning model serves. A better
   fill than tier 3.
3. Their profile fields, and recent questions: someone with no history still gets a full list.

Within a tier, reciprocal rank fusion (k 60), with no weights. The tier order is a rule chosen by the
measurement above, not a tuned number.

**Result:** v3 against v2, Recall@20 +0.167 (99% interval 0.137 to 0.197), at 33 ms p50 against 247 ms.

## What it costs and bounds

Per request:

- at most 5 searches (20 candidates each);
- 5 opened questions (20 each);
- 100 co-answered, 100 by field and 100 recent;
- one fetch of at most 500 ids;
- fusion at 0.04 ms p50 for five full sources (`scripts/benchmark-recommendations.mjs`).

## Not done, and why

- **Learning a recommendation ranking** (as search does, ADR 0015 part 6) would need impressions and
  outcomes recorded across people, which is a new purpose. ADR 0006 also rejects optimising clicks.
  It isn't built: that is the owner's decision, and the anti-goal stands.
- **Diversity re-ranking** (MMR) needs a hand-chosen trade-off. Not added without evidence it helps.
- **Real reading is less tidy** than this world. The benchmark shows which sources find what interested
  people open, not the size of the gain on real people.
