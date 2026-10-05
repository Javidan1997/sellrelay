/** Explicitly pinned Admin API version. Never "latest" or "unstable" in production. */
export const SHOPIFY_API_VERSION = '2026-10' as const;

export interface ShopifyAppConfig {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly apiVersion: string;
  readonly scopes: readonly string[];
  readonly appHandle: string;
}

const VERSION_RE = /^\d{4}-(01|04|07|10)$/;

export function shopifyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ShopifyAppConfig {
  const apiVersion = env['SHOPIFY_API_VERSION'] ?? SHOPIFY_API_VERSION;
  if (!VERSION_RE.test(apiVersion))
    throw new Error(`SHOPIFY_API_VERSION must be an explicit stable version, got ${apiVersion}`);
  const apiKey = env['SHOPIFY_API_KEY'] ?? '';
  const apiSecret = env['SHOPIFY_API_SECRET'] ?? '';
  return {
    apiKey,
    apiSecret,
    apiVersion,
    scopes: (env['SHOPIFY_SCOPES'] ?? 'read_products,read_inventory,read_locations')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    appHandle: env['SHOPIFY_APP_HANDLE'] ?? 'sellrelay',
  };
}

export function assertConfigured(config: ShopifyAppConfig): void {
  if (!config.apiKey || !config.apiSecret)
    throw new Error('SHOPIFY_API_KEY and SHOPIFY_API_SECRET must be configured');
}
