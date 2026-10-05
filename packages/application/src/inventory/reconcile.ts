import { catalog, repo } from '@sellrelay/persistence';
import type { ShopifyAdapter } from '@sellrelay/platform-shopify';
import type { TenantScope } from '../deps.ts';
import { unwrap } from '../outcome.ts';

export type ReconcilePolicy = 'report' | 'repair';

/**
 * Drift detection between the local inventory mirror and Shopify for a random sample of items.
 * Default policy only reports. `repair` (explicit per-tenant flag) re-applies the source values,
 * still subject to stale-version checks.
 */
export async function reconcileInventorySample(
  adapter: ShopifyAdapter,
  scope: TenantScope,
  storeId: string,
  opts: { sampleSize?: number; policy?: ReconcilePolicy } = {},
): Promise<{ sampled: number; drifted: number; repaired: number }> {
  const sample = await scope.tx(
    async (tx) =>
      (
        await tx.query<{ item: string; location: string; available: number }>(
          `SELECT ri.external_id AS item, rl.external_id AS location, il.available
         FROM inventory_levels il
         JOIN external_references ri ON ri.tenant_id = il.tenant_id AND ri.canonical_id = il.variant_id AND ri.object_type = 'inventory_item' AND ri.system_id = $1
         JOIN external_references rl ON rl.tenant_id = il.tenant_id AND rl.canonical_id = il.location_id AND rl.object_type = 'location' AND rl.system_id = $1
         ORDER BY random() LIMIT $2`,
          [storeId, opts.sampleSize ?? 50],
        )
      ).rows,
  );
  if (sample.length === 0) return { sampled: 0, drifted: 0, repaired: 0 };
  const ctx = { tenantId: scope.tenantId, systemId: storeId, correlationId: scope.correlationId };
  const remote = unwrap(
    await adapter.fetchInventoryLevels(ctx, [...new Set(sample.map((s) => s.item))]),
    'inventory levels',
  );
  const remoteMap = new Map(
    remote.map((r) => [`${r.inventoryItemExternalId}|${r.locationExternalId}`, r]),
  );
  const drift = sample.filter((s) => {
    const r = remoteMap.get(`${s.item}|${s.location}`);
    return r !== undefined && r.available !== s.available;
  });
  let repaired = 0;
  await scope.tx(async (tx) => {
    if (drift.length && opts.policy === 'repair') {
      const res = await catalog.upsertInventoryLevels(
        tx,
        storeId,
        drift.map((d) => remoteMap.get(`${d.item}|${d.location}`)!),
      );
      repaired = res.written;
    }
    if (drift.length) {
      await repo.logActivity(tx, {
        category: 'reconciliation',
        severity: 'warning',
        message: `Inventory drift detected for ${drift.length} of ${sample.length} sampled levels (policy: ${opts.policy ?? 'report'})`,
        details: { drifted: drift.length, repaired },
        storeId,
      });
    }
  });
  return { sampled: sample.length, drifted: drift.length, repaired };
}
