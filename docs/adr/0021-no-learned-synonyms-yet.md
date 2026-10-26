# ADR 0021: Learned synonyms for word search, measured and not adopted yet

- **Status:** Decided 2026-10-26: not built. Revisit when consented search logs (ADR 0015 part 3)
  hold enough reformulations to mine (below).

## Question

ADR 0015 left "synonym learning" open. Word search can't connect "duty" with "tax". Should word
queries be expanded with synonyms learned by Graphinity's own embedding (each word's nearest words,
ADR 0010)?

## Measurement

`scripts/benchmark-synonyms.mjs`, on the synthetic corpus whose question details paraphrase their
titles, with the embedding gate's task: from a question's details, find its title among 600
held-out titles.

- **Variants:** words alone, and fused with meaning as search serves. Each was tried with and
  without expansion: k ∈ {1, 3} nearest words, a similarity bar ∈ {0.5, 0.7}, and an expansion
  weight ∈ {0.5, 1}.
- **Comparison:** paired bootstrap, 95%.

| Task | Plain, fused MRR | Best expansion | Gain (95% interval) |
|---|---|---|---|
| Realistic: queries keep their identifying words | 0.990 | 0.993 | +0.003 [+0.001, +0.007] |
| Hard: queries lose product and place names | 0.030 | 0.042 | +0.013 [+0.009, +0.018] |

What the nearest words were:

| Word | Nearest words |
|---|---|
| duty | on 0.99, customs 0.99, when 0.99 |
| tax | levy 0.70, what 0.69, did 0.56 |
| import | into 0.97, ship 0.96, bring 0.96 |
| repair | shops 0.98, fix 0.92, service 0.92 |

## Decision

Not built. Three reasons:

- **The realistic gain is negligible.** Meaning search already finds paraphrases, and fusion
  carries them.
- **The hard gain is tiny in absolute terms,** on a task that is mostly unanswerable by design
  (about 100 titles share each topic).
- **The model's nearest words are associates, not synonyms.** A word that co-occurs ("customs",
  "on") sits as near as one that means the same ("levy"). Expanding real queries with associates
  would match questions that merely share a topic, lowering precision exactly where people typed
  something specific. The synthetic corpus can't show that harm, because its topics never overlap.

## When to revisit

Synonyms worth adding come from people. Someone searches "levy on a drone", opens nothing, searches
"duty on a drone" and opens a result: a query rewrite. That is the standard way to mine them, and
it is measurable with the clicks the search logs already keep (only under `search_improvement`).

Revisit when the logs hold at least a few thousand searches that were reformulated and then led to
an open. Build then:

1. Mine rewrite pairs with a significance test against chance co-occurrence.
2. Expand with mined pairs only, at a learned weight.
3. Gate it like the learned ranking: offline IPS-NDCG, then online interleaving (ADR 0015 part 6).
