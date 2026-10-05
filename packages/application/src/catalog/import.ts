import {
  ProviderFailure,
  type CatalogInventoryLevelRecord,
  type CatalogProductRecord,
  type CatalogRecord,
  type CatalogVariantRecord,
  type IntegrationContext,
} from '@sellrelay/core';
import { catalog, jobs, outbox, repo, tenancy, type Tx } from '@sellrelay/persistence';
import type { ShopifyAdapter } from '@sellrelay/platform-shopify';
import type { AppDeps, TenantScope } from '../deps.ts';
import { JobKinds } from '../deps.ts';
import { AppError } from '../errors.ts';
import { unwrap } from '../outcome.ts';

export const CATALOG_IMPORT_KIND = 'catalog_import';

interface ExportState {
  exportId: string;
  status: 'running' | 'completed' | 'failed';
  url: string | null;
  offset: number;
  done: boolean;
  restarts: number;
}

interface ImportState {
  phase: 'start' | 'exporting' | 'ingest_products' | 'ingest_inventory' | 'finalize';
  products?: ExportState;
  inventory?: ExportState;
}

type Counters = {
  products: number;
  variants: number;
  inventoryLevels: number;
  unmappedLevels: number;
  staleSkipped: number;
  batches: number;
  locations: number;
};
const EMPTY: Counters = {
  products: 0,
  variants: 0,
  inventoryLevels: 0,
  unmappedLevels: 0,
  staleSkipped: 0,
  batches: 0,
  locations: 0,
};

export type StepResult =
  | { readonly kind: 'continue'; readonly runAt: Date }
  | { readonly kind: 'done'; readonly result: Record<string, unknown> };

export interface ImportOptions {
  readonly batchLines?: number;
  readonly timeSliceMs?: number;
  readonly pollMs?: number;
}

/**
 * Request a catalog import. Returns immediately after durable persistence (checkpoint + job).
 * A second request while one is active returns the active import (no duplicates).
 */
export async function requestCatalogImport(
  tx: Tx,
  tenantId: string,
  storeId: string,
  correlationId: string,
): Promise<{ checkpointId: string; jobId: string | null; created: boolean }> {
  const store = await tenancy.getStore(tx, storeId);
  if (!store || store.status !== 'active')
    throw new AppError('installation_inactive', 'Store is not active');
  const { checkpoint, created } = await catalog_startCheckpoint(tx, storeId);
  if (!created) return { checkpointId: checkpoint.id, jobId: checkpoint.job_id, created };
  const job = await jobs.enqueueJob(tx, {
    tenantId,
    kind: JobKinds.catalogImport,
    storeId,
    payload: { checkpointId: checkpoint.id, storeId },
    concurrencyKey: `store:${storeId}:bulk`,
    coalesceKey: `catalog-import:${storeId}`,
    maxAttempts: 8,
    correlationId,
  });
  await repo.updateCheckpoint(tx, checkpoint.id, {
    jobId: job.id,
    state: { phase: 'start' } satisfies ImportState,
    counters: EMPTY,
  });
  await repo.logActivity(tx, {
    category: 'catalog',
    severity: 'info',
    message: 'Catalog import requested',
    storeId,
    jobId: job.id,
  });
  return { checkpointId: checkpoint.id, jobId: job.id, created };
}

const catalog_startCheckpoint = (tx: Tx, storeId: string) =>
  repo.startCheckpoint(tx, storeId, CATALOG_IMPORT_KIND);

/**
 * Resumable import state machine. Each invocation does a bounded time slice then yields
 * (`continue`) so the queue stays fair across tenants. Every batch commits its data together
 * with the checkpoint offset, so a crash resumes exactly after the last committed batch.
 */
export async function runCatalogImportStep(
  deps: AppDeps,
  adapter: ShopifyAdapter,
  scope: TenantScope,
  payload: { checkpointId: string; storeId: string },
  opts: ImportOptions = {},
): Promise<StepResult> {
  const batchLines = opts.batchLines ?? 500;
  const sliceEnd = Date.now() + (opts.timeSliceMs ?? 20_000);
  const pollMs = opts.pollMs ?? 5_000;
  const ctx: IntegrationContext = {
    tenantId: scope.tenantId,
    systemId: payload.storeId,
    correlationId: scope.correlationId,
    ...(scope.signal ? { signal: scope.signal } : {}),
  };
  const cp = await scope.tx((tx) => repo.getCheckpoint(tx, payload.checkpointId));
  if (!cp || cp.status === 'completed' || cp.status === 'cancelled' || cp.status === 'failed') {
    return { kind: 'done', result: { skipped: true, status: cp?.status ?? 'missing' } };
  }
  const state = { ...(cp.state as unknown as ImportState) };
  state.phase ??= 'start';
  const counters: Counters = { ...EMPTY, ...(cp.counters as Partial<Counters>) };
  const save = (tx: Tx) =>
    repo.updateCheckpoint(tx, cp.id, {
      status: 'running',
      state: state as unknown as Record<string, unknown>,
      counters,
    });
  const fail = async (reason: string): Promise<StepResult> => {
    await scope.tx(async (tx) => {
      await repo.updateCheckpoint(tx, cp.id, { status: 'failed', error: reason, counters });
      await repo.logActivity(tx, {
        category: 'catalog',
        severity: 'error',
        message: `Catalog import failed: ${reason}`,
        storeId: payload.storeId,
      });
    });
    return { kind: 'done', result: { failed: reason } };
  };

  if (state.phase === 'start') {
    const profile = unwrap(await adapter.fetchShopProfile(ctx), 'shop profile');
    await scope.tx((tx) =>
      tenancy.updateStoreProfile(tx, payload.storeId, {
        name: profile.name,
        currency: profile.currency,
        externalStoreId: profile.id,
      }),
    );
    const locations = unwrap(await adapter.listLocations(ctx), 'locations');
    await scope.tx((tx) => catalog.upsertLocations(tx, payload.storeId, locations));
    counters.locations = locations.length;
    const products = unwrap(await adapter.startCatalogExport(ctx, 'products'), 'products export');
    const inventory = unwrap(
      await adapter.startCatalogExport(ctx, 'inventory'),
      'inventory export',
    );
    state.products = {
      exportId: products.exportId,
      status: 'running',
      url: null,
      offset: 0,
      done: false,
      restarts: 0,
    };
    state.inventory = {
      exportId: inventory.exportId,
      status: 'running',
      url: null,
      offset: 0,
      done: false,
      restarts: 0,
    };
    state.phase = 'exporting';
    await scope.tx(save);
    return { kind: 'continue', runAt: new Date(Date.now() + pollMs) };
  }

  if (state.phase === 'exporting') {
    for (const key of ['products', 'inventory'] as const) {
      const ex = state[key]!;
      if (ex.status === 'completed') continue;
      const st = unwrap(
        await adapter.getCatalogExportStatus(ctx, { kind: key, exportId: ex.exportId }),
        'export status',
      );
      if (st.state === 'completed') {
        ex.status = 'completed';
        ex.url = st.downloadUrl;
      } else if (st.state === 'failed') {
        if (ex.restarts >= 2) return fail(`${key} export failed: ${st.reason}`);
        const again = unwrap(await adapter.startCatalogExport(ctx, key), 'export restart');
        state[key] = {
          exportId: again.exportId,
          status: 'running',
          url: null,
          offset: 0,
          done: false,
          restarts: ex.restarts + 1,
        };
      }
    }
    if (state.products!.status !== 'completed' || state.inventory!.status !== 'completed') {
      await scope.tx(save);
      return { kind: 'continue', runAt: new Date(Date.now() + pollMs) };
    }
    state.phase = 'ingest_products';
    await scope.tx(save);
  }

  for (const key of ['products', 'inventory'] as const) {
    const phase = key === 'products' ? 'ingest_products' : 'ingest_inventory';
    if (state.phase !== phase) continue;
    const ex = state[key]!;
    if (ex.url) {
      let batch: CatalogRecord[] = [];
      let lastLine = ex.offset - 1;
      const flush = async () => {
        const records = batch;
        batch = [];
        await scope.tx(async (tx) => {
          if (key === 'products') {
            const products = records.filter((r): r is CatalogProductRecord => r.kind === 'product');
            const variants = records.filter((r): r is CatalogVariantRecord => r.kind === 'variant');
            const p = await catalog.upsertProducts(tx, payload.storeId, products);
            const v = await catalog.upsertVariants(tx, payload.storeId, variants);
            counters.products += p.written;
            counters.variants += v.written;
            counters.staleSkipped += p.staleSkipped + v.staleSkipped;
          } else {
            const levels = records.filter(
              (r): r is CatalogInventoryLevelRecord => r.kind === 'inventory_level',
            );
            const l = await catalog.upsertInventoryLevels(tx, payload.storeId, levels);
            counters.inventoryLevels += l.written;
            counters.unmappedLevels += l.unmapped;
            counters.staleSkipped += l.staleSkipped;
          }
          counters.batches++;
          ex.offset = lastLine + 1;
          await save(tx);
        });
      };
      try {
        let linesInBatch = 0;
        for await (const item of adapter.readCatalogExport(
          ctx,
          { kind: key, exportId: ex.exportId },
          ex.url,
          ex.offset,
        )) {
          batch.push(...item.records);
          lastLine = item.index;
          if (++linesInBatch >= batchLines) {
            await flush();
            linesInBatch = 0;
            if (Date.now() > sliceEnd) return { kind: 'continue', runAt: new Date() };
          }
        }
        if (linesInBatch > 0 || batch.length) await flush();
      } catch (e) {
        if (e instanceof ProviderFailure && e.error.code === 'not_found') {
          // Result URL expired (kept 7 days): re-run the export; upserts are idempotent.
          state.phase = 'exporting';
          const again = unwrap(await adapter.startCatalogExport(ctx, key), 'export restart');
          state[key] = {
            exportId: again.exportId,
            status: 'running',
            url: null,
            offset: 0,
            done: false,
            restarts: ex.restarts + 1,
          };
          await scope.tx(save);
          return { kind: 'continue', runAt: new Date(Date.now() + pollMs) };
        }
        throw e;
      }
    }
    ex.done = true;
    state.phase = key === 'products' ? 'ingest_inventory' : 'finalize';
    await scope.tx(save);
  }

  if (state.phase === 'finalize') {
    await scope.tx(async (tx) => {
      await repo.updateCheckpoint(tx, cp.id, {
        status: 'completed',
        state: state as unknown as Record<string, unknown>,
        counters,
      });
      await outbox.appendOutbox(tx, [
        {
          tenantId: scope.tenantId,
          type: 'catalog.import_completed',
          aggregateType: 'store',
          aggregateId: payload.storeId,
          aggregateVersion: String(Date.now()),
          payload: {
            storeId: payload.storeId,
            products: counters.products,
            variants: counters.variants,
            inventoryLevels: counters.inventoryLevels,
          },
          correlationId: scope.correlationId,
        },
      ]);
      await repo.logActivity(tx, {
        category: 'catalog',
        severity: counters.unmappedLevels ? 'warning' : 'info',
        message: `Catalog import completed: ${counters.products} products, ${counters.variants} variants, ${counters.inventoryLevels} inventory levels`,
        details: counters,
        storeId: payload.storeId,
      });
    });
    return { kind: 'done', result: counters };
  }
  return { kind: 'continue', runAt: new Date() };
}

export async function cancelCatalogImport(tx: Tx, storeId: string): Promise<boolean> {
  const cp = await repo.latestCheckpoint(tx, storeId, CATALOG_IMPORT_KIND);
  if (!cp || (cp.status !== 'running' && cp.status !== 'pending')) return false;
  await repo.updateCheckpoint(tx, cp.id, { status: 'cancelled' });
  await jobs.cancelJobsForScope(tx, { storeId }, 'catalog import cancelled by merchant');
  return true;
}

export type { ImportState, Counters };
