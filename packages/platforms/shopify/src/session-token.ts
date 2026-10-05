import { errors, jwtVerify } from 'jose';
import type { ShopifyAppConfig } from './config.ts';
import { normalizeShopDomain } from './shop-domain.ts';

/** Verified Shopify session token (App Bridge id token). */
export interface ShopifySessionClaims {
  readonly shop: string;
  /** Shopify user id (`sub`) — staff member using the embedded app. */
  readonly userId: string;
  readonly sessionId: string | undefined;
  readonly expiresAt: Date;
}

export class SessionTokenError extends Error {
  readonly reason: 'malformed' | 'signature' | 'expired' | 'audience' | 'shop';
  constructor(reason: 'malformed' | 'signature' | 'expired' | 'audience' | 'shop') {
    super(`Invalid session token: ${reason}`);
    this.reason = reason;
    this.name = 'SessionTokenError';
  }
}

const CLOCK_TOLERANCE_SECONDS = 10;

/**
 * Verifies an App Bridge session token as Shopify's official library does: HS256 with the app
 * secret, exp/nbf with 10s tolerance, `aud` equal to the API key. Additionally requires
 * `iss` and `dest` to agree on a valid *.myshopify.com shop.
 */
export async function verifySessionToken(
  token: string,
  config: ShopifyAppConfig,
  now: Date = new Date(),
): Promise<ShopifySessionClaims> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, new TextEncoder().encode(config.apiSecret), {
      algorithms: ['HS256'],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      currentDate: now,
    }));
  } catch (e) {
    if (e instanceof errors.JWTExpired) throw new SessionTokenError('expired');
    if (e instanceof errors.JWSSignatureVerificationFailed)
      throw new SessionTokenError('signature');
    throw new SessionTokenError('malformed');
  }
  if (payload.aud !== config.apiKey) throw new SessionTokenError('audience');
  const dest = typeof payload['dest'] === 'string' ? payload['dest'] : '';
  const iss = typeof payload.iss === 'string' ? payload.iss : '';
  const shop = normalizeShopDomain(dest);
  const issShop = normalizeShopDomain(iss.replace(/\/admin\/?$/, ''));
  if (!shop || shop !== issShop) throw new SessionTokenError('shop');
  if (typeof payload.sub !== 'string' || payload.sub === '' || typeof payload.exp !== 'number')
    throw new SessionTokenError('malformed');
  return {
    shop,
    userId: payload.sub,
    sessionId: typeof payload['sid'] === 'string' ? payload['sid'] : undefined,
    expiresAt: new Date(payload.exp * 1000),
  };
}
