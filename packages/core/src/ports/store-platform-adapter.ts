import type { Location } from '../models/inventory.ts';
import type { Fulfillment, Order } from '../models/order.ts';
import type { Extensions, LocalizedText } from '../models/extensions.ts';
import type { ProductStatus } from '../models/product.ts';
import type { Money } from '../money.ts';
import type { StorePlatformOperation } from '../capabilities/types.ts';
import type { IntegrationContext, OperationOutcome } from './common.ts';

/** Raw inbound webhook exactly as received. `rawBody` MUST be the unparsed bytes. */
export interface RawWebhookRequest {
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly rawBody: Buffer;
}

export interface VerifiedWebhook {
  readonly platform: string;
  readonly topic: string;
  /** External store identity (e.g. Shopify shop domain). Used only to look up the installation. */
  readonly storeIdentity: string;
  readonly providerEventId?: string;
  readonly providerDeliveryId?: string;
  readonly apiVersion?: string;
  readonly triggeredAt?: string;
  readonly payload: unknown;
}

export type WebhookVerificationFailure = 'missing_headers' | 'invalid_signature' | 'invalid_body';

/** Store-native catalog records emitted by catalog exports, already mapped to canonical shape. */
export interface CatalogProductRecord {
  readonly kind: 'product';
  readonly externalId: string;
  readonly title: LocalizedText;
  readonly descriptionHtml?: LocalizedText;
  readonly handle?: string;
  readonly vendor?: string;
  readonly productType?: string;
  readonly status: ProductStatus;
  readonly tags: readonly string[];
  readonly extensions: Extensions;
  readonly sourceUpdatedAt: string;
}

export interface CatalogVariantRecord {
  readonly kind: 'variant';
  readonly externalId: string;
  readonly productExternalId: string;
  readonly inventoryItemExternalId?: string;
  readonly sku?: string;
  readonly barcode?: string;
  readonly title: string;
  readonly price: Money;
  readonly compareAtPrice?: Money;
  readonly inventoryTracked: boolean;
  readonly optionValues: Readonly<Record<string, string>>;
  readonly extensions: Extensions;
  readonly sourceUpdatedAt: string;
}

export interface CatalogInventoryLevelRecord {
  readonly kind: 'inventory_level';
  readonly inventoryItemExternalId: string;
  readonly locationExternalId: string;
  readonly available: number;
  readonly sourceUpdatedAt: string;
}

export type CatalogRecord =
  CatalogProductRecord | CatalogVariantRecord | CatalogInventoryLevelRecord;

export type CatalogExportKind = 'products' | 'inventory';

export interface CatalogExportHandle {
  readonly kind: CatalogExportKind;
  readonly exportId: string;
}

export type CatalogExportStatus =
  | { readonly state: 'running'; readonly objectCount?: number }
  | {
      readonly state: 'completed';
      readonly downloadUrl: string | null;
      readonly objectCount?: number;
    }
  | {
      readonly state: 'failed';
      readonly reason: string;
      readonly partialDownloadUrl?: string | null;
    };

export interface LocationRecord extends Omit<Location, 'id' | 'tenantId' | 'storeId'> {
  readonly externalId: string;
}

/** Normalized webhook effect: canonical change or a request to re-fetch from the source. */
export type NormalizedStoreEvent =
  | {
      readonly type: 'product.refresh_requested';
      readonly productExternalId: string;
      readonly sourceUpdatedAt?: string;
    }
  | { readonly type: 'product.deleted'; readonly productExternalId: string }
  | { readonly type: 'inventory.level_reported'; readonly level: CatalogInventoryLevelRecord }
  | { readonly type: 'location.changed'; readonly locationExternalId: string }
  | { readonly type: 'lifecycle.uninstalled' }
  | { readonly type: 'lifecycle.scopes_updated'; readonly scopes: readonly string[] }
  | { readonly type: 'catalog.export_finished'; readonly exportId: string }
  | { readonly type: 'billing.subscription_changed' }
  | {
      readonly type: 'privacy.customer_data_request';
      readonly requestRef: string;
      readonly customerRef?: string;
    }
  | { readonly type: 'privacy.customer_redact'; readonly customerRef?: string }
  | { readonly type: 'privacy.shop_redact' }
  | { readonly type: 'ignored'; readonly reason: string };

/**
 * Store platform adapter port. Each host implements the operations it supports; anything
 * else returns an explicit `Unsupported` result (never a silent no-op).
 */
export interface StorePlatformAdapter {
  readonly platform: string;
  supports(op: StorePlatformOperation): boolean;

  verifyWebhook(
    req: RawWebhookRequest,
  ): { ok: true; webhook: VerifiedWebhook } | { ok: false; reason: WebhookVerificationFailure };
  normalizeWebhook(webhook: VerifiedWebhook): readonly NormalizedStoreEvent[];

  startCatalogExport(
    ctx: IntegrationContext,
    kind: CatalogExportKind,
  ): Promise<OperationOutcome<CatalogExportHandle>>;
  getCatalogExportStatus(
    ctx: IntegrationContext,
    handle: CatalogExportHandle,
  ): Promise<OperationOutcome<CatalogExportStatus>>;
  /** Streams records, skipping the first `fromRecord` lines so imports can resume from checkpoints. */
  readCatalogExport(
    ctx: IntegrationContext,
    handle: CatalogExportHandle,
    downloadUrl: string,
    fromRecord: number,
  ): AsyncIterable<{ readonly index: number; readonly records: readonly CatalogRecord[] }>;
  fetchProduct(
    ctx: IntegrationContext,
    productExternalId: string,
  ): Promise<
    OperationOutcome<{
      product: CatalogProductRecord;
      variants: readonly CatalogVariantRecord[];
    } | null>
  >;
  listLocations(ctx: IntegrationContext): Promise<OperationOutcome<readonly LocationRecord[]>>;

  readTranslations(
    ctx: IntegrationContext,
    productExternalId: string,
  ): Promise<OperationOutcome<Readonly<Record<string, LocalizedText>>>>;
  setInventory(
    ctx: IntegrationContext,
    inventoryItemExternalId: string,
    locationExternalId: string,
    available: number,
    idempotencyKey: string,
  ): Promise<OperationOutcome<void>>;
  createOrder(
    ctx: IntegrationContext,
    order: Order,
    idempotencyKey: string,
  ): Promise<OperationOutcome<{ externalOrderId: string }>>;
  createFulfillment(
    ctx: IntegrationContext,
    fulfillment: Fulfillment,
    idempotencyKey: string,
  ): Promise<OperationOutcome<{ externalFulfillmentId: string }>>;
}
