import { ProviderFailure } from '@sellrelay/core';
import { withTenant } from '@sellrelay/persistence';
import { ShopifyAdapter, type ShopifySessionAccess } from '@sellrelay/platform-shopify';
import type { AppDeps } from '../deps.ts';
import { getShopifyAccessToken } from './token-vault.ts';

export interface ShopifyStoreRef {
  readonly tenantId: string;
  readonly storeId: string;
  readonly installationId: string;
  readonly shop: string;
  readonly currency: string | null;
  readonly active: boolean;
}

export async function loadShopifyStore(
  deps: AppDeps,
  tenantId: string,
  storeId: string,
): Promise<ShopifyStoreRef> {
  const row = await withTenant(
    deps.pool,
    tenantId,
    async (tx) =>
      (
        await tx.query<{
          domain: string;
          currency: string | null;
          installation_id: string;
          status: string;
        }>(
          `SELECT s.domain, s.currency, i.id AS installation_id, i.status
         FROM stores s JOIN installations i ON i.tenant_id = s.tenant_id AND i.store_id = s.id AND i.host = 'shopify'
         WHERE s.id = $1`,
          [storeId],
        )
      ).rows[0],
  );
  if (!row)
    throw new ProviderFailure({ code: 'not_found', message: 'Shopify store not found for tenant' });
  return {
    tenantId,
    storeId,
    installationId: row.installation_id,
    shop: row.domain,
    currency: row.currency,
    active: row.status === 'active',
  };
}

/** Adapter wired to the token vault, shared provider budgets and metrics. */
export function createShopifyAdapter(deps: AppDeps): ShopifyAdapter {
  return new ShopifyAdapter({
    config: deps.shopify,
    budget: deps.budget,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    onRateLimitWait: (ms) =>
      deps.metrics?.rateLimitWaits.inc({ provider: 'shopify', scope: 'account' }, ms / 1000),
    session: async (ctx): Promise<ShopifySessionAccess> => {
      const store = await loadShopifyStore(deps, ctx.tenantId, ctx.systemId);
      if (!store.active)
        throw new ProviderFailure({
          code: 'forbidden',
          message: 'Shopify installation is not active',
        });
      return {
        shop: store.shop,
        currency: store.currency ?? '',
        accessToken: () =>
          getShopifyAccessToken(
            deps,
            { tenantId: store.tenantId, installationId: store.installationId, shop: store.shop },
            ctx.signal ? { signal: ctx.signal } : {},
          ),
      };
    },
  });
}
