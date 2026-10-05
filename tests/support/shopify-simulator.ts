/**
 * SHOPIFY SIMULATOR — test/benchmark double, NOT the real Shopify API.
 *
 * Implements only the endpoints SellRelay Wave 0 calls, shaped per the official library source and
 * the documented GraphQL fields we query. Results obtained with it are "verified against mocks
 * only" and must never be reported as sandbox or production verification.
 */
import { createHmac } from 'node:crypto';
import { SignJWT } from 'jose';
import type { FetchLike } from '../../packages/platforms/shopify/src/index.ts';

export interface SimVariant {
  id: number;
  sku: string;
  price: string;
  title: string;
  inventoryItemId: number;
  updatedAt: string;
}
export interface SimProduct {
  id: number;
  title: string;
  status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
  updatedAt: string;
  variants: SimVariant[];
}
export interface SimShop {
  domain: string;
  name: string;
  currency: string;
  products: Map<number, SimProduct>;
  locations: { id: number; name: string }[];
  /** inventoryItemId → locationId → available */
  levels: Map<number, Map<number, number>>;
  levelUpdatedAt: string;
  subscriptions: {
    id: string;
    name: string;
    status: string;
    test: boolean;
    planHandle: string | null;
  }[];
  revoked: boolean;
}

interface Token {
  shop: string;
  expiresAt: number;
}

export class ShopifySimulator {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly shops = new Map<string, SimShop>();
  private readonly tokens = new Map<string, Token>();
  private readonly refreshTokens = new Map<string, string>();
  private readonly bulk = new Map<
    string,
    { shop: string; kind: 'products' | 'inventory'; polls: number; body?: string }
  >();
  private seq = 0;
  accessTokenTtlSeconds = 3600;
  bulkPollsUntilComplete = 1;
  readonly calls = { tokenExchange: 0, refresh: 0, graphql: 0, bulkDownloads: 0 };

  constructor(apiKey = 'sim-api-key', apiSecret = 'sim-api-secret-0123456789') {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }

  addShop(
    domain: string,
    opts: {
      products?: number;
      variantsPerProduct?: number;
      locations?: number;
      currency?: string;
    } = {},
  ): SimShop {
    const shop: SimShop = {
      domain,
      name: `Synthetic ${domain.split('.')[0]}`,
      currency: opts.currency ?? 'EUR',
      products: new Map(),
      locations: Array.from({ length: opts.locations ?? 2 }, (_, i) => ({
        id: 5000 + i,
        name: `Synthetic Location ${i + 1}`,
      })),
      levels: new Map(),
      levelUpdatedAt: '2026-10-01T00:00:00Z',
      subscriptions: [],
      revoked: false,
    };
    const vpp = opts.variantsPerProduct ?? 2;
    for (let p = 0; p < (opts.products ?? 3); p++) {
      const pid = 1_000_000 + p;
      const variants: SimVariant[] = [];
      for (let v = 0; v < vpp; v++) {
        const vid = pid * 100 + v;
        variants.push({
          id: vid,
          sku: `SKU-${pid}-${v}`,
          price: `${10 + (v % 5)}.99`,
          title: `Variant ${v}`,
          inventoryItemId: vid + 7,
          updatedAt: '2026-10-01T00:00:00Z',
        });
        shop.levels.set(vid + 7, new Map(shop.locations.map((l, i) => [l.id, (v + i) % 20])));
      }
      shop.products.set(pid, {
        id: pid,
        title: `Synthetic Product ${p}`,
        status: 'ACTIVE',
        updatedAt: '2026-10-01T00:00:00Z',
        variants,
      });
    }
    this.shops.set(domain, shop);
    return shop;
  }

  async sessionToken(
    shop: string,
    userId = '1001',
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      iss: `https://${shop}/admin`,
      dest: `https://${shop}`,
      aud: this.apiKey,
      sub: userId,
      sid: `sid-${userId}`,
      jti: `jti-${++this.seq}`,
      ...overrides,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(now)
      .setNotBefore(now - 1)
      .setExpirationTime(now + 60)
      .sign(new TextEncoder().encode(this.apiSecret));
  }

  webhook(
    shop: string,
    topic: string,
    payload: unknown,
    opts: { eventId?: string; secret?: string } = {},
  ) {
    const rawBody = Buffer.from(JSON.stringify(payload));
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-shopify-topic': topic,
      'x-shopify-shop-domain': shop,
      'x-shopify-api-version': '2026-10',
      'x-shopify-webhook-id': `delivery-${++this.seq}`,
      'x-shopify-event-id': opts.eventId ?? `event-${this.seq}`,
      'x-shopify-triggered-at': new Date().toISOString(),
      'x-shopify-hmac-sha256': createHmac('sha256', opts.secret ?? this.apiSecret)
        .update(rawBody)
        .digest('base64'),
    };
    return { headers, rawBody };
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  private issue(shop: string) {
    const access = `shpat_sim_${++this.seq}`;
    const refresh = `shprt_sim_${this.seq}`;
    this.tokens.set(access, { shop, expiresAt: Date.now() + this.accessTokenTtlSeconds * 1000 });
    this.refreshTokens.set(refresh, shop);
    return {
      access_token: access,
      scope: 'read_products,read_inventory,read_locations',
      expires_in: this.accessTokenTtlSeconds,
      refresh_token: refresh,
      refresh_token_expires_in: 7_776_000,
    };
  }

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    if (url.hostname === 'sim-storage.example.com') {
      this.calls.bulkDownloads++;
      const op = this.bulk.get(url.pathname.slice(1).replace('.jsonl', ''));
      return op?.body !== undefined
        ? new Response(op.body)
        : new Response('expired', { status: 403 });
    }
    const shop = this.shops.get(url.hostname);
    if (!shop) return this.json({ errors: 'Not Found' }, 404);
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (url.pathname === '/admin/oauth/access_token') {
      if (body.client_id !== this.apiKey || body.client_secret !== this.apiSecret || shop.revoked)
        return this.json({ error: 'invalid_client' }, 400);
      if (body.grant_type === 'urn:ietf:params:oauth:grant-type:token-exchange') {
        this.calls.tokenExchange++;
        return this.json(this.issue(shop.domain));
      }
      if (body.grant_type === 'refresh_token') {
        this.calls.refresh++;
        if (this.refreshTokens.get(body.refresh_token) !== shop.domain)
          return this.json({ error: 'invalid_grant' }, 400);
        this.refreshTokens.delete(body.refresh_token);
        return this.json(this.issue(shop.domain));
      }
      return this.json({ error: 'unsupported_grant_type' }, 400);
    }
    if (url.pathname === '/admin/api/2026-10/graphql.json') {
      this.calls.graphql++;
      const token = this.tokens.get(
        (init.headers as Record<string, string>)['x-shopify-access-token'] ?? '',
      );
      if (!token || token.shop !== shop.domain || token.expiresAt < Date.now() || shop.revoked)
        return this.json({ errors: '[API] Invalid API key or access token' }, 401);
      return this.json({
        data: this.graphql(shop, String(body.query), body.variables ?? {}),
        extensions: {
          cost: {
            requestedQueryCost: 10,
            actualQueryCost: 5,
            throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1990, restoreRate: 100 },
          },
        },
      });
    }
    return this.json({ errors: 'Not Found' }, 404);
  };

  private gid = (type: string, id: number) => `gid://shopify/${type}/${id}`;
  private num = (gid: string) => Number(gid.split('/').pop());

  private productNode(shop: SimShop, p: SimProduct) {
    return {
      id: this.gid('Product', p.id),
      title: p.title,
      handle: `synthetic-${p.id}`,
      vendor: 'Synthetic Vendor',
      productType: 'Synthetic',
      status: p.status,
      tags: ['synthetic'],
      descriptionHtml: '<p>Synthetic product</p>',
      updatedAt: p.updatedAt,
      options: [{ name: 'Variant', optionValues: p.variants.map((v) => ({ name: v.title })) }],
      _shop: shop.domain,
    };
  }

  private variantNode(v: SimVariant) {
    return {
      id: this.gid('ProductVariant', v.id),
      title: v.title,
      sku: v.sku,
      barcode: null,
      price: v.price,
      compareAtPrice: null,
      updatedAt: v.updatedAt,
      selectedOptions: [{ name: 'Variant', value: v.title }],
      inventoryItem: { id: this.gid('InventoryItem', v.inventoryItemId), tracked: true },
    };
  }

  private levelNode(shop: SimShop, itemId: number, locationId: number, available: number) {
    return {
      id: `gid://shopify/InventoryLevel/${itemId}${locationId}?inventory_item_id=${itemId}`,
      updatedAt: shop.levelUpdatedAt,
      location: { id: this.gid('Location', locationId) },
      quantities: [{ name: 'available', quantity: available }],
    };
  }

  /** Build the JSONL result exactly like a bulk query: parents followed by children with __parentId. */
  buildJsonl(shop: SimShop, kind: 'products' | 'inventory'): string {
    const lines: string[] = [];
    if (kind === 'products') {
      for (const p of shop.products.values()) {
        const { _shop: _ignored, ...node } = this.productNode(shop, p);
        lines.push(JSON.stringify(node));
        for (const v of p.variants)
          lines.push(JSON.stringify({ ...this.variantNode(v), __parentId: node.id }));
      }
    } else {
      for (const [itemId, locs] of shop.levels) {
        const itemGid = this.gid('InventoryItem', itemId);
        lines.push(JSON.stringify({ id: itemGid, updatedAt: shop.levelUpdatedAt }));
        for (const [locId, qty] of locs)
          lines.push(
            JSON.stringify({ ...this.levelNode(shop, itemId, locId, qty), __parentId: itemGid }),
          );
      }
    }
    return lines.join('\n') + '\n';
  }

  private graphql(shop: SimShop, query: string, vars: Record<string, unknown>): unknown {
    if (query.includes('bulkOperationRunQuery')) {
      const kind = String(vars['query']).includes('inventoryItems') ? 'inventory' : 'products';
      const id = `bulk-${++this.seq}`;
      this.bulk.set(id, { shop: shop.domain, kind, polls: 0 });
      return {
        bulkOperationRunQuery: {
          bulkOperation: { id: `gid://shopify/BulkOperation/${id}`, status: 'CREATED' },
          userErrors: [],
        },
      };
    }
    if (query.includes('query BulkStatus')) {
      const id = String(vars['id']).split('/').pop()!;
      const op = this.bulk.get(id);
      if (!op) return { node: null };
      if (op.polls++ < this.bulkPollsUntilComplete)
        return {
          node: {
            id: vars['id'],
            status: 'RUNNING',
            errorCode: null,
            objectCount: '0',
            url: null,
            partialDataUrl: null,
          },
        };
      op.body ??= this.buildJsonl(this.shops.get(op.shop)!, op.kind);
      return {
        node: {
          id: vars['id'],
          status: 'COMPLETED',
          errorCode: null,
          objectCount: String(op.body.split('\n').length - 1),
          url: `https://sim-storage.example.com/${id}.jsonl`,
          partialDataUrl: null,
        },
      };
    }
    if (query.includes('query Product(')) {
      const p = shop.products.get(this.num(String(vars['id'])));
      if (!p) return { product: null };
      const { _shop: _ignored, ...node } = this.productNode(shop, p);
      return {
        product: {
          ...node,
          variants: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: p.variants.map((v) => this.variantNode(v)),
          },
        },
      };
    }
    if (query.includes('query Locations')) {
      return {
        locations: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: shop.locations.map((l) => ({
            id: this.gid('Location', l.id),
            name: l.name,
            isActive: true,
            address: { countryCode: 'DE' },
          })),
        },
      };
    }
    if (query.includes('query Shop'))
      return {
        shop: {
          id: 'gid://shopify/Shop/1',
          name: shop.name,
          currencyCode: shop.currency,
          myshopifyDomain: shop.domain,
        },
      };
    if (query.includes('query ActiveSubscriptions')) {
      return {
        currentAppInstallation: {
          activeSubscriptions: shop.subscriptions.map((s) => ({
            id: s.id,
            name: s.name,
            status: s.status,
            test: s.test,
            currentPeriodEnd: null,
            lineItems: [
              {
                plan: {
                  pricingDetails: {
                    __typename: 'AppRecurringPricing',
                    planHandle: s.planHandle,
                    interval: 'EVERY_30_DAYS',
                    price: { amount: '29.0', currencyCode: 'USD' },
                  },
                },
              },
            ],
          })),
        },
      };
    }
    if (query.includes('query InventoryItems')) {
      return {
        nodes: (vars['ids'] as string[]).map((gid) => {
          const itemId = this.num(gid);
          const locs = shop.levels.get(itemId);
          if (!locs) return null;
          return {
            id: gid,
            inventoryLevels: {
              nodes: [...locs].map(([l, q]) => this.levelNode(shop, itemId, l, q)),
            },
          };
        }),
      };
    }
    throw new Error(`Simulator: unhandled query ${query.slice(0, 60)}`);
  }
}
