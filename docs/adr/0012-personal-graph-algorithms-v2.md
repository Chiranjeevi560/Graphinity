# ADR 0012: Personal graph algorithms v2, chosen by measurement

- **Status:** Accepted 2026-10-25; revises ADR 0009's algorithm suite (`personal-graph-v2`)
- **Owner request:** build the personal knowledge graph's algorithms "benchmarked, tested, measurable
  and integrated", deterministic and graph methods before anything heavier.

## Problem

ADR 0009 shipped PageRank, personalized PageRank (PPR), label propagation, hashed random-walk
embeddings and a blended recommendation score, but recorded that their quality was never measured.
Measuring them (below) found four real problems:

1. **Communities collapse.** Label propagation put all 1,000 nodes in one community once 40% of edges
   crossed communities (NMI 0 against the planted ones), and found 14–16 communities where 20 were
   planted even on easy graphs.
2. **Weak embeddings.** Hashed walk counts told hidden links from non-links barely better than
   chance (AUC 0.53–0.65).
3. **Mixed scales in recommendations.** `0.7 × PPR + 0.3 × cosine` added PPR values that sum to 1
   over the graph (≈ 0.001 each) to cosines between 0 and 1, so PPR barely counted. The blend found
   fewer hidden links than PPR alone.
4. **Every edge counted the same.** Edges store `confidence` and `freshness`, but the analysis
   ignored both: a view from a year ago weighed as much as something entered today.

It also ran on the request thread, inside the database transaction: up to ~120 ms of CPU at the
node cap, holding up every other request and a pooled connection.

## Decision

1. **Communities: Louvain** (Blondel et al. 2008), deterministic (index order, strict gains, lower
   id on ties), then each community split into its connected parts. Louvain can leave a community
   disconnected (Traag et al. 2019); splitting a community with no edges between its parts always
   raises modularity. Leiden's full refinement step wasn't needed to fix that defect.
2. **Embeddings: NetMF** (Qiu et al. 2018), the exact matrix that DeepWalk's training
   approximates. The matrix is log(max(M, 1)) with M = vol(G)/(b·T) · Σ_{r≤T}(D⁻¹A)^r · D⁻¹, using
   T = 2 and b = 1. It is factorized to 16 dimensions with the text model's randomized eigensolver
   (2 power iterations). There's no sampling and no learning rate, so the same graph always gives
   the same vectors.
3. **Recommendations:** the cosine between a candidate and the PPR-weighted average of every node's
   embedding, with ties broken by PPR, then id. This keeps ADR 0009's idea (a personalized
   embedding) without the scale mismatch.
4. **Edge weight in analysis** = weight × confidence, and for observed edges (those projected from
   your own activity, i.e. with `evidence_signal_id`) × 2^(−age/90 days). Edges a person entered
   themselves don't fade. The 90-day half-life is a prior, not fitted, since there's no data to fit
   it to yet. The signals behind observed edges expire at 365 days, when 6% of the weight remains,
   so expiry is a small step, not a cliff.
5. **PageRank** rewritten on flat arrays, with each node's out-weight computed once. It gives the
   same answers as v1's Map version to the last bit (compared on directed graphs with dead ends),
   4–20× faster.
6. **Off the request thread:** one long-lived worker thread (`graph-analyzer.ts`) runs analyses one
   at a time. The route loads the graph in its transaction, ends it, then analyzes. When more than 8
   are waiting, the route answers 503 `graph_busy` in plain words rather than queueing work
   nobody can see. Each analysis logs its time and the queue depth (numbers only).

## Evidence (`node --expose-gc scripts/benchmark-graph-algorithms.mjs`, Apple M2, Node 24)

Planted-partition graphs at the cap: 1,000 nodes, 20 communities, about 2,400 links (each stored both
ways, so under the 5,000-edge cap). "Mixing" is the share of links that cross communities.

| Mixing | Communities NMI, LP → Louvain | Link-prediction AUC, hashed → NetMF | Hidden neighbour in top 10, v1 → v2 |
| ------ | ----------------------------- | ----------------------------------- | ----------------------------------- |
| 0.1    | 0.86 → **0.93**               | 0.65 → **0.90**                     | 8% → **17%**                        |
| 0.2    | 0.59 → **0.82**               | 0.57 → **0.84**                     | 3% → **11%**                        |
| 0.3    | 0.39 → **0.70**               | 0.56 → **0.73**                     | 5% → **8%**                         |
| 0.4    | 0.02 → **0.47**               | 0.54 → **0.64**                     | 1% → **6%**                         |
| 0.5    | 0.02 → 0.28                   | 0.53 → 0.52                         | 1% → 1%                             |
| 0.6    | 0.02 → 0.18                   | 0.54 → 0.50                         | 1% → 0%                             |

At degree 10 (denser, over the cap), Louvain recovered the planted communities exactly at 0.1
mixing (NMI 1.00) and NetMF reached AUC 0.91. At 0.5 mixing and above on the sparse graphs,
neither method finds structure (the AUCs are at chance): there's too little signal left in so few
links. That's a limit of the data, not something a cleverer method fixes.

Choices made from measurements:

- **Window T:** at T = 1, AUC was 0.05–0.1 lower on harder graphs. T = 2, 5 and 10 were within
  0.005 of each other on nine graphs, so T = 2 (40% of T = 5's cost).
- **The log:** without it, AUC fell from 0.68 to 0.60 at 0.5 mixing (degree 10).
- **Power iterations:** 2 matched 6 (AUC 0.829 vs 0.832) in 40% less time.
- **Recommendation score:** of six scores tried, cosine to the PPR-weighted vector was best at
  every mixing level. Its margin over PPR alone (e.g. 17% vs 14.5%) is within sampling noise; its
  margin over v1 isn't.

Time for the whole analysis, p50 of 20 runs:

| Nodes (edges) | v1      | v2                                       |
| ------------- | ------- | ---------------------------------------- |
| 50 (212)      | 4.4 ms  | 2.5 ms                                   |
| 100 (464)     | 7.4 ms  | 4.4 ms                                   |
| 300 (1,426)   | 23.8 ms | 13.5 ms                                  |
| 1,000 (4,776) | 116 ms  | 71–172 ms (depends on the graph's shape) |

Memory: NetMF's working set is O(n²): 6–28 MB of heap growth at the cap, after replacing one small
array per matrix entry with typed arrays (it was 16–65 MB before).

## Complexity

For n ≤ 1,000 nodes, z ≤ 10,000 stored adjacency entries, and z' entries of M above 1:

- **PageRank and PPR:** O(I·(n + z)), with I ≤ 100.
- **Louvain:** O(z) per pass; passes and levels are bounded (100 and 32), and in practice there are
  a few of each.
- **NetMF:** O(T·z·n) time and O(n²) memory, plus O(z'·k·q) for the eigensolver with k = 36
  and q = 2.

## Testing

`test/graph-algorithms.test.ts`, `graph-analyzer.test.ts`, `personal-graph.integration.test.ts`:

- **Exact values:** hand-computed modularity and PageRank; the two-triangles split.
- **Planted structure:** NMI above 0.99 when the communities are clear; v1's collapse kept as a
  regression test; every community connected.
- **Link prediction:** NetMF beats hashed counts by more than 0.15 AUC, and stays above 0.65 at
  0.5 mixing.
- **Edge weights:** confidence and fading reach the analysis through the route, against a real
  database.
- **The worker:** the same results as in-process, refusal past the queue, recovery after bad
  input, no leak on input that can't be copied to it, and failure of held work on close.

21 rules were broken on purpose; 18 are caught. Dropping PageRank's dead-end mass survived at
first (v1 never tested it either); an exact test now catches it. The 3 that survive:

- **Two are equivalent:** scoring by PPR alone, or by v1's formula on the new vectors, ranks
  nearly the same as v2 on these graphs.
- **One guards a rare failure:** the connected-parts split is tested on its own, but no graph tried
  makes Louvain produce a disconnected community.

## Rollback and migration

- **No schema change:** the response has the same shape, with `algorithmVersion` now
  `personal-graph-v2`.
- **Rollback:** deploy the previous API; nothing is stored.
- **Worker failure:** the requests it held fail, and the next request starts a fresh worker.

## Not done (remaining gaps, stated plainly)

- **Synthetic evidence only:** real personal graphs are mostly star-shaped (topics to questions),
  and none are measured.
- **Equal weights for every projected signal:** the projection (ADR 0008) still gives each signal
  weight 1 and confidence 1, so a picked answer weighs no more than a view. Telling them apart
  needs evidence of what each signal predicts, which needs real outcomes.
- **One worker per server:** its queue is per instance.
- **Single machine:** the benchmark is single-machine, and the API's own database time isn't in it.
