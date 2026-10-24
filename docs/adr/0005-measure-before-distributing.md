# ADR 0005: Measure before adding distributed architecture

- **Status:** Accepted for the current scale; revisited when an acceptance trigger is met
- **Date:** 2026-10-22

## Problem

The owner wants a path from a free-tier launch to millions of users. The repository currently runs
as a modular monolith with PostgreSQL as its transactional source of truth. Adding queues, caches,
read replicas, regional write clusters, or service boundaries without measured pressure would add
deployment and consistency failure modes without evidence of a user-visible gain.

## Decision

Keep transactional writes and domain modules in the existing API and PostgreSQL deployment. Use
indexes and bounded queries first. Treat durable database rows as authoritative; process optional
work from idempotent jobs that can be retried. Do not make cross-region writes or a cache necessary
for correctness. Add a separate worker, cache, replica, or region only after a reproducible benchmark
shows that the current boundary misses a documented SLO and the proposed change meets it.

This is a staged migration path, not a claim that a single region can serve millions of users:

1. Measure API and database latency, queue age, connection saturation, and workload shape on the
   current deployment.
2. Move noncritical, retryable work to a separately deployable worker when API latency or database
   transaction duration crosses the runbook trigger.
3. Add read replicas for explicitly stale-tolerant reads after query profiling shows primary read
   saturation; writes and privacy/consent checks remain on the primary.
4. Add regional read replicas and routing only when regional latency warrants them. Keep writes
   pinned to a declared home region until conflict resolution and privacy residency are designed.
5. Consider multi-region writes only with an explicit consistency model, conflict policy, recovery
   proof, and measured advantage over regional reads.

## Domain model and data structures

The modular monolith owns account, question, answer, moderation, routing, consent, and personal-data
domains. PostgreSQL rows and constraints are the authoritative state; request-scoped reads use
bounded SQL results. Optional caches may contain rebuildable data only and require a TTL and an
invalidation or version strategy.

## Algorithms and consistency

Critical mutations remain transactional and use database constraints for uniqueness, ownership,
and consent. Retryable background actions must be idempotent by durable identity. Stale-tolerant
read models may eventually use asynchronous replication, but access controls and consent revocation
must be checked against authoritative state before personal data is returned or used.

## Alternatives considered

1. **Split all domains into services now:** rejected; it multiplies deployment, network, tracing,
   consistency, and incident surfaces without baseline measurements.
2. **Add Redis and a queue immediately:** rejected; no demonstrated cache hit rate, queue throughput,
   or failure isolation benefit justifies operating them today.
3. **Stay a monolith regardless of load:** rejected; the explicit triggers and staged extraction path
   above permit evolution before SLOs degrade.

## Trade-offs and complexity cost

The current design makes horizontal API replicas straightforward but leaves database capacity as an
early bottleneck. A monolith shares deployment and scaling units. The staged approach limits new
operational components today but requires ongoing measurements, bounded queries, and clear domain
interfaces so extraction remains possible.

## Security and privacy

Each future service receives only the credentials and data needed for its job. User data stays in
the declared region; no cross-region replication is enabled by this ADR. Caches must exclude
consent-sensitive records unless their keys, TTL, invalidation, and erase behavior are reviewed.
Consent revocation and account deletion must invalidate derived data before external use.

## Failure modes and recovery

The current database is a shared failure domain. API restart does not change committed database
state; retryable jobs need bounded retry and duplicate-safe effects. A future worker can be disabled
and replayed from durable state. A future read replica can be detached and reads returned to primary.
Any regional read path must fail back to the home-region primary without weakening authorization.

## Observability and benchmark methodology

Before each infrastructure expansion, capture a production-like workload with realistic read/write
mix, concurrency, data volume, and geographic latency. Record p50/p95/p99, error rate, database
connections, CPU/memory, queue age, and recovery time. Compare the same workload before and after;
include a fault run and the operational cost of the added component. This repository does not yet
have a verified million-user capacity benchmark.

## Acceptance criteria and revisit triggers

- All endpoints have explicit SLOs and observable latency/error signals.
- A benchmark reproduces the limit and demonstrates that the proposed architecture improves it.
- Security, consent, idempotency, rollback, and failure recovery tests pass for the new boundary.
- The operator runbook and cost ceiling include the new component.
- Revisit worker extraction when synchronous noncritical work pushes API p95 beyond its SLO or
  consumes more than 20% of the request budget.
- Revisit read replicas when primary read saturation is sustained and query/index tuning no longer
  meets the read SLO.

## Rollback

New deployments must be independently disableable. For a read replica, return reads to primary.
For a worker, stop consumption and retain durable work for replay. For a cache, bypass it and rebuild
from PostgreSQL. Schema changes remain additive until the old and new paths have been verified.
