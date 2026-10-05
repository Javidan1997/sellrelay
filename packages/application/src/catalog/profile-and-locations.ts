import { ProviderFailure } from '@sellrelay/core';
import { catalog, tenancy } from '@sellrelay/persistence';
import type { ShopifyAdapter } from '@sellrelay/platform-shopify';
import type { TenantScope } from '../deps.ts';

export async function syncShopProfile(
  adapter: ShopifyAdapter,
  scope: TenantScope,
  storeId: string,
): Promise<{ currency: string }> {
  const ctx = { tenantId: scope.tenantId, systemId: storeId, correlationId: scope.correlationId };
  const out = await adapter.fetchShopProfile(ctx);
  if (out.status === 'failed') throw new ProviderFailure(out.error);
  if (out.status !== 'ok')
    throw new ProviderFailure({ code: 'permanent', message: `fetchShopProfile ${out.status}` });
  await scope.tx((tx) =>
    tenancy.updateStoreProfile(tx, storeId, {
      name: out.value.name,
      currency: out.value.currency,
      externalStoreId: out.value.id,
    }),
  );
  return { currency: out.value.currency };
}

export async function syncLocations(
  adapter: ShopifyAdapter,
  scope: TenantScope,
  storeId: string,
): Promise<{ locations: number }> {
  const ctx = { tenantId: scope.tenantId, systemId: storeId, correlationId: scope.correlationId };
  const out = await adapter.listLocations(ctx);
  if (out.status === 'failed') throw new ProviderFailure(out.error);
  if (out.status !== 'ok')
    throw new ProviderFailure({ code: 'permanent', message: `listLocations ${out.status}` });
  await scope.tx((tx) => catalog.upsertLocations(tx, storeId, out.value));
  return { locations: out.value.length };
}
