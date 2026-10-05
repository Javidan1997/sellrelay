import { randomUUID } from 'node:crypto';
import { ProviderFailure } from '@sellrelay/core';
import { credentials, withTenant, type Tx } from '@sellrelay/persistence';
import { refreshOfflineToken, type ShopifyTokenSet } from '@sellrelay/platform-shopify';
import { credentialAad, type Envelope } from '@sellrelay/security';
import type { AppDeps } from '../deps.ts';

export const SHOPIFY_TOKEN_KIND = 'shopify_offline_token';

interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  scopes: readonly string[];
}

const aad = (tenantId: string, installationId: string) =>
  credentialAad(tenantId, 'installation', installationId, SHOPIFY_TOKEN_KIND);

export async function storeShopifyTokens(
  deps: AppDeps,
  tx: Tx,
  tenantId: string,
  installationId: string,
  tokens: ShopifyTokenSet,
): Promise<void> {
  const envelope = await deps.secretBox.seal(
    {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      scopes: tokens.scopes,
    } satisfies StoredTokens,
    aad(tenantId, installationId),
  );
  await credentials.upsertCredential(tx, {
    ownerKind: 'installation',
    ownerId: installationId,
    kind: SHOPIFY_TOKEN_KIND,
    envelope: envelope as unknown as Record<string, unknown>,
    keyId: envelope.kid,
    accessExpiresAt: tokens.accessTokenExpiresAt,
    refreshExpiresAt: tokens.refreshTokenExpiresAt,
  });
}

export interface CredentialStatus {
  readonly present: boolean;
  readonly refreshExpired: boolean;
  readonly scopes: readonly string[];
}

export async function credentialStatus(
  deps: AppDeps,
  tx: Tx,
  tenantId: string,
  installationId: string,
): Promise<CredentialStatus> {
  const row = await credentials.getCredential(
    tx,
    'installation',
    installationId,
    SHOPIFY_TOKEN_KIND,
  );
  if (!row) return { present: false, refreshExpired: true, scopes: [] };
  const stored = await deps.secretBox.open<StoredTokens>(
    row.envelope as unknown as Envelope,
    aad(tenantId, installationId),
  );
  const now = Date.now();
  const accessDead = row.access_expires_at !== null && row.access_expires_at.getTime() <= now;
  const refreshDead =
    row.refresh_expires_at === null ? accessDead : row.refresh_expires_at.getTime() <= now;
  return { present: true, refreshExpired: accessDead && refreshDead, scopes: stored.scopes };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Returns a valid offline access token, refreshing expiring tokens with concurrent-refresh
 * protection: one caller wins a short row lease; others wait for the new version. The refresh
 * HTTP call runs with no database transaction open.
 */
export async function getShopifyAccessToken(
  deps: AppDeps,
  ref: { tenantId: string; installationId: string; shop: string },
  opts: { minValidityMs?: number; signal?: AbortSignal; forceRefresh?: boolean } = {},
): Promise<string> {
  const minValidity = opts.minValidityMs ?? 120_000;
  const owner = `refresh:${randomUUID()}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    const row = await withTenant(deps.pool, ref.tenantId, (tx) =>
      credentials.getCredential(tx, 'installation', ref.installationId, SHOPIFY_TOKEN_KIND),
    );
    if (!row)
      throw new ProviderFailure({
        code: 'auth_revoked',
        message: 'No Shopify credential: merchant must open the app to re-authorize',
      });
    const tokens = await deps.secretBox.open<StoredTokens>(
      row.envelope as unknown as Envelope,
      aad(ref.tenantId, ref.installationId),
    );
    const fresh =
      row.access_expires_at === null || row.access_expires_at.getTime() - Date.now() > minValidity;
    if (fresh && !opts.forceRefresh) return tokens.accessToken;
    if (!tokens.refreshToken) {
      if (row.access_expires_at === null) return tokens.accessToken;
      throw new ProviderFailure({
        code: 'auth_revoked',
        message: 'Access token expired and no refresh token is stored',
      });
    }
    const locked = await withTenant(deps.pool, ref.tenantId, (tx) =>
      credentials.tryAcquireRefreshLock(tx, row.id, owner, 30),
    );
    if (!locked) {
      if (Date.now() > deadline)
        throw new ProviderFailure({
          code: 'transient',
          message: 'Timed out waiting for concurrent token refresh',
        });
      await sleep(200);
      opts = { ...opts, forceRefresh: false };
      continue;
    }
    if (locked.version !== row.version) {
      // Someone refreshed between our read and lock; release and re-read.
      await withTenant(deps.pool, ref.tenantId, (tx) =>
        credentials.releaseRefreshLock(tx, row.id, owner),
      );
      continue;
    }
    let refreshed;
    try {
      refreshed = await refreshOfflineToken(deps.shopify, ref.shop, tokens.refreshToken, {
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (e) {
      await withTenant(deps.pool, ref.tenantId, async (tx) => {
        if (e instanceof ProviderFailure && e.error.code === 'auth_revoked') {
          await credentials.deleteCredential(tx, row.id);
          await tx.query(
            `INSERT INTO activity_log (tenant_id, category, severity, message, details) VALUES (app_current_tenant(), 'auth', 'error', $1, '{}')`,
            ['Shopify authorization expired. Open SellRelay in Shopify admin to re-authorize.'],
          );
        } else {
          await credentials.releaseRefreshLock(tx, row.id, owner);
        }
      });
      throw e;
    }
    const envelope = await deps.secretBox.seal(
      {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
        scopes: refreshed.scopes.length ? refreshed.scopes : tokens.scopes,
      } satisfies StoredTokens,
      aad(ref.tenantId, ref.installationId),
    );
    const stored = await withTenant(deps.pool, ref.tenantId, (tx) =>
      credentials.storeRefreshedCredential(tx, row.id, owner, locked.version, {
        envelope: envelope as unknown as Record<string, unknown>,
        keyId: envelope.kid,
        accessExpiresAt: refreshed.accessTokenExpiresAt,
        refreshExpiresAt: refreshed.refreshTokenExpiresAt ?? row.refresh_expires_at,
      }),
    );
    if (!stored) continue;
    return refreshed.accessToken;
  }
}
