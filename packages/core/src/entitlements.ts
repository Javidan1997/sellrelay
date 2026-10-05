/**
 * Provider-neutral entitlements. Business rules depend only on these, never on
 * Shopify/Stripe objects or plan names supplied by clients.
 */
export type EntitlementStatus = 'active' | 'trial' | 'none' | 'frozen' | 'unknown';

export type Feature =
  'catalog_import' | 'inventory_sync' | 'channel_connections' | 'order_import' | 'crm_sync';

export interface Entitlements {
  readonly planKey: string;
  readonly status: EntitlementStatus;
  readonly features: readonly Feature[];
  readonly limits: { readonly maxSkus: number; readonly maxChannelConnections: number };
  readonly test: boolean;
  readonly verifiedAt: string | null;
  readonly source: string;
}

export interface PlanDefinition {
  readonly key: string;
  readonly features: readonly Feature[];
  readonly limits: { readonly maxSkus: number; readonly maxChannelConnections: number };
}

/** Features available without any verified paid subscription. */
export const FREE_PLAN: PlanDefinition = {
  key: 'free',
  features: ['catalog_import'],
  limits: { maxSkus: 1000, maxChannelConnections: 0 },
};

export const NO_ENTITLEMENTS: Entitlements = {
  planKey: 'none',
  status: 'unknown',
  features: [],
  limits: { maxSkus: 0, maxChannelConnections: 0 },
  test: false,
  verifiedAt: null,
  source: 'none',
};

/** Fail-closed check: unknown/frozen status grants nothing beyond what the plan lists while active. */
export function hasFeature(ent: Entitlements, feature: Feature): boolean {
  if (ent.status !== 'active' && ent.status !== 'trial') return false;
  return ent.features.includes(feature);
}

export function maxEntitlementAgeMs(): number {
  return 24 * 60 * 60 * 1000;
}

export function isStale(ent: Entitlements, now: Date): boolean {
  if (!ent.verifiedAt) return true;
  return now.getTime() - Date.parse(ent.verifiedAt) > maxEntitlementAgeMs();
}
