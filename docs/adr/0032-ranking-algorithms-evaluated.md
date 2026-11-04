# ADR 0032: Which ranking algorithms earned a place

Date: 2026-11-01. Status: accepted under the owner's instruction to finish what code alone can finish.

## Context

The charter names two-tower retrieval with log-Q, SQ8/PQ compression, MMoE/PLE, DPP/MMR diversity and Double ML, and
asks for each to be compared before it's used. The first run skipped this. `scripts/benchmark-ranking-evaluated.mjs`
does it now, with a fixed seed. **All of it is synthetic.** Graphinity has no real traffic, so these results say whether
an algorithm works and what it costs, never what it would do for real people.

## Results and decisions

| Algorithm | Compared with | Result | Decision |
|---|---|---|---|
| DPP greedy | Relevance only; MMR | Reader gain 2.52 against 0.99 and, at MMR's best setting, 2.44; 8 of 8 topics in ten results against 1; 0.19 ms a list | **Used**, behind an experiment on search and on the cascade route. Not switched on for everyone from synthetic data |
| MMR | DPP | Slightly behind, and more sensitive to its setting | Kept as the baseline only |
| Two-tower + log-Q | Most popular; no correction | Recall@10 0.49 against 0.075 and 0.30, on data where about 0.5 is possible | **Built, not served.** It trains on who read what, which needs real journeys. LambdaMART and meaning search stay |
| SQ8 | halfvec (256 bytes) | Recall@10 0.98 at 128 bytes | **Not used.** pgvector's HNSW has no SQ8 index, so serving it means a second index outside the database, for storage nothing yet needs |
| PQ | halfvec | Recall@10 0.13, 0.37, 0.71 at 16, 32, 64 bytes | **Rejected.** Too much recall lost at any useful saving |
| MMoE | Shared bottom; separate models | AUC within 0.004 of both on two related tasks | **Built, not served.** No gain here, and the tasks aren't logged yet. PLE not built: it's a refinement of a method that hasn't earned a place |
| PLE (one CGC layer: shared plus task-own experts) | MMoE; shared bottom; separate models | AUC 0.841 / 0.838 against MMoE 0.843 / 0.842 and shared bottom 0.842 / 0.839, 0.5 s against 0.3 s (2026-11-04) | **Built, measuring only**: in the daily `routing-multi-task` comparison on real routes. No gain on these two related synthetic tasks, which is what PLE predicts: its private experts help only tasks that disagree |
| Double ML | Comparing averages; two-model | Error 0.026 against 0.93 and 0.027; its 95% interval held the truth in 36 of 40 trials | **Available for measuring.** Matches two-model on the point estimate and adds an interval |

These numbers came only after two faults were fixed: a training step divided by batch size that left the two-tower
model below "most popular", and a baseline scored against the wrong task. The learning rate was then picked on this same
data, so the 0.49 is somewhat flattering.

## Consequences

Two engines exist with no caller, on purpose. They need real data before a comparison can mean anything, and the
benchmark can be rerun when it exists.

**Update, 2026-11-04:** two-tower now runs daily in the measuring job on real searches (`two-tower-retrieval`), against
most-opened, so the comparison happens as data arrives. It still serves nothing: serving it is a separate decision once
it wins on real people. MMoE runs the same way on routing (`routing-multi-task`): answering and being picked, against one
shared bottom.

## Cascade timings

Local, on 100 candidates with 128-dimension vectors, p95: pre-rank 0.017 ms and diversity 1.66 ms, against the charter's 8 ms and 5 ms. Retrieval and the learned ranker on a real database aren't timed here, and nothing has been timed on Render or Supabase.

## Left as they are, on purpose

- **An in-memory cache for the feature store:** nothing reads online features while serving, so a cache would sit in front of nothing.
- **Partitioning the event journal:** it's drained and emptied hourly, so it never grows large enough for partitions to help.
