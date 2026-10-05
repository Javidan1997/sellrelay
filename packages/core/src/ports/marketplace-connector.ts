import type { MarketplaceOperation } from '../capabilities/types.ts';
import type { Offer } from '../models/product.ts';
import type { Fulfillment, Order } from '../models/order.ts';
import type { IntegrationContext, OperationOutcome, Page } from './common.ts';

export interface MarketplaceCategory {
  readonly externalId: string;
  readonly name: string;
  readonly parentExternalId?: string;
  readonly leaf: boolean;
}

export interface RequiredAttribute {
  readonly key: string;
  readonly label: string;
  readonly type: 'string' | 'number' | 'boolean' | 'enum' | 'multi_enum' | 'measurement';
  readonly required: boolean;
  readonly allowedValues?: readonly string[];
}

export interface ListingPayload {
  readonly variantId: string;
  readonly categoryExternalId: string;
  readonly attributes: Readonly<Record<string, string | readonly string[]>>;
  readonly locale: string;
}

/** Marketplace connector port. Implementations arrive in their assigned waves. */
export interface MarketplaceConnector {
  readonly channel: string;
  supports(op: MarketplaceOperation): boolean;
  testConnection(ctx: IntegrationContext): Promise<OperationOutcome<{ accountName?: string }>>;
  listCategories(
    ctx: IntegrationContext,
    parentExternalId?: string,
  ): Promise<OperationOutcome<readonly MarketplaceCategory[]>>;
  requiredAttributes(
    ctx: IntegrationContext,
    categoryExternalId: string,
  ): Promise<OperationOutcome<readonly RequiredAttribute[]>>;
  publishListing(
    ctx: IntegrationContext,
    listing: ListingPayload,
    idempotencyKey: string,
  ): Promise<OperationOutcome<{ externalListingId: string }>>;
  upsertOffer(
    ctx: IntegrationContext,
    offer: Offer,
    idempotencyKey: string,
  ): Promise<OperationOutcome<{ externalOfferId: string }>>;
  updateStock(
    ctx: IntegrationContext,
    externalOfferId: string,
    quantity: number,
    version: string,
  ): Promise<OperationOutcome<void>>;
  updatePrice(
    ctx: IntegrationContext,
    externalOfferId: string,
    offer: Offer,
    version: string,
  ): Promise<OperationOutcome<void>>;
  fetchOrders(ctx: IntegrationContext, cursor?: string): Promise<OperationOutcome<Page<Order>>>;
  pushTracking(
    ctx: IntegrationContext,
    externalOrderId: string,
    fulfillment: Fulfillment,
    idempotencyKey: string,
  ): Promise<OperationOutcome<void>>;
  fetchReturns(
    ctx: IntegrationContext,
    cursor?: string,
  ): Promise<OperationOutcome<Page<{ externalReturnId: string; externalOrderId: string }>>>;
}
