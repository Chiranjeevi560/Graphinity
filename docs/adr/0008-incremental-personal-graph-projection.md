# ADR 0008: Incremental consented personal graph projection

- **Status:** Accepted; implemented in migration 0013
- **Date:** 2026-10-22

## Problem

Consent-gated interaction events were visible in the personal data center but did not contribute
to a typed knowledge graph. Synchronously constructing graph state during question and answer writes
would add latency and couple product writes to graph projection.

## Decision

Use a bounded PostgreSQL queue on `personal_signal_events`. A `projected_at` marker and partial
queue index support ordered claims with `FOR UPDATE SKIP LOCKED`; the worker claims up to 100 rows
every 15 seconds (SQL enforces a maximum of 500). It rechecks the event's exact consent category
when processing and projects supported question interactions into owner-scoped topic and question
nodes plus one weighted, directed, temporal edge per source event. Edge evidence references the
source event, so deleting or expiring an event cascades to its edge. Question labels contain only
the stable question key; post text is never copied. Searches remain outside this graph projection.

The projection is idempotent: a partial unique key identifies generated nodes, and a unique
`evidence_signal_id` identifies each edge. Unsupported, expired, or revoked events are acknowledged
without graph output. Concurrent workers cannot claim the same unprocessed row.

## Alternatives and trade-offs

- Synchronous application-side projection: rejected because it increases user-write latency and
  makes graph bugs fail unrelated writes.
- External queue: rejected because it adds a paid/operated dependency before volume measurements
  justify it; Postgres is already the transactional source of truth.
- Unbounded in-process event replay: rejected because request work would grow with account history.

The database queue couples processing capacity to the primary database and can lag during overload.
The 15-second timer is best-effort per server instance; `SKIP LOCKED` permits multiple instances,
and startup immediately drains one bounded batch. Failure leaves events unprojected for retry.
Rows are retained according to their existing 365-day expiry. No dedicated lag metric or dead-letter
state exists yet; operational logs report successful batch counts and failures without user data.

## Complexity, scale and recovery

Claim cost is indexed in queue order, with `O(B log N)` index work for a batch of at most `B=500`
among `N` events; each supported event performs bounded question lookup/upsert work. Work is
transactional. A process crash rolls back node/edge writes and queue markers together. To roll back
application code, stop invoking the function; the additive schema is harmless to old code. Migration
rollback is forward-only and should preserve already projected user data.

At current scale, primary PostgreSQL and short batches are the lowest-operational-cost design. Move
to a dedicated queue only if measured queue lag or database contention breaches an agreed SLO;
preserve source event IDs and consent rechecks during migration.

## Verification and limitations

Integration tests cover opt-in projection, retry idempotency, source deletion cascade, and revocation
before projection. This does not implement PageRank, PPR, community detection, graph embeddings,
recommendation models, graph analytics, or global-scale capacity. No production latency, queue-lag,
or million-user benchmark is claimed.
