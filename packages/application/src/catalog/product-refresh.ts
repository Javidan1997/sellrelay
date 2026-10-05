import { ProviderFailure } from '@sellrelay/core';
import { catalog, outbox } from '@sellrelay/persistence';
import type { ShopifyAdapter } from '@sellrelay/platform-shopify';
import type { TenantScope } from '../deps.ts';

/** Re-fetch one product (webhook trigger) and upsert with stale-update rejection. */
export async function refreshShopifyProduct(
  adapter: ShopifyAdapter,
  scope: TenantScope,
  payload: { storeId: string; productId: string },
): Promise<{ result: 'upserted' | 'deleted' | 'stale' | 'missing' }> {
  const ctx = {
    tenantId: scope.tenantId,
    systemId: payload.storeId,
    correlationId: scope.correlationId,
    ...(scope.signal ? { signal: scope.signal } : {}),
  };
  const out = await adapter.fetchProduct(ctx, payload.productId);
  if (out.status === 'failed') throw new ProviderFailure(out.error);
  if (out.status !== 'ok')
    throw new ProviderFailure({ code: 'permanent', message: `fetchProduct ${out.status}` });
  if (!out.value) {
    const id = await scope.tx((tx) =>
      catalog.markProductDeleted(tx, payload.storeId, payload.productId),
    );
    return { result: id ? 'deleted' : 'missing' };
  }
  const { product, variants } = out.value;
  return scope.tx(async (tx) => {
    const p = await catalog.upsertProducts(tx, payload.storeId, [product]);
    if (p.written === 0) return { result: 'stale' as const };
    const v = await catalog.upsertVariants(tx, payload.storeId, variants);
    const productId = p.ids.get(product.externalId)!;
    await catalog.pruneMissingVariants(tx, productId, [...v.ids.values()]);
    await outbox.appendOutbox(tx, [
      {
        tenantId: scope.tenantId,
        type: 'product.upserted',
        aggregateType: 'product',
        aggregateId: productId,
        aggregateVersion: String(Date.parse(product.sourceUpdatedAt)),
        payload: { storeId: payload.storeId, productId, variantIds: [...v.ids.values()] },
        correlationId: scope.correlationId,
      },
    ]);
    return { result: 'upserted' as const };
  });
}
