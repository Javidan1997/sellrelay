import {
  ProviderFailure,
  timestampVersion,
  type NormalizedStoreEvent,
  type VerifiedWebhook,
} from '@sellrelay/core';
import { catalog, inbox, jobs, outbox, repo, tenancy, type Tx } from '@sellrelay/persistence';
import type { ShopifyAdapter } from '@sellrelay/platform-shopify';
import type { AppDeps, TenantScope } from '../deps.ts';
import { JobKinds } from '../deps.ts';
import { handlePrivacyEvent } from '../privacy/shopify-privacy.ts';

/**
 * Processes one persisted webhook (idempotent: re-running yields the same state).
 * Remote calls never happen here; follow-ups are enqueued as jobs.
 */
export async function processShopifyInboxEvent(
  deps: AppDeps,
  adapter: ShopifyAdapter,
  scope: TenantScope,
  payload: { inboxId: string; storeId: string; installationId: string },
): Promise<{ events: string[]; status: 'processed' | 'ignored' }> {
  const row = await scope.tx((tx) => inbox.getInboxEvent(tx, payload.inboxId));
  if (!row) throw new ProviderFailure({ code: 'not_found', message: 'inbox event not found' });
  if (row.status === 'processed' || row.status === 'ignored')
    return { events: [], status: row.status };
  if (row.payload === null) return { events: [], status: 'ignored' };

  const webhook: VerifiedWebhook = {
    platform: 'shopify',
    topic: row.topic,
    storeIdentity: '',
    payload: row.payload,
  };
  const events = adapter.normalizeWebhook(webhook);
  const handled: string[] = [];
  for (const event of events) {
    if (event.type.startsWith('privacy.')) {
      await handlePrivacyEvent(deps, scope, { ...payload, event, receivedAt: row.received_at });
    } else {
      await scope.tx((tx) => applyStoreEvent(deps, tx, scope, payload, event, row.received_at));
    }
    handled.push(event.type);
  }
  const status = events.every((e) => e.type === 'ignored') ? 'ignored' : 'processed';
  await scope.tx((tx) => inbox.markInboxProcessed(tx, row.id, status));
  return { events: handled, status };
}

async function applyStoreEvent(
  deps: AppDeps,
  tx: Tx,
  scope: TenantScope,
  ref: { storeId: string; installationId: string },
  event: NormalizedStoreEvent,
  receivedAt: Date,
): Promise<void> {
  const tenantId = scope.tenantId;
  switch (event.type) {
    case 'product.refresh_requested': {
      // Coalesced per product: a burst of updates results in one fetch of the latest state.
      await jobs.enqueueJob(tx, {
        tenantId,
        kind: JobKinds.productRefresh,
        storeId: ref.storeId,
        payload: { storeId: ref.storeId, productId: event.productExternalId },
        coalesceKey: `product:${event.productExternalId}`,
        entityKey: `product:${event.productExternalId}`,
        ...(event.sourceUpdatedAt
          ? { entityVersion: timestampVersion(event.sourceUpdatedAt) }
          : {}),
        correlationId: scope.correlationId,
      });
      return;
    }
    case 'product.deleted': {
      const id = await catalog.markProductDeleted(tx, ref.storeId, event.productExternalId);
      if (id) {
        await outbox.appendOutbox(tx, [
          {
            tenantId,
            type: 'product.deleted',
            aggregateType: 'product',
            aggregateId: id,
            aggregateVersion: String(Date.now()),
            payload: { storeId: ref.storeId, productId: id },
            correlationId: scope.correlationId,
          },
        ]);
      }
      return;
    }
    case 'inventory.level_reported': {
      const r = await catalog.upsertInventoryLevels(tx, ref.storeId, [event.level]);
      if (r.changes.length) {
        await outbox.appendOutbox(
          tx,
          r.changes.map((c) => ({
            tenantId,
            type: 'inventory.level_changed',
            aggregateType: 'variant',
            aggregateId: c.variantId,
            aggregateVersion: timestampVersion(c.sourceUpdatedAt),
            payload: {
              storeId: ref.storeId,
              variantId: c.variantId,
              locationId: c.locationId,
              available: c.available,
              previous: c.previous,
            },
            correlationId: scope.correlationId,
          })),
        );
      }
      if (r.unmapped) {
        await repo.logActivity(tx, {
          category: 'inventory',
          severity: 'warning',
          message:
            'Inventory update for an item or location not yet imported; run a catalog import to map it',
          details: { inventoryItem: event.level.inventoryItemExternalId },
          storeId: ref.storeId,
        });
      }
      deps.metrics?.syncLatency.observe(
        { provider: 'shopify', kind: 'inventory_ingest' },
        (Date.now() - receivedAt.getTime()) / 1000,
      );
      return;
    }
    case 'location.changed':
      await jobs.enqueueJob(tx, {
        tenantId,
        kind: JobKinds.locationsSync,
        storeId: ref.storeId,
        payload: { storeId: ref.storeId },
        coalesceKey: `locations:${ref.storeId}`,
      });
      return;
    case 'lifecycle.uninstalled': {
      const inst = await tenancy.getInstallation(tx, ref.installationId);
      if (inst?.status === 'active')
        await tenancy.markInstallationUninstalled(tx, ref.installationId);
      return;
    }
    case 'lifecycle.scopes_updated':
      await tenancy.updateInstallationScopes(tx, ref.installationId, event.scopes);
      return;
    case 'catalog.export_finished':
      // Wake the waiting import immediately instead of at its next poll.
      await tx.query(
        `UPDATE jobs SET run_at = now() WHERE kind = $1 AND status = 'queued' AND store_id = $2`,
        [JobKinds.catalogImport, ref.storeId],
      );
      return;
    case 'billing.subscription_changed':
      await jobs.enqueueJob(tx, {
        tenantId,
        kind: JobKinds.billingVerify,
        storeId: ref.storeId,
        payload: { installationId: ref.installationId },
        coalesceKey: `billing:${ref.installationId}`,
      });
      return;
    case 'ignored':
      return;
    default:
      throw new Error(`unexpected event ${event.type}`);
  }
}
