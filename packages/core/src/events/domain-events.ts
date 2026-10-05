import type { JsonObject } from '../json.ts';

/**
 * Domain event envelope. Persisted to the transactional outbox in the same database
 * transaction as the state change that produced it. Delivery is at-least-once.
 */
export interface DomainEvent<
  TType extends string = string,
  TPayload extends JsonObject = JsonObject,
> {
  readonly id: string;
  readonly type: TType;
  readonly tenantId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  /** Monotonic per-aggregate version (source timestamp in ms or sequence) for stale checks. */
  readonly aggregateVersion: string;
  readonly occurredAt: string;
  readonly correlationId?: string;
  readonly payload: TPayload;
}

export type ProductUpserted = DomainEvent<
  'product.upserted',
  { storeId: string; productId: string; variantIds: string[] }
>;
export type ProductDeleted = DomainEvent<'product.deleted', { storeId: string; productId: string }>;
export type InventoryLevelChanged = DomainEvent<
  'inventory.level_changed',
  {
    storeId: string;
    variantId: string;
    locationId: string;
    available: number;
    previous: number | null;
  }
>;
export type LocationUpserted = DomainEvent<
  'location.upserted',
  { storeId: string; locationId: string }
>;
export type InstallationActivated = DomainEvent<
  'installation.activated',
  { storeId: string; installationId: string }
>;
export type InstallationUninstalled = DomainEvent<
  'installation.uninstalled',
  { storeId: string; installationId: string }
>;
export type CatalogImportCompleted = DomainEvent<
  'catalog.import_completed',
  { storeId: string; products: number; variants: number; inventoryLevels: number }
>;
export type EntitlementsChanged = DomainEvent<
  'billing.entitlements_changed',
  { plan: string; status: string }
>;

export type SellRelayDomainEvent =
  | ProductUpserted
  | ProductDeleted
  | InventoryLevelChanged
  | LocationUpserted
  | InstallationActivated
  | InstallationUninstalled
  | CatalogImportCompleted
  | EntitlementsChanged;

export type DomainEventType = SellRelayDomainEvent['type'];
