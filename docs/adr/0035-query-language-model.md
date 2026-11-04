# ADR 0035: Graphinity's own language model, for finishing search queries only

Date: 2026-11-04. Status: accepted at the owner's request to build a self-trained language model; off by default.

## Context

The report lists a self-trained language model as not built. The owner decided against generative LLMs (2026-10-26),
and CLAUDE.md forbids AI-written answers. A language model can still help without writing anything: finishing what
someone types into search, from wording people already used in public questions.

## Decision

- **The model:** word trigrams with interpolated Kneser-Ney smoothing (Chen & Goodman 1998), in
  `apps/api/src/ml/query-lm.ts`. No neural network, no downloaded weights, nothing to host.
- **Trained on public titles only:** the titles of questions anyone can see, at most 50,000, rebuilt hourly while the
  switch is on. Searches are never read, so nothing one person typed reaches another.
- **A floor:** a word sequence is suggested only once three or more questions use it, so one person's unusual wording
  (a name, a place) is never echoed.
- **It completes, never writes:** the last word typed and up to three after it. No answers, no summaries.
- **Served:** `GET /search/complete?q=` behind the switch `query_completion` (off); the reply can be cached for five
  minutes by anyone, since it never depends on who asks.

## Measured

On synthetic titles held out from training, perplexity is under half that of word frequency alone (the test asserts
it). Real titles are too few to measure yet.

## Not done

- **No screen:** the Search screen doesn't call it yet; that costs script budget, which is full.
- **The model is in memory:** each server instance builds its own; nothing is stored.

## Turning it on

`UPDATE app.feature_flags SET enabled = true WHERE name = 'query_completion';` Suggestions start within the hour, after
the first rebuild.
