import { parseRetryAfter, ProviderFailure } from '@sellrelay/core';
import { assertNoOpenTransaction } from '@sellrelay/observability';
import { validateOutboundUrl } from '@sellrelay/security';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ShopifyHttpOptions {
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

/**
 * All outbound Shopify calls go through here: host allow-list (*.myshopify.com), no open DB
 * transaction, timeout, and classification of transport failures.
 */
export async function shopifyFetch(
  url: string,
  init: RequestInit & { signal?: AbortSignal },
  opts: ShopifyHttpOptions = {},
): Promise<Response> {
  assertNoOpenTransaction(`shopify ${new URL(url).pathname}`);
  validateOutboundUrl(url, { allowedHosts: ['.myshopify.com'] });
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 30_000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  try {
    return await (opts.fetch ?? fetch)(url, { ...init, signal, redirect: 'error' });
  } catch (e) {
    if (init.signal?.aborted) throw init.signal.reason;
    const timedOut = timeout.aborted;
    throw new ProviderFailure({
      code: timedOut ? 'timeout' : 'transient',
      message: timedOut
        ? 'Shopify request timed out'
        : `Shopify request failed: ${e instanceof Error ? e.name : 'error'}`,
    });
  }
}

export function classifyHttpError(res: Response, context: string): ProviderFailure {
  const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
  const base = {
    httpStatus: res.status,
    message: `${context}: HTTP ${res.status}`,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
  if (res.status === 429)
    return new ProviderFailure({
      ...base,
      code: 'rate_limited',
      retryAfterMs: retryAfterMs ?? 2000,
    });
  if (res.status === 401) return new ProviderFailure({ ...base, code: 'auth_expired' });
  if (res.status === 402 || res.status === 403 || res.status === 423)
    return new ProviderFailure({ ...base, code: 'forbidden' });
  if (res.status === 404) return new ProviderFailure({ ...base, code: 'not_found' });
  if (res.status >= 500) return new ProviderFailure({ ...base, code: 'transient' });
  return new ProviderFailure({ ...base, code: 'permanent' });
}
