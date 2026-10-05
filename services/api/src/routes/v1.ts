import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  CATALOG_IMPORT_KIND,
  JobKinds,
  cancelCatalogImport,
  establishShopifySession,
  readEntitlements,
  requestCatalogImport,
  shopifyBillingProvider,
  type AppDeps,
} from '@sellrelay/application';
import {
  ALL_INTEGRATIONS,
  hasFeature,
  isOperationAvailable,
  type OperationKey,
} from '@sellrelay/core';
import { catalog, jobs, repo, tenancy, withTenant, type JobRow } from '@sellrelay/persistence';
import { bearerToken, requirePrincipal } from '../auth.ts';

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });

/** Public projection: never returns credentials, payloads or lease internals. */
function publicJob(j: JobRow) {
  return {
    id: j.id,
    kind: j.kind,
    status: j.status,
    attempts: j.attempts,
    maxAttempts: j.max_attempts,
    runAt: j.run_at,
    createdAt: j.created_at,
    finishedAt: j.finished_at,
    lastError: j.last_error
      ? { code: j.last_error['code'] ?? null, message: j.last_error['message'] ?? null }
      : null,
    result: j.result,
    replayOf: j.replay_of,
  };
}

export async function registerV1Routes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const tenantTx = <T>(tenantId: string, fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(deps.pool, tenantId, fn);

  /** Managed installation: provisions and exchanges the session token. Idempotent; call on app load. */
  app.post('/shopify/session', async (req) => {
    const r = await establishShopifySession(deps, bearerToken(req));
    return {
      tenantId: r.principal.tenantId,
      storeId: r.principal.storeId,
      shop: r.principal.shop,
      role: r.principal.role,
      activated: r.activated,
    };
  });

  app.get('/me', async (req) => {
    const p = await requirePrincipal(deps, req);
    return {
      tenantId: p.tenantId,
      userId: p.userId,
      role: p.role,
      shop: p.shop,
      storeId: p.storeId,
    };
  });

  app.get('/workspace', async (req) => {
    const p = await requirePrincipal(deps, req);
    return tenantTx(p.tenantId, async (tx) => {
      const overview = await tenancy.getWorkspaceOverview(tx);
      const ent = await readEntitlements(deps, tx, p.tenantId, p.installationId);
      const lastImport = await repo.latestCheckpoint(tx, p.storeId, CATALOG_IMPORT_KIND);
      const connections = await repo.listConnections(tx);
      return {
        workspace: overview,
        entitlements: ent,
        catalogImport: lastImport && {
          id: lastImport.id,
          status: lastImport.status,
          phase: (lastImport.state as { phase?: string }).phase ?? null,
          counters: lastImport.counters,
          startedAt: lastImport.started_at,
          completedAt: lastImport.completed_at,
          error: lastImport.error,
        },
        connections,
      };
    });
  });

  /** Capability registry merged with this tenant's connection state. Unavailable ops are explicit. */
  app.get('/integrations', async (req) => {
    const p = await requirePrincipal(deps, req);
    const connections = await tenantTx(p.tenantId, (tx) => repo.listConnections(tx));
    return {
      integrations: ALL_INTEGRATIONS.map((d) => ({
        key: d.key,
        kind: d.kind,
        displayName: d.displayName,
        wave: d.wave,
        implementation: d.implementation,
        verification: d.verification,
        approval: d.approval,
        approvalNote: d.approvalNote ?? null,
        regions: d.regions,
        operations: Object.entries(d.operations).map(([op, s]) => ({
          op,
          status: s.status,
          note: s.note ?? null,
          available: isOperationAvailable(d, op as OperationKey),
        })),
        connections: connections
          .filter((c) => c.channel_key === d.key)
          .map((c) => ({ id: c.id, state: c.state, syncEnabled: c.sync_enabled })),
        connectionState:
          d.kind === 'store_platform' && d.key === 'shopify'
            ? 'connected'
            : (connections.find((c) => c.channel_key === d.key)?.state ?? 'disconnected'),
      })),
    };
  });

  /** Starts a catalog import; returns 202 with job id after durable persistence (no remote calls). */
  app.post('/catalog/import', async (req, reply) => {
    const p = await requirePrincipal(deps, req, 'member');
    const result = await tenantTx(p.tenantId, async (tx) => {
      const ent = await readEntitlements(deps, tx, p.tenantId, p.installationId);
      // Entitlements not yet verified right after install: the free plan always includes import.
      if (ent.status !== 'unknown' && !hasFeature(ent, 'catalog_import'))
        throw new AppError('not_entitled', 'Your plan does not include catalog import');
      return requestCatalogImport(tx, p.tenantId, p.storeId, req.id);
    });
    return reply.status(202).send(result);
  });

  app.get('/catalog/import', async (req) => {
    const p = await requirePrincipal(deps, req);
    const cp = await tenantTx(p.tenantId, (tx) =>
      repo.latestCheckpoint(tx, p.storeId, CATALOG_IMPORT_KIND),
    );
    return {
      import: cp && {
        id: cp.id,
        status: cp.status,
        phase: (cp.state as { phase?: string }).phase ?? null,
        counters: cp.counters,
        jobId: cp.job_id,
        error: cp.error,
      },
    };
  });

  app.delete('/catalog/import', async (req) => {
    const p = await requirePrincipal(deps, req, 'member');
    return { cancelled: await tenantTx(p.tenantId, (tx) => cancelCatalogImport(tx, p.storeId)) };
  });

  app.get('/products', async (req) => {
    const p = await requirePrincipal(deps, req);
    const q = z
      .object({
        after: uuid.optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(req.query);
    const items = await tenantTx(p.tenantId, (tx) =>
      catalog.listProducts(tx, { limit: q.limit, ...(q.after ? { after: q.after } : {}) }),
    );
    return { items, nextCursor: items.length === q.limit ? items[items.length - 1]!.id : null };
  });

  app.get('/jobs', async (req) => {
    const p = await requirePrincipal(deps, req);
    const q = z
      .object({
        status: z
          .enum(['queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled'])
          .optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(req.query);
    const rows = await tenantTx(p.tenantId, (tx) =>
      jobs.listJobs(tx, { limit: q.limit, ...(q.status ? { status: q.status } : {}) }),
    );
    return { items: rows.map(publicJob) };
  });

  app.get('/jobs/:id', async (req) => {
    const p = await requirePrincipal(deps, req);
    const { id } = idParams.parse(req.params);
    const job = await tenantTx(p.tenantId, (tx) => jobs.getJob(tx, id));
    if (!job) throw new AppError('not_found', 'Job not found');
    return publicJob(job);
  });

  /** Audited dead-letter replay (admins). */
  app.post('/jobs/:id/replay', async (req, reply) => {
    const p = await requirePrincipal(deps, req, 'admin');
    const { id } = idParams.parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body);
    try {
      const newId = await tenantTx(p.tenantId, (tx) =>
        jobs.replayJob(tx, p.tenantId, id, `user:${p.userId}`, reason),
      );
      return reply.status(202).send({ jobId: newId });
    } catch (e) {
      if ((e as { code?: string }).code === 'P0002')
        throw new AppError('not_found', 'Job not found or not replayable');
      throw e;
    }
  });

  app.get('/activity', async (req) => {
    const p = await requirePrincipal(deps, req);
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(req.query);
    return { items: await tenantTx(p.tenantId, (tx) => repo.listActivity(tx, q.limit)) };
  });

  app.get('/billing', async (req) => {
    const p = await requirePrincipal(deps, req);
    const ent = await tenantTx(p.tenantId, (tx) =>
      readEntitlements(deps, tx, p.tenantId, p.installationId),
    );
    const provider = shopifyBillingProvider(deps);
    return {
      provider: provider.key,
      entitlements: ent,
      planSelectionUrl: provider.planManagementUrl({
        tenantId: p.tenantId,
        installationId: p.installationId,
        accountRef: p.shop,
      }),
      usageReporting: 'blocked',
    };
  });

  /** Re-verify server-side (never trusts redirect parameters). Returns the job id. */
  app.post('/billing/refresh', async (req, reply) => {
    const p = await requirePrincipal(deps, req, 'member');
    const job = await tenantTx(p.tenantId, (tx) =>
      jobs.enqueueJob(tx, {
        tenantId: p.tenantId,
        kind: JobKinds.billingVerify,
        storeId: p.storeId,
        payload: { installationId: p.installationId },
        coalesceKey: `billing:${p.installationId}`,
        priority: 5,
        correlationId: req.id,
      }),
    );
    return reply.status(202).send({ jobId: job.id });
  });

  app.get('/privacy/requests', async (req) => {
    const p = await requirePrincipal(deps, req, 'admin');
    return { items: await tenantTx(p.tenantId, (tx) => repo.listPrivacyRequests(tx, 100)) };
  });
}
