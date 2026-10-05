export type IntegrationKind = 'store_platform' | 'marketplace' | 'crm';

/** Whether code exists for the integration at all. */
export type ImplementationStatus = 'planned' | 'implemented';

/** Strongest environment the implementation has been verified against. */
export type VerificationStatus =
  'none' | 'mock-only' | 'sandbox-verified' | 'test-account-verified';

/** Provider-side developer/partner/app-review approval. */
export type ApprovalStatus = 'not-required' | 'pending' | 'approved' | 'blocked';

/** Per-merchant connection state (stored per tenant, not in the registry). */
export type ConnectionState = 'disconnected' | 'connected' | 'expired' | 'error';

export type StorePlatformOperation =
  | 'install_auth'
  | 'catalog_read'
  | 'translations_read'
  | 'locations_read'
  | 'inventory_read'
  | 'inventory_write'
  | 'order_create'
  | 'fulfillment_write'
  | 'webhooks'
  | 'event_normalization'
  | 'billing';

export type MarketplaceOperation =
  | 'auth'
  | 'connection_test'
  | 'categories'
  | 'required_attributes'
  | 'listing_publish'
  | 'offers'
  | 'stock'
  | 'prices'
  | 'order_ingest'
  | 'tracking'
  | 'returns';

export type CrmOperation =
  | 'auth'
  | 'connection_test'
  | 'contact_upsert'
  | 'company_upsert'
  | 'deal_or_sales_order'
  | 'line_items'
  | 'pipeline_metadata';

export type OperationKey = StorePlatformOperation | MarketplaceOperation | CrmOperation;

export type OperationSupportStatus =
  /** Implemented in code for this integration. */
  | 'available'
  /** Will be implemented in a later wave. */
  | 'planned'
  /** The provider does not support it or it is out of scope. */
  | 'unsupported';

export interface OperationSupport {
  readonly status: OperationSupportStatus;
  readonly note?: string;
}

export interface IntegrationDescriptor<Op extends OperationKey = OperationKey> {
  readonly key: string;
  readonly kind: IntegrationKind;
  readonly displayName: string;
  readonly wave: string;
  readonly implementation: ImplementationStatus;
  readonly verification: VerificationStatus;
  readonly approval: ApprovalStatus;
  readonly approvalNote?: string;
  readonly regions: readonly string[];
  readonly regionalLimitations?: string;
  readonly operations: Readonly<Record<Op, OperationSupport>>;
}

/** Explicit typed result returned by adapters for operations they do not support. */
export interface Unsupported {
  readonly status: 'unsupported';
  readonly integration: string;
  readonly operation: OperationKey;
  readonly reason: string;
}

export const unsupported = (
  integration: string,
  operation: OperationKey,
  reason: string,
): Unsupported => ({
  status: 'unsupported',
  integration,
  operation,
  reason,
});
