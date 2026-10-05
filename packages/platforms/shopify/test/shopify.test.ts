import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderFailure } from '../../../core/src/index.ts';
import { type RateBudget } from '../../../core/src/index.ts';
import {
  runInTransactionScope,
  TransactionHeldDuringExternalCallError,
} from '../../../observability/src/index.ts';
import {
  ShopifyAdapter,
  ShopifyGraphqlClient,
  SessionTokenError,
  computeWebhookHmac,
  exchangeSessionToken,
  normalizeShopDomain,
  normalizeShopifyWebhook,
  refreshOfflineToken,
  verifySessionToken,
  verifyShopifyWebhook,
  webhookDedupeKey,
  type FetchLike,
  type ShopifyAppConfig,
} from '../src/index.ts';
import { SHOP, webhookPayloads } from './fixtures/webhooks.ts';

const here = dirname(fileURLToPath(import.meta.url));
const config: ShopifyAppConfig = {
  apiKey: 'test-api-key',
  apiSecret: 'test-api-secret',
  apiVersion: '2026-10',
  scopes: ['read_products'],
  appHandle: 'sellrelay',
};

async function sessionToken(
  overrides: Record<string, unknown> = {},
  secret = config.apiSecret,
  expSeconds = 60,
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: `https://${SHOP}/admin`,
    dest: `https://${SHOP}`,
    aud: config.apiKey,
    sub: '42',
    sid: 's-1',
    jti: 'j',
    ...overrides,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setNotBefore(now - 1)
    .setExpirationTime(now + expSeconds)
    .sign(new TextEncoder().encode(secret));
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('shop domains', () => {
  it('accepts only *.myshopify.com', () => {
    expect(normalizeShopDomain('HTTPS://Demo-1.myshopify.com/')).toBe('demo-1.myshopify.com');
    for (const bad of [
      'evil.com',
      'demo.myshopify.com.evil.com',
      'a.b.myshopify.com',
      '127.0.0.1',
      'demo.myshopify.io',
    ]) {
      expect(normalizeShopDomain(bad), bad).toBeNull();
    }
  });
});

describe('session tokens', () => {
  it('verifies a valid App Bridge session token', async () => {
    const claims = await verifySessionToken(await sessionToken(), config);
    expect(claims).toMatchObject({ shop: SHOP, userId: '42', sessionId: 's-1' });
  });

  it.each([
    ['signature', async () => sessionToken({}, 'wrong-secret')],
    ['audience', async () => sessionToken({ aud: 'other-app' })],
    ['expired', async () => sessionToken({}, config.apiSecret, -120)],
    ['shop', async () => sessionToken({ dest: 'https://evil.com' })],
    ['shop', async () => sessionToken({ iss: 'https://other-shop.myshopify.com/admin' })],
  ])('rejects tokens with bad %s', async (reason, make) => {
    await expect(verifySessionToken(await make(), config)).rejects.toMatchObject({ reason });
  });

  it('rejects garbage and alg=none tokens', async () => {
    await expect(verifySessionToken('not-a-jwt', config)).rejects.toBeInstanceOf(SessionTokenError);
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({
        aud: config.apiKey,
        dest: `https://${SHOP}`,
        iss: `https://${SHOP}/admin`,
        sub: '1',
        exp: 9999999999,
      }),
    ).toString('base64url');
    await expect(verifySessionToken(`${header}.${body}.`, config)).rejects.toBeInstanceOf(
      SessionTokenError,
    );
  });
});

describe('webhook verification', () => {
  const raw = Buffer.from(
    '{"id":1001, "admin_graphql_api_id":"gid://shopify/Product/1001","updated_at":"2026-10-04T12:00:00Z"}',
  );
  const headers = (body: Buffer, extra: Record<string, string> = {}) => ({
    'x-shopify-hmac-sha256': computeWebhookHmac(config.apiSecret, body),
    'x-shopify-topic': 'products/update',
    'x-shopify-shop-domain': SHOP,
    'x-shopify-api-version': '2026-10',
    'x-shopify-webhook-id': 'delivery-1',
    'x-shopify-event-id': 'event-1',
    ...extra,
  });

  it('verifies HMAC over the raw body and extracts identifiers', () => {
    const r = verifyShopifyWebhook({ headers: headers(raw), rawBody: raw }, config.apiSecret);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.webhook).toMatchObject({
        topic: 'products/update',
        storeIdentity: SHOP,
        providerEventId: 'event-1',
        providerDeliveryId: 'delivery-1',
        apiVersion: '2026-10',
      });
      expect(webhookDedupeKey(r.webhook, raw)).toBe('event-1');
    }
  });

  it('fails when the body was re-serialized (raw bytes matter)', () => {
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(raw.toString())));
    expect(reserialized.equals(raw)).toBe(false);
    expect(
      verifyShopifyWebhook({ headers: headers(raw), rawBody: reserialized }, config.apiSecret),
    ).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('rejects tampering, wrong secret and missing headers', () => {
    const tampered = Buffer.from(raw.toString().replace('1001', '1002'));
    expect(
      verifyShopifyWebhook({ headers: headers(raw), rawBody: tampered }, config.apiSecret),
    ).toEqual({ ok: false, reason: 'invalid_signature' });
    expect(verifyShopifyWebhook({ headers: headers(raw), rawBody: raw }, 'other-secret')).toEqual({
      ok: false,
      reason: 'invalid_signature',
    });
    expect(
      verifyShopifyWebhook(
        { headers: { 'x-shopify-topic': 'products/update' }, rawBody: raw },
        config.apiSecret,
      ),
    ).toEqual({ ok: false, reason: 'missing_headers' });
  });

  it('supports events-style lowercase shopify-* headers', () => {
    const h = {
      'shopify-hmac-sha256': computeWebhookHmac(config.apiSecret, raw),
      'shopify-topic': 'products/update',
      'shopify-shop-domain': SHOP,
      'shopify-webhook-id': 'd-2',
    };
    const r = verifyShopifyWebhook({ headers: h, rawBody: raw }, config.apiSecret);
    expect(r.ok && webhookDedupeKey(r.webhook, raw)).toBe('d-2');
  });
});

describe('webhook normalization (synthetic payloads)', () => {
  const norm = (topic: string) =>
    normalizeShopifyWebhook({
      platform: 'shopify',
      topic,
      storeIdentity: SHOP,
      payload: webhookPayloads[topic],
    });

  it('maps every subscribed topic to canonical events', () => {
    expect(norm('products/update')).toEqual([
      {
        type: 'product.refresh_requested',
        productExternalId: 'gid://shopify/Product/1001',
        sourceUpdatedAt: '2026-10-04T12:00:00-00:00',
      },
    ]);
    expect(norm('products/delete')).toEqual([
      { type: 'product.deleted', productExternalId: 'gid://shopify/Product/1002' },
    ]);
    expect(norm('inventory_levels/update')).toEqual([
      {
        type: 'inventory.level_reported',
        level: {
          kind: 'inventory_level',
          inventoryItemExternalId: 'gid://shopify/InventoryItem/3001',
          locationExternalId: 'gid://shopify/Location/5001',
          available: 7,
          sourceUpdatedAt: '2026-10-04T12:01:00-00:00',
        },
      },
    ]);
    expect(norm('locations/update')).toEqual([
      { type: 'location.changed', locationExternalId: 'gid://shopify/Location/5001' },
    ]);
    expect(norm('app/uninstalled')).toEqual([{ type: 'lifecycle.uninstalled' }]);
    expect(norm('app/scopes_update')).toEqual([
      { type: 'lifecycle.scopes_updated', scopes: ['read_products', 'read_inventory'] },
    ]);
    expect(norm('bulk_operations/finish')).toEqual([
      { type: 'catalog.export_finished', exportId: 'gid://shopify/BulkOperation/9001' },
    ]);
    expect(norm('app_subscriptions/update')).toEqual([{ type: 'billing.subscription_changed' }]);
    expect(norm('customers/data_request')).toEqual([
      { type: 'privacy.customer_data_request', requestRef: '42', customerRef: '777' },
    ]);
    expect(norm('customers/redact')).toEqual([
      { type: 'privacy.customer_redact', customerRef: '777' },
    ]);
    expect(norm('shop/redact')).toEqual([{ type: 'privacy.shop_redact' }]);
    expect(norm('orders/create')[0]?.type).toBe('ignored');
  });

  it('ignores untracked inventory levels instead of inventing quantities', () => {
    const r = normalizeShopifyWebhook({
      platform: 'shopify',
      topic: 'inventory_levels/update',
      storeIdentity: SHOP,
      payload: { inventory_item_id: 1, location_id: 2, available: null, updated_at: 'x' },
    });
    expect(r[0]?.type).toBe('ignored');
  });
});

describe('token exchange and refresh', () => {
  it('sends the documented token-exchange grant and parses expiring tokens', async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({
        access_token: 'shpat_synthetic',
        scope: 'read_products,read_inventory',
        expires_in: 3600,
        refresh_token: 'shprt_synthetic',
        refresh_token_expires_in: 7776000,
      }),
    );
    const before = Date.now();
    const tokens = await exchangeSessionToken(config, SHOP, 'session.jwt.token', {
      fetch: fetchMock,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://${SHOP}/admin/oauth/access_token`);
    expect(JSON.parse(String(init.body))).toEqual({
      client_id: 'test-api-key',
      client_secret: 'test-api-secret',
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'session.jwt.token',
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
      expiring: '1',
    });
    expect(tokens.scopes).toEqual(['read_products', 'read_inventory']);
    expect(tokens.accessTokenExpiresAt!.getTime()).toBeGreaterThanOrEqual(before + 3600_000);
    expect(tokens.refreshToken).toBe('shprt_synthetic');
  });

  it('refresh uses the refresh_token grant; a rejected grant is auth_revoked', async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ error: 'invalid_grant' }, 400));
    await expect(
      refreshOfflineToken(config, SHOP, 'shprt_x', { fetch: fetchMock }),
    ).rejects.toMatchObject({ error: { code: 'auth_revoked' } });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'shprt_x',
    });
  });

  it('refuses non-Shopify hosts (SSRF) and open transactions during remote calls', async () => {
    await expect(exchangeSessionToken(config, 'evil.com', 't', { fetch: vi.fn() })).rejects.toThrow(
      /Invalid shop domain/,
    );
    await expect(
      runInTransactionScope('test', () =>
        exchangeSessionToken(config, SHOP, 't', {
          fetch: vi.fn<FetchLike>(async () => jsonResponse({})),
        }),
      ),
    ).rejects.toBeInstanceOf(TransactionHeldDuringExternalCallError);
  });
});

describe('Admin GraphQL client', () => {
  const budget = (): RateBudget & { observed: number[]; blocked: number[] } => {
    const b = {
      observed: [] as number[],
      blocked: [] as number[],
      async tryAcquire() {
        return 0;
      },
      async observe(_k: unknown, available: number) {
        b.observed.push(available);
      },
      async block(_k: unknown, ms: number) {
        b.blocked.push(ms);
      },
    };
    return b;
  };

  it('pins the API version and syncs the budget from throttleStatus', async () => {
    const b = budget();
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({
        data: { shop: { id: 'gid://shopify/Shop/1' } },
        extensions: {
          cost: {
            requestedQueryCost: 1,
            actualQueryCost: 1,
            throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1999, restoreRate: 100 },
          },
        },
      }),
    );
    const c = new ShopifyGraphqlClient({
      shop: SHOP,
      apiVersion: '2026-10',
      accessToken: async () => 'shpat_x',
      budget: b,
      fetch: fetchMock,
    });
    await c.request('{ shop { id } }');
    expect(fetchMock.mock.calls[0]![0]).toBe(`https://${SHOP}/admin/api/2026-10/graphql.json`);
    expect(
      (fetchMock.mock.calls[0]![1].headers as Record<string, string>)['x-shopify-access-token'],
    ).toBe('shpat_x');
    expect(b.observed).toEqual([1999]);
  });

  it('classifies THROTTLED, 429, 401 and 5xx responses', async () => {
    const run = async (res: Response) => {
      const c = new ShopifyGraphqlClient({
        shop: SHOP,
        apiVersion: '2026-10',
        accessToken: async () => 't',
        budget: budget(),
        fetch: async () => res,
      });
      try {
        await c.request('{ shop { id } }');
      } catch (e) {
        return (e as ProviderFailure).error;
      }
      throw new Error('expected failure');
    };
    expect(
      await run(
        jsonResponse({
          errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
          extensions: {
            cost: {
              requestedQueryCost: 500,
              throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 100, restoreRate: 50 },
            },
          },
        }),
      ),
    ).toMatchObject({ code: 'rate_limited', retryAfterMs: 8000 });
    expect(await run(jsonResponse({}, 429, { 'retry-after': '3' }))).toMatchObject({
      code: 'rate_limited',
      retryAfterMs: 3000,
    });
    expect(await run(jsonResponse({}, 401))).toMatchObject({ code: 'auth_expired' });
    expect(await run(jsonResponse({}, 503))).toMatchObject({ code: 'transient' });
    expect(
      await run(
        jsonResponse({
          errors: [{ message: 'Access denied', extensions: { code: 'ACCESS_DENIED' } }],
        }),
      ),
    ).toMatchObject({ code: 'forbidden' });
  });
});

describe('bulk catalog export reading (synthetic JSONL)', () => {
  const files: Record<string, string> = {
    'https://storage.example.com/products.jsonl': readFileSync(
      join(here, 'fixtures', 'products.jsonl'),
      'utf8',
    ),
    'https://storage.example.com/inventory.jsonl': readFileSync(
      join(here, 'fixtures', 'inventory.jsonl'),
      'utf8',
    ),
  };
  const adapter = new ShopifyAdapter({
    config,
    session: async () => ({ shop: SHOP, accessToken: async () => 't', currency: 'EUR' }),
    fetch: async (url) => new Response(files[url] ?? '', { status: files[url] ? 200 : 404 }),
  });
  const ctx = { tenantId: 't', systemId: 's', correlationId: 'c' };

  async function collect(kind: 'products' | 'inventory', from: number) {
    const out: { index: number; kinds: string[] }[] = [];
    const recs = [];
    for await (const b of adapter.readCatalogExport(
      ctx,
      { kind, exportId: 'x' },
      `https://storage.example.com/${kind}.jsonl`,
      from,
    )) {
      out.push({ index: b.index, kinds: b.records.map((r) => r.kind) });
      recs.push(...b.records);
    }
    return { out, recs };
  }

  it('maps products and variants with integer minor-unit prices', async () => {
    const { recs } = await collect('products', 0);
    expect(recs.filter((r) => r.kind === 'product')).toHaveLength(2);
    const variant = recs.find(
      (r) => r.kind === 'variant' && r.externalId === 'gid://shopify/ProductVariant/2001',
    );
    expect(variant).toMatchObject({
      productExternalId: 'gid://shopify/Product/1001',
      inventoryItemExternalId: 'gid://shopify/InventoryItem/3001',
      sku: 'TEE-S',
      price: { amountMinor: 1999n, currency: 'EUR' },
      compareAtPrice: { amountMinor: 2499n, currency: 'EUR' },
      optionValues: { Size: 'S' },
    });
    const mug = recs.find(
      (r) => r.kind === 'variant' && r.externalId === 'gid://shopify/ProductVariant/2003',
    );
    expect(mug).toMatchObject({ inventoryTracked: false, price: { amountMinor: 800n } });
    const product = recs.find((r) => r.kind === 'product');
    expect(product).toMatchObject({
      status: 'active',
      extensions: { shopify: { options: [{ name: 'Size', values: ['S', 'M'] }] } },
    });
  });

  it('resumes from a checkpointed line offset', async () => {
    const { out } = await collect('products', 3);
    expect(out.map((o) => o.index)).toEqual([3, 4]);
  });

  it('maps inventory levels (available quantity only)', async () => {
    const { recs } = await collect('inventory', 0);
    expect(recs).toEqual([
      {
        kind: 'inventory_level',
        inventoryItemExternalId: 'gid://shopify/InventoryItem/3001',
        locationExternalId: 'gid://shopify/Location/5001',
        available: 12,
        sourceUpdatedAt: '2026-10-03T09:00:00Z',
      },
      {
        kind: 'inventory_level',
        inventoryItemExternalId: 'gid://shopify/InventoryItem/3001',
        locationExternalId: 'gid://shopify/Location/5002',
        available: 0,
        sourceUpdatedAt: '2026-10-03T09:00:00Z',
      },
      {
        kind: 'inventory_level',
        inventoryItemExternalId: 'gid://shopify/InventoryItem/3002',
        locationExternalId: 'gid://shopify/Location/5001',
        available: 5,
        sourceUpdatedAt: '2026-10-03T09:00:00Z',
      },
    ]);
  });

  it('reports Wave 1 operations as explicitly unsupported', async () => {
    expect(await adapter.createOrder()).toMatchObject({
      status: 'unsupported',
      operation: 'order_create',
    });
    expect(await adapter.setInventory()).toMatchObject({
      status: 'unsupported',
      operation: 'inventory_write',
    });
    expect(adapter.supports('order_create')).toBe(false);
    expect(adapter.supports('catalog_read')).toBe(true);
  });
});
