import type { TenantId } from '../ids.ts';

export type CanonicalObjectType =
  | 'product'
  | 'variant'
  | 'offer'
  | 'inventory_item'
  | 'location'
  | 'order'
  | 'fulfillment'
  | 'customer'
  | 'company';

export type ExternalSystemKind = 'store' | 'channel' | 'crm';

/**
 * Maps a canonical object to its identifier in one external system.
 * Scoped by tenant AND system instance (store or connection) AND object type,
 * because the same external id may exist in different stores/accounts.
 */
export interface ExternalReference {
  readonly tenantId: TenantId;
  readonly systemKind: ExternalSystemKind;
  /** storeId or connectionId */
  readonly systemId: string;
  readonly objectType: CanonicalObjectType;
  readonly canonicalId: string;
  readonly externalId: string;
  /** Provider version marker (updated_at, etag, revision) used for stale-update rejection. */
  readonly externalVersion?: string;
}
