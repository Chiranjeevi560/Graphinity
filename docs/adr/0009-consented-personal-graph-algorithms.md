# ADR 0009: Consented personal graph analysis

- **Status:** Accepted; implemented in `personal-graph-v1`. Its community detection, embeddings,
  recommendation score and edge weighting are superseded by ADR 0012 (`personal-graph-v2`), after
  measurement found label propagation collapsing and the blended score mixing scales.
- **Date:** 2026-10-22

## Problem

Graph events and manually entered nodes were stored, but the user had no way to create a relationship
between nodes or run graph discovery. Graph analysis must not cross account boundaries, retain
derived user features beyond the request, or use categories after consent revocation.

## Decision

Keep PostgreSQL as the authoritative property graph. Add an owner-authenticated edge API and an
on-demand insights API. The route loads only the signed-in owner's nodes and edges with currently
active purpose consent, caps input at 1,000 nodes and 5,000 edges, then runs deterministic algorithms
in the API process. No result is written back to the database.

The algorithm suite is:

1. Weighted directed PageRank: damping 0.85, uniform teleportation, dangling mass redistributed
   uniformly, L1 convergence threshold `1e-10`, at most 100 iterations.
2. Personalized PageRank / random walk with restart: equal teleport probability over one to ten
   owner-selected seed nodes, restart probability 0.15, same convergence limit.
3. Weighted asynchronous label propagation over the undirected projection of active graph edges:
   deterministic node order, weight-sum vote, lexical tie-break, at most 20 passes.
4. Bounded graph embeddings: four deterministic weighted random walks per node, eight steps,
   two-node context window, signed 16-dimensional feature hashing, and L2 normalization. This is a
   random-walk co-occurrence embedding, not a trained Node2Vec/GNN model.
5. Graph recommendations: exclude seeds, score candidates as `0.7 × personalizedPageRank + 0.3 ×
   max(0, cosine(personalizedEmbedding, candidateEmbedding))`, then sort by score and stable node id.

## Data model and privacy

Nodes retain their originating consent category; the API maps entity types to allowed categories
(expertise/learning, ownership, purchases, travel/experience, commercial preferences, notification,
trust/interaction, relationships, and privacy controls). Edges carry owner, category, directed
endpoints, relation, weight, confidence, freshness, and optional source-event evidence. RLS remains
the database boundary. The insights query joins only categories whose purpose is still enabled.
Seeds must be active nodes owned by the requester. Cross-user endpoints return unavailable without
revealing whether another user's node exists. Commercial recommendations are not implemented by
this ranker and commercial features do not affect knowledge ranking.

## Complexity and operations

For `V ≤ 1,000`, `E ≤ 5,000`, `I ≤ 100`, and fixed walk factors, ranking costs `O(I(V+E))`; label
propagation costs `O(20(V+E))`; walks and context projection cost `O(V)` with fixed walk lengths;
sort costs `O(V log V)`. Memory is `O(V+E+16V)`. There is no cache, avoiding stale consent and
invalidation complexity. Oversized graphs fail with 422 and do not partially return results.

`scripts/benchmark-personal-graph.mjs` measures CPU and process RSS for a synthetic maximum-size
graph, not DB/API latency, actual user graph shape, contention, or production capacity. Queue
monitoring uses a security-definer aggregate function callable only in a system transaction; pending
events and oldest age are logged without user ids. A five-minute lag is a warning threshold. The
platform must route these structured logs to an alerting rule for a real external alert; no dashboard
or SLO integration is claimed.

## Alternatives and trade-offs

- Louvain/Leiden: not selected because deterministic label propagation is simpler and fast at the
  current per-user graph cap; modularity quality on representative graphs is not measured.
- Trained Node2Vec/GraphSAGE: not selected because it requires reproducible corpora, model artifacts,
  training/runtime and capacity evidence that do not yet exist. The explicit co-occurrence embedding
  is deterministic and self-hosted but lower quality.
- Persistent/cache-backed scores: rejected until a measured request-volume or latency bottleneck
  justifies stale derived state and consent-aware invalidation.
- External graph service or queue: rejected under the zero-cost and existing-Postgres constraints.

## Recovery and acceptance

Analysis is stateless and safe to retry. Deploying the prior API disables the new endpoints; the
additive schema remains compatible. Integration tests cover owner isolation, consent revocation,
edge creation, bounded input, ranking, communities, determinism, queue metric access and malformed
queue identifiers. The graph algorithms and database event projection are implemented, but global
graph computation, independent benchmark of database work, realistic load/capacity validation,
Leiden/Louvain, learned embeddings, and all requested ML/AI infrastructure remain incomplete.
