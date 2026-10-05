import { ProviderFailure } from '@sellrelay/core';
import type { ShopifyAppConfig } from './config.ts';
import { classifyHttpError, shopifyFetch, type ShopifyHttpOptions } from './http.ts';
import { requireShopDomain } from './shop-domain.ts';

/** Offline token set. With expiring tokens Shopify returns refresh data as well. */
export interface ShopifyTokenSet {
  readonly accessToken: string;
  readonly scopes: readonly string[];
  readonly accessTokenExpiresAt: Date | null;
  readonly refreshToken: string | null;
  readonly refreshTokenExpiresAt: Date | null;
}

interface AccessTokenResponse {
  access_token?: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

function toTokenSet(body: AccessTokenResponse, now: number): ShopifyTokenSet {
  if (!body.access_token)
    throw new ProviderFailure({
      code: 'permanent',
      message: 'Token response missing access_token',
    });
  return {
    accessToken: body.access_token,
    scopes: (body.scope ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    accessTokenExpiresAt: body.expires_in ? new Date(now + body.expires_in * 1000) : null,
    refreshToken: body.refresh_token ?? null,
    refreshTokenExpiresAt:
      body.refresh_token && body.refresh_token_expires_in
        ? new Date(now + body.refresh_token_expires_in * 1000)
        : null,
  };
}

async function postAccessToken(
  shop: string,
  body: Record<string, string>,
  opts: ShopifyHttpOptions & { signal?: AbortSignal },
): Promise<ShopifyTokenSet> {
  const url = `https://${requireShopDomain(shop)}/admin/oauth/access_token`;
  const res = await shopifyFetch(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
    opts,
  );
  if (!res.ok) {
    // 400/401 from the token endpoint means the grant is invalid (uninstalled, revoked, expired refresh token).
    if (res.status === 400 || res.status === 401)
      throw new ProviderFailure({
        code: 'auth_revoked',
        httpStatus: res.status,
        message: 'Shopify rejected the token grant',
      });
    throw classifyHttpError(res, 'token endpoint');
  }
  return toTokenSet((await res.json()) as AccessTokenResponse, Date.now());
}

/** Managed-install token exchange: session token → expiring offline access token. */
export function exchangeSessionToken(
  config: ShopifyAppConfig,
  shop: string,
  sessionToken: string,
  opts: ShopifyHttpOptions & { signal?: AbortSignal } = {},
): Promise<ShopifyTokenSet> {
  return postAccessToken(
    shop,
    {
      client_id: config.apiKey,
      client_secret: config.apiSecret,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: sessionToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
      expiring: '1',
    },
    opts,
  );
}

export function refreshOfflineToken(
  config: ShopifyAppConfig,
  shop: string,
  refreshToken: string,
  opts: ShopifyHttpOptions & { signal?: AbortSignal } = {},
): Promise<ShopifyTokenSet> {
  return postAccessToken(
    shop,
    {
      client_id: config.apiKey,
      client_secret: config.apiSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    },
    opts,
  );
}
