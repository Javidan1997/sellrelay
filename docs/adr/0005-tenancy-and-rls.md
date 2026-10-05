# ADR 0005 — Tenancy model and Row-Level Security

- Status: accepted (2026-10-05)

- A **tenant** is a merchant workspace, separate from any Shopify shop. Users, memberships (roles),
  stores, installations and channel connections are explicit tables.
- Every tenant-owned table has `tenant_id`, a composite primary key `(tenant_id, id)`, composite
  foreign keys, and tenant-scoped unique constraints.
- RLS is `ENABLE`d and `FORCE`d with separate `SELECT`, `INSERT`, `UPDATE` and `DELETE` policies.
  These compare against `app_current_tenant()`, which reads the transaction-local
  `app.tenant_id` setting (`set_config(..., true)`), so the context is safe with connection pooling.
- Runtime roles (`sellrelay_api`, `sellrelay_worker`) are `NOSUPERUSER NOBYPASSRLS` and own no
  tables. `sellrelay_migrator` owns the schema. `sellrelay_ops` is read-mostly for support and
  audited replay.
- Documented exceptions, implemented as narrow `SECURITY DEFINER` functions with a pinned
  `search_path`:
  1. `resolve_shopify_installation(shop_domain)` — webhook routing before tenant context exists.
  2. `provision_shopify_installation(...)` — first verified install creates tenant, store,
     installation and owner membership.
  3. `resolve_membership(provider, subject, tenant)` — identity → membership.
  4. `claim_jobs(...)`, `reclaim_expired_leases()`, `queue_stats()` — system scheduling across
     tenants. These return job rows only; a worker then sets tenant context from the job.
  5. Shared reference data (`feature_flags` rows with `tenant_id IS NULL`): readable by everyone,
     writable only by `sellrelay_ops`.
