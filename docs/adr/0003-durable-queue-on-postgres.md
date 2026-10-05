# ADR 0003 — Durable job queue in PostgreSQL; Redis for budgets and caching

- Status: accepted (2026-10-05)

**Context.** Requirements: leases, crash recovery, exponential backoff, dead-letter + audited
replay, fair scheduling across tenants and connections, bounded concurrency/backpressure,
coalescing of obsolete stock/price updates, per-entity ordering, and cancellation when a connection
is disabled or uninstalled. The prompt also requires that Redis is not the sole recovery record.

**Options.** BullMQ (Redis), pg-boss / graphile-worker, a custom PostgreSQL queue.

**Decision.** A purpose-built PostgreSQL job table (`jobs`) claimed with
`FOR UPDATE SKIP LOCKED` through a `SECURITY DEFINER` function, `claim_jobs`, that applies:

- per-tenant fairness: round-robin, at most N claims per tenant per poll;
- per-tenant and per-connection concurrency caps (backpressure);
- per-entity serialization: no two running jobs share an `entity_key`;
- leases with heartbeat renewal and expiry-based recovery.

Coalescing uses a partial unique index on `(tenant_id, coalesce_key) WHERE status='queued'`.
Jobs are inserted in the same transaction as the inbox event or outbox entry that caused them.

Redis (ioredis) holds shared **provider rate-limit budgets** (Lua token buckets keyed by
provider/application/account/endpoint), short-lived caches with tenant-scoped keys, and
token-refresh coordination hints.

**Why not BullMQ.** Fair per-tenant grouping is a BullMQ Pro feature, and Redis would become a
second source of truth needing reconciliation with PostgreSQL.

**Recovery if Redis data is lost.** No work is lost: all pending work is in PostgreSQL. Rate-limit
buckets restart **empty** (conservative: callers wait for refill) and are corrected from provider
responses (`throttleStatus`, `Retry-After`). Caches are rebuilt on read.

**Scaling limits.** See SCALING.md. Partial indexes keep claim cost proportional to due jobs. If
the claim rate ever exceeds what a single primary can handle, we will partition `jobs` by
`tenant_id` hash before introducing another broker.
