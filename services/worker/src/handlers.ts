import {
  JobKinds,
  createShopifyAdapter,
  getShopifyAccessToken,
  loadShopifyStore,
  processShopifyInboxEvent,
  reconcileInventorySample,
  refreshShopifyProduct,
  runCatalogImportStep,
  syncLocations,
  syncShopProfile,
  verifyEntitlements,
  type AppDeps,
  type ImportOptions,
  type TenantScope,
} from '@sellrelay/application';
import { findIntegration, isOperationAvailable, type MarketplaceOperation } from '@sellrelay/core';
import { jobs, repo, type Tx } from '@sellrelay/persistence';
import type { ShopifyAdapter } from '@sellrelay/platform-shopify';
import type { OutboxDispatcher } from './runtime/outbox-dispatcher.ts';
import type { HandlerRegistry, JobContext, JobHandler, JobOutcome } from './runtime/types.ts';

const scopeOf = (ctx: JobContext): TenantScope => ({
  tenantId: ctx.tenantId,
  correlationId: ctx.job.correlation_id ?? ctx.job.id,
  signal: ctx.signal,
  jobId: ctx.job.id,
  tx: ctx.tx,
});

/** Pauses (re-queues) remote-calling work while the Shopify kill switch is active. */
function guarded(handler: JobHandler): JobHandler {
  return async (ctx) => {
    if (await ctx.tx((tx) => repo.isKillSwitchActive(tx, 'shopify'))) {
      ctx.log.warn('shopify kill switch active; deferring job');
      return {
        type: 'continue',
        runAt: new Date(Date.now() + 5 * 60_000),
        payload: ctx.job.payload,
      };
    }
    return handler(ctx);
  };
}

const done = (result?: Record<string, unknown>): JobOutcome =>
  result ? { type: 'done', result } : { type: 'done' };

export function registerHandlers(
  reg: HandlerRegistry,
  deps: AppDeps,
  adapter: ShopifyAdapter = createShopifyAdapter(deps),
  importOptions: ImportOptions = {},
): HandlerRegistry {
  type P = Record<string, string>;
  // Inbox processing makes no remote calls (privacy + uninstall must work even under a kill switch).
  reg.register(JobKinds.webhookProcess, async (ctx) =>
    done(
      await processShopifyInboxEvent(
        deps,
        adapter,
        scopeOf(ctx),
        ctx.job.payload as { inboxId: string; storeId: string; installationId: string },
      ),
    ),
  );
  reg.register(
    JobKinds.catalogImport,
    guarded(async (ctx) => {
      const r = await runCatalogImportStep(
        deps,
        adapter,
        scopeOf(ctx),
        ctx.job.payload as { checkpointId: string; storeId: string },
        importOptions,
      );
      return r.kind === 'continue'
        ? { type: 'continue', runAt: r.runAt, payload: ctx.job.payload }
        : done(r.result);
    }),
  );
  reg.register(
    JobKinds.productRefresh,
    guarded(async (ctx) =>
      done(
        await refreshShopifyProduct(
          adapter,
          scopeOf(ctx),
          ctx.job.payload as { storeId: string; productId: string },
        ),
      ),
    ),
  );
  reg.register(
    JobKinds.locationsSync,
    guarded(async (ctx) =>
      done(await syncLocations(adapter, scopeOf(ctx), (ctx.job.payload as P)['storeId']!)),
    ),
  );
  reg.register(
    JobKinds.shopProfileSync,
    guarded(async (ctx) =>
      done(await syncShopProfile(adapter, scopeOf(ctx), (ctx.job.payload as P)['storeId']!)),
    ),
  );
  reg.register(
    JobKinds.billingVerify,
    guarded(async (ctx) => {
      const ent = await verifyEntitlements(deps, scopeOf(ctx), ctx.job.store_id!);
      return done({ planKey: ent.planKey, status: ent.status });
    }),
  );
  reg.register(
    JobKinds.inventoryReconcile,
    guarded(async (ctx) => {
      const repair = await ctx.tx((tx) => repo.isFeatureEnabled(tx, 'reconcile_repair', 'shopify'));
      return done(
        await reconcileInventorySample(adapter, scopeOf(ctx), ctx.job.store_id!, {
          policy: repair ? 'repair' : 'report',
        }),
      );
    }),
  );
  reg.register(
    JobKinds.credentialsRefresh,
    guarded(async (ctx) => {
      const store = await loadShopifyStore(deps, ctx.tenantId, ctx.job.store_id!);
      if (!store.active) return done({ skipped: 'inactive' });
      await getShopifyAccessToken(
        deps,
        { tenantId: ctx.tenantId, installationId: store.installationId, shop: store.shop },
        { forceRefresh: true, signal: ctx.signal },
      );
      return done({ refreshed: true });
    }),
  );
  return reg;
}

/**
 * Outbox subscribers. Inventory changes fan out only to connections whose connector actually
 * implements the `stock` operation; in Wave 0 none do, so no misleading jobs are created.
 */
export function registerSubscribers(
  dispatcher: OutboxDispatcher,
  alerts?: {
    notify(a: {
      severity: 'warning' | 'critical';
      title: string;
      tenantId?: string;
    }): Promise<void>;
  },
): void {
  dispatcher.subscribe('inventory.level_changed', async (tx: Tx, e) => {
    const conns = await repo.listSyncEnabledConnections(tx);
    for (const c of conns) {
      const d = findIntegration(c.channel_key);
      if (
        !d ||
        d.kind !== 'marketplace' ||
        !isOperationAvailable(d as never, 'stock' satisfies MarketplaceOperation as never)
      )
        continue;
      const key = `stock:${e.aggregate_id}@${c.id}`;
      await jobs.enqueueJob(tx, {
        tenantId: e.tenant_id,
        kind: `channel.${c.channel_key}.stock_update`,
        connectionId: c.id,
        concurrencyKey: `conn:${c.id}`,
        coalesceKey: key,
        entityKey: key,
        entityVersion: e.aggregate_version,
        payload: {
          variantId: e.aggregate_id,
          connectionId: c.id,
          outboxId: e.id,
          occurredAt: e.occurred_at.toISOString(),
        },
        ...(e.correlation_id ? { correlationId: e.correlation_id } : {}),
      });
    }
  });
  dispatcher.subscribe('installation.uninstalled', async (_tx, e) => {
    await alerts
      ?.notify({ severity: 'warning', title: 'Shopify app uninstalled', tenantId: e.tenant_id })
      .catch(() => undefined);
  });
}
