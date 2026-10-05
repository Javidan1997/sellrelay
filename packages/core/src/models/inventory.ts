import type { LocationId, StoreId, TenantId, VariantId } from '../ids.ts';

export interface Location {
  readonly id: LocationId;
  readonly tenantId: TenantId;
  readonly storeId: StoreId;
  readonly name: string;
  readonly active: boolean;
  readonly countryCode?: string;
}

export interface InventoryLevel {
  readonly tenantId: TenantId;
  readonly variantId: VariantId;
  readonly locationId: LocationId;
  /** Quantity available for sale at the location as reported by the authoritative source. */
  readonly available: number;
  readonly sourceUpdatedAt: string;
}
