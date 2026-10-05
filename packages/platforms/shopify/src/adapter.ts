import {
  ProviderFailure,
  SHOPIFY,
  isOperationAvailable,
  outcomeFailed,
  outcomeOk,
  unsupported,
  type CatalogExportHandle,
  type CatalogExportKind,
  type CatalogExportStatus,
  type CatalogInventoryLevelRecord,
  type CatalogProductRecord,
  type CatalogRecord,
  type CatalogVariantRecord,
  type IntegrationContext,
  type LocationRecord,
  type NormalizedStoreEvent,
  type OperationOutcome,
  type RateBudget,
  type RawWebhookRequest,
  type StorePlatformAdapter,
  type StorePlatformOperation,
  type VerifiedWebhook,
  type WebhookVerificationFailure,
} from '@sellrelay/core';
import type { ShopifyAppConfig } from './config.ts';
import { ShopifyGraphqlClient } from './graphql.ts';
import type { FetchLike } from './http.ts';
import { readJsonlLines } from './jsonl.ts';
import { gidType, mapInventoryLevel, mapProduct, mapVariant } from './mapping.ts';
import {
  BULK_INVENTORY_QUERY,
  BULK_PRODUCTS_QUERY,
  BULK_STATUS_QUERY,
  INVENTORY_ITEMS_QUERY,
  LOCATIONS_QUERY,
  PRODUCT_QUERY,
  RUN_BULK_QUERY,
  SHOP_QUERY,
} from './queries.ts';
import { normalizeShopifyWebhook, verifyShopifyWebhook } from './webhooks.ts';

export interface ShopifySessionAccess {
  readonly shop: string;
  /** Returns a valid access token, refreshing if needed (implemented by the application layer). */
  readonly accessToken: () => Promise<string>;
  /** Shop currency for monetary parsing. */
  readonly currency: string;
}

export interface ShopifyAdapterDeps {
  readonly config: ShopifyAppConfig;
  readonly session: (ctx: IntegrationContext) => Promise<ShopifySessionAccess>;
  readonly budget?: RateBudget;
  readonly fetch?: FetchLike;
  readonly onRateLimitWait?: (ms: number) => void;
}

type Obj = Record<string, unknown>;

async function attempt<T>(fn: () => Promise<T>): Promise<OperationOutcome<T>> {
  try {
    return outcomeOk(await fn());
  } catch (e) {
    if (e instanceof ProviderFailure) return outcomeFailed(e.error);
    throw e;
  }
}

const WAVE1 = 'Planned for Wave 1; not available in Wave 0.';

export class ShopifyAdapter implements StorePlatformAdapter {
  readonly platform = 'shopify';
  private readonly deps: ShopifyAdapterDeps;

  constructor(deps: ShopifyAdapterDeps) {
    this.deps = deps;
  }

  supports(op: StorePlatformOperation): boolean {
    return isOperationAvailable(SHOPIFY, op);
  }

  async client(
    ctx: IntegrationContext,
  ): Promise<{ gql: ShopifyGraphqlClient; session: ShopifySessionAccess }> {
    const session = await this.deps.session(ctx);
    const gql = new ShopifyGraphqlClient({
      shop: session.shop,
      apiVersion: this.deps.config.apiVersion,
      accessToken: session.accessToken,
      ...(this.deps.budget ? { budget: this.deps.budget } : {}),
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      ...(this.deps.onRateLimitWait ? { onRateLimitWait: this.deps.onRateLimitWait } : {}),
    });
    return { gql, session };
  }

  verifyWebhook(
    req: RawWebhookRequest,
  ): { ok: true; webhook: VerifiedWebhook } | { ok: false; reason: WebhookVerificationFailure } {
    return verifyShopifyWebhook(req, this.deps.config.apiSecret);
  }

  normalizeWebhook(webhook: VerifiedWebhook): readonly NormalizedStoreEvent[] {
    return normalizeShopifyWebhook(webhook);
  }

  startCatalogExport(
    ctx: IntegrationContext,
    kind: CatalogExportKind,
  ): Promise<OperationOutcome<CatalogExportHandle>> {
    return attempt(async () => {
      const { gql } = await this.client(ctx);
      const data = await gql.request<{
        bulkOperationRunQuery: {
          bulkOperation: { id: string } | null;
          userErrors: { message: string; code?: string }[];
        };
      }>(
        RUN_BULK_QUERY,
        { query: kind === 'products' ? BULK_PRODUCTS_QUERY : BULK_INVENTORY_QUERY },
        ctx.signal ? { signal: ctx.signal } : {},
      );
      const r = data.bulkOperationRunQuery;
      if (r.userErrors.length || !r.bulkOperation) {
        const msg = r.userErrors.map((e) => e.message).join('; ');
        // Too many concurrent bulk operations is transient: retry later.
        const code = /already in progress|limit/i.test(msg) ? 'rate_limited' : 'permanent';
        throw new ProviderFailure({
          code,
          message: `bulkOperationRunQuery: ${msg}`,
          ...(code === 'rate_limited' ? { retryAfterMs: 30_000 } : {}),
        });
      }
      return { kind, exportId: r.bulkOperation.id };
    });
  }

  getCatalogExportStatus(
    ctx: IntegrationContext,
    handle: CatalogExportHandle,
  ): Promise<OperationOutcome<CatalogExportStatus>> {
    return attempt(async () => {
      const { gql } = await this.client(ctx);
      const data = await gql.request<{ node: Obj | null }>(
        BULK_STATUS_QUERY,
        { id: handle.exportId },
        ctx.signal ? { signal: ctx.signal } : {},
      );
      const n = data.node;
      if (!n)
        return {
          state: 'failed',
          reason: 'bulk operation not found',
        } satisfies CatalogExportStatus;
      const objectCount = n['objectCount'] !== undefined ? Number(n['objectCount']) : undefined;
      switch (n['status']) {
        case 'COMPLETED':
          return {
            state: 'completed',
            downloadUrl: (n['url'] as string | null) ?? null,
            ...(objectCount !== undefined ? { objectCount } : {}),
          };
        case 'CREATED':
        case 'RUNNING':
          return { state: 'running', ...(objectCount !== undefined ? { objectCount } : {}) };
        default:
          return {
            state: 'failed',
            reason: `${String(n['status'])}${n['errorCode'] ? `: ${String(n['errorCode'])}` : ''}`,
            partialDownloadUrl: (n['partialDataUrl'] as string | null) ?? null,
          };
      }
    });
  }

  async *readCatalogExport(
    ctx: IntegrationContext,
    handle: CatalogExportHandle,
    downloadUrl: string,
    fromRecord: number,
  ): AsyncIterable<{ readonly index: number; readonly records: readonly CatalogRecord[] }> {
    const session = handle.kind === 'products' ? await this.deps.session(ctx) : null;
    const lines = readJsonlLines(downloadUrl, fromRecord, {
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    for await (const { line, value } of lines) {
      const type = gidType(value['id']);
      const parent = typeof value['__parentId'] === 'string' ? value['__parentId'] : undefined;
      let records: CatalogRecord[] = [];
      if (handle.kind === 'products') {
        if (type === 'Product') records = [mapProduct(value)];
        else if (type === 'ProductVariant' && parent)
          records = [mapVariant(value, parent, session!.currency)];
      } else if (type === 'InventoryLevel' && parent) {
        const level = mapInventoryLevel(value, parent);
        if (level) records = [level];
      }
      yield { index: line, records };
    }
  }

  fetchProduct(
    ctx: IntegrationContext,
    productExternalId: string,
  ): Promise<
    OperationOutcome<{
      product: CatalogProductRecord;
      variants: readonly CatalogVariantRecord[];
    } | null>
  > {
    return attempt(async () => {
      const { gql, session } = await this.client(ctx);
      let after: string | null = null;
      let product: CatalogProductRecord | null = null;
      const variants: CatalogVariantRecord[] = [];
      do {
        const data: {
          product:
            | (Obj & {
                variants: {
                  nodes: Obj[];
                  pageInfo: { hasNextPage: boolean; endCursor: string | null };
                };
              })
            | null;
        } = await gql.request(
          PRODUCT_QUERY,
          { id: productExternalId, after },
          { ...(ctx.signal ? { signal: ctx.signal } : {}), estimatedCost: 60 },
        );
        if (!data.product) return null;
        product ??= mapProduct(data.product);
        variants.push(
          ...data.product.variants.nodes.map((v) =>
            mapVariant(v, productExternalId, session.currency),
          ),
        );
        after = data.product.variants.pageInfo.hasNextPage
          ? data.product.variants.pageInfo.endCursor
          : null;
      } while (after);
      return { product: product!, variants };
    });
  }

  listLocations(ctx: IntegrationContext): Promise<OperationOutcome<readonly LocationRecord[]>> {
    return attempt(async () => {
      const { gql } = await this.client(ctx);
      const out: LocationRecord[] = [];
      let after: string | null = null;
      do {
        const data: {
          locations: { nodes: Obj[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
        } = await gql.request(LOCATIONS_QUERY, { after }, ctx.signal ? { signal: ctx.signal } : {});
        for (const n of data.locations.nodes) {
          const country = ((n['address'] ?? {}) as Obj)['countryCode'];
          out.push({
            externalId: String(n['id']),
            name: String(n['name']),
            active: n['isActive'] !== false,
            ...(typeof country === 'string' ? { countryCode: country } : {}),
          });
        }
        after = data.locations.pageInfo.hasNextPage ? data.locations.pageInfo.endCursor : null;
      } while (after);
      return out;
    });
  }

  /** Shopify-specific: shop profile (name, currency). */
  fetchShopProfile(
    ctx: IntegrationContext,
  ): Promise<OperationOutcome<{ id: string; name: string; currency: string; domain: string }>> {
    return attempt(async () => {
      const { gql } = await this.client(ctx);
      const data = await gql.request<{
        shop: { id: string; name: string; currencyCode: string; myshopifyDomain: string };
      }>(SHOP_QUERY);
      return {
        id: data.shop.id,
        name: data.shop.name,
        currency: data.shop.currencyCode,
        domain: data.shop.myshopifyDomain,
      };
    });
  }

  /** Shopify-specific: current levels for a sample of inventory items (reconciliation). */
  fetchInventoryLevels(
    ctx: IntegrationContext,
    inventoryItemIds: readonly string[],
  ): Promise<OperationOutcome<CatalogInventoryLevelRecord[]>> {
    return attempt(async () => {
      const { gql } = await this.client(ctx);
      const data = await gql.request<{ nodes: (Obj | null)[] }>(
        INVENTORY_ITEMS_QUERY,
        { ids: inventoryItemIds },
        { estimatedCost: 5 * inventoryItemIds.length + 10 },
      );
      const out: CatalogInventoryLevelRecord[] = [];
      for (const item of data.nodes) {
        if (!item) continue;
        const levels = ((item['inventoryLevels'] ?? {}) as { nodes?: Obj[] }).nodes ?? [];
        for (const l of levels) {
          const rec = mapInventoryLevel(l, String(item['id']));
          if (rec) out.push(rec);
        }
      }
      return out;
    });
  }

  async readTranslations(): Promise<
    OperationOutcome<Readonly<Record<string, Record<string, string>>>>
  > {
    return unsupported('shopify', 'translations_read', WAVE1);
  }

  async setInventory(): Promise<OperationOutcome<void>> {
    return unsupported('shopify', 'inventory_write', WAVE1);
  }

  async createOrder(): Promise<OperationOutcome<{ externalOrderId: string }>> {
    return unsupported('shopify', 'order_create', WAVE1);
  }

  async createFulfillment(): Promise<OperationOutcome<{ externalFulfillmentId: string }>> {
    return unsupported('shopify', 'fulfillment_write', WAVE1);
  }
}
