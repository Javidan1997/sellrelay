import type { Entitlements } from '@sellrelay/core';
import { NO_ENTITLEMENTS } from '@sellrelay/core';
import { ShopifyAppPricingProvider } from '@sellrelay/billing';
import { outbox, repo, withTenant, type Tx } from '@sellrelay/persistence';
import { ShopifyGraphqlClient } from '@sellrelay/platform-shopify';
import { TenantCache } from '@sellrelay/ratelimit';
import type { AppDeps, TenantScope } from '../deps.ts';
import { loadShopifyStore } from '../shopify/access.ts';
import { getShopifyAccessToken } from '../shopify/token-vault.ts';

export function shopifyBillingProvider(deps: AppDeps): ShopifyAppPricingProvider {
  return new ShopifyAppPricingProvider({
    appHandle: deps.shopify.appHandle,
    client: async (subject) =>
      new ShopifyGraphqlClient({
        shop: subject.accountRef,
        apiVersion: deps.shopify.apiVersion,
        budget: deps.budget,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        accessToken: () =>
          getShopifyAccessToken(deps, {
            tenantId: subject.tenantId,
            installationId: subject.installationId,
            shop: subject.accountRef,
          }),
      }),
  });
}

/** Server-side verification; result persisted and cached per tenant. */
export async function verifyEntitlements(
  deps: AppDeps,
  scope: TenantScope,
  storeId: string,
): Promise<Entitlements> {
  const store = await loadShopifyStore(deps, scope.tenantId, storeId);
  if (!store.active) return NO_ENTITLEMENTS;
  const provider = shopifyBillingProvider(deps);
  const ent = await provider.verifyEntitlements(
    { tenantId: scope.tenantId, installationId: store.installationId, accountRef: store.shop },
    scope.signal,
  );
  await scope.tx(async (tx) => {
    const prev = await repo.getEntitlements(tx, store.installationId);
    await repo.upsertEntitlements(tx, {
      installationId: store.installationId,
      provider: provider.key,
      planKey: ent.planKey,
      status: ent.status,
      features: ent.features,
      limits: ent.limits,
      test: ent.test,
      providerSubscriptionId: ent.source,
      verifiedAt: ent.verifiedAt ? new Date(ent.verifiedAt) : null,
    });
    if (!prev || prev.plan_key !== ent.planKey || prev.status !== ent.status) {
      await outbox.appendOutbox(tx, [
        {
          tenantId: scope.tenantId,
          type: 'billing.entitlements_changed',
          aggregateType: 'installation',
          aggregateId: store.installationId,
          aggregateVersion: String(Date.now()),
          payload: { plan: ent.planKey, status: ent.status },
        },
      ]);
      await repo.logActivity(tx, {
        category: 'billing',
        severity: 'info',
        message: `Plan verified: ${ent.planKey} (${ent.status}${ent.test ? ', test' : ''})`,
      });
    }
  });
  await new TenantCache(deps.redis)
    .del(scope.tenantId, 'entitlements', store.installationId)
    .catch(() => undefined);
  return ent;
}

/** Read entitlements (cache → DB). Never calls the provider on the request path. */
export async function readEntitlements(
  deps: AppDeps,
  tx: Tx,
  tenantId: string,
  installationId: string,
): Promise<Entitlements> {
  const cache = new TenantCache(deps.redis);
  const cached = await cache
    .get<Entitlements>(tenantId, 'entitlements', installationId)
    .catch(() => null);
  if (cached) return cached;
  const row = await repo.getEntitlements(tx, installationId);
  const ent: Entitlements = row
    ? {
        planKey: row.plan_key,
        status: row.status,
        features: row.features as Entitlements['features'],
        limits: row.limits,
        test: row.test,
        verifiedAt: row.verified_at?.toISOString() ?? null,
        source: row.provider_subscription_id ?? row.provider,
      }
    : NO_ENTITLEMENTS;
  await cache.set(tenantId, 'entitlements', ent, 60, installationId).catch(() => undefined);
  return ent;
}

export async function readEntitlementsStandalone(
  deps: AppDeps,
  tenantId: string,
  installationId: string,
): Promise<Entitlements> {
  return withTenant(deps.pool, tenantId, (tx) =>
    readEntitlements(deps, tx, tenantId, installationId),
  );
}
