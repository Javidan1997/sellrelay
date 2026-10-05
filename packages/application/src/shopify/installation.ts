import { ProviderFailure } from '@sellrelay/core';
import { jobs, repo, tenancy, withTenant, type tenancy as T } from '@sellrelay/persistence';
import {
  exchangeSessionToken,
  verifySessionToken,
  SessionTokenError,
  type ShopifySessionClaims,
} from '@sellrelay/platform-shopify';
import type { AppDeps } from '../deps.ts';
import { JobKinds } from '../deps.ts';
import { AppError } from '../errors.ts';
import { credentialStatus, storeShopifyTokens } from './token-vault.ts';

export interface Principal {
  readonly provider: 'shopify';
  readonly subject: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly role: T.Role;
  readonly storeId: string;
  readonly installationId: string;
  readonly shop: string;
}

async function verify(deps: AppDeps, sessionToken: string): Promise<ShopifySessionClaims> {
  try {
    return await verifySessionToken(sessionToken, deps.shopify);
  } catch (e) {
    if (e instanceof SessionTokenError)
      throw new AppError('unauthenticated', 'Invalid or expired session token');
    throw e;
  }
}

/**
 * Per-request authentication for the embedded app: verified session token → installation →
 * membership. Tenant access is derived only from the verified shop and the user's membership.
 */
export async function authenticateShopifyRequest(
  deps: AppDeps,
  sessionToken: string,
): Promise<Principal> {
  const claims = await verify(deps, sessionToken);
  const inst = await tenancy.resolveShopifyInstallation(deps.pool, claims.shop);
  if (!inst)
    throw new AppError('not_provisioned', 'Installation not established; call /v1/shopify/session');
  if (inst.status !== 'active')
    throw new AppError('installation_inactive', 'The app is not installed on this shop');
  const subject = `${claims.shop}:${claims.userId}`;
  const membership = await tenancy.resolveMembership(deps.pool, 'shopify', subject, inst.tenantId);
  if (!membership)
    throw new AppError('not_provisioned', 'User not provisioned; call /v1/shopify/session');
  return {
    provider: 'shopify',
    subject,
    tenantId: inst.tenantId,
    userId: membership.userId,
    role: membership.role,
    storeId: inst.storeId,
    installationId: inst.installationId,
    shop: claims.shop,
  };
}

/**
 * Managed installation: called when the embedded app loads. Provisions tenant/store/installation
 * and membership, then performs token exchange for an expiring offline token when none is
 * stored (or it can no longer be refreshed, or scopes changed). Long-running follow-ups are
 * queued as jobs; no synchronization is started automatically.
 */
export async function establishShopifySession(
  deps: AppDeps,
  sessionToken: string,
): Promise<{ principal: Principal; activated: boolean; tokenExchanged: boolean }> {
  const claims = await verify(deps, sessionToken);
  const prov = await tenancy.provisionShopifyInstallation(deps.pool, {
    shopDomain: claims.shop,
    userSubject: claims.userId,
    apiVersion: deps.shopify.apiVersion,
  });
  const status = await withTenant(deps.pool, prov.tenantId, (tx) =>
    credentialStatus(deps, tx, prov.tenantId, prov.installationId),
  );
  const wanted = [...deps.shopify.scopes].sort().join(',');
  const needsExchange =
    !status.present || status.refreshExpired || [...status.scopes].sort().join(',') !== wanted;
  let tokenExchanged = false;
  if (needsExchange) {
    let tokens;
    try {
      tokens = await exchangeSessionToken(
        deps.shopify,
        claims.shop,
        sessionToken,
        deps.fetch ? { fetch: deps.fetch } : {},
      );
    } catch (e) {
      if (e instanceof ProviderFailure)
        throw new AppError('unavailable', 'Shopify authorization failed; please reload the app');
      throw e;
    }
    await withTenant(deps.pool, prov.tenantId, async (tx) => {
      await storeShopifyTokens(deps, tx, prov.tenantId, prov.installationId, tokens);
      await tenancy.updateInstallationScopes(tx, prov.installationId, tokens.scopes);
    });
    tokenExchanged = true;
  }
  if (prov.activated || tokenExchanged) {
    await withTenant(deps.pool, prov.tenantId, async (tx) => {
      if (prov.activated) {
        await repo.logActivity(tx, {
          category: 'installation',
          severity: 'info',
          message: 'SellRelay installed on Shopify store',
          storeId: prov.storeId,
        });
        await tx.query(
          `INSERT INTO outbox (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload)
           VALUES (app_current_tenant(), 'installation.activated', 'installation', $1, $2, $3)`,
          [
            prov.installationId,
            String(Date.now()),
            { storeId: prov.storeId, installationId: prov.installationId },
          ],
        );
      }
      await jobs.enqueueJob(tx, {
        tenantId: prov.tenantId,
        kind: JobKinds.shopProfileSync,
        storeId: prov.storeId,
        coalesceKey: `profile:${prov.storeId}`,
        payload: { storeId: prov.storeId },
      });
      await jobs.enqueueJob(tx, {
        tenantId: prov.tenantId,
        kind: JobKinds.billingVerify,
        storeId: prov.storeId,
        coalesceKey: `billing:${prov.installationId}`,
        payload: { installationId: prov.installationId },
      });
    });
  }
  return {
    principal: {
      provider: 'shopify',
      subject: `${claims.shop}:${claims.userId}`,
      tenantId: prov.tenantId,
      userId: prov.userId,
      role: prov.role,
      storeId: prov.storeId,
      installationId: prov.installationId,
      shop: claims.shop,
    },
    activated: prov.activated,
    tokenExchanged,
  };
}
