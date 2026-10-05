import { FREE_PLAN, type PlanDefinition } from '@sellrelay/core';

/**
 * Server-side plan catalog keyed by provider plan handle. Handles must match the plans configured
 * in the Shopify Partner Dashboard (Shopify App Pricing). Unknown handles grant nothing extra.
 * NOTE: plan handles/prices are placeholders until the merchant-facing pricing is decided.
 */
export const PLAN_CATALOG: Readonly<Record<string, PlanDefinition>> = {
  free: FREE_PLAN,
  starter: {
    key: 'starter',
    features: ['catalog_import', 'inventory_sync', 'channel_connections'],
    limits: { maxSkus: 10_000, maxChannelConnections: 1 },
  },
  growth: {
    key: 'growth',
    features: ['catalog_import', 'inventory_sync', 'channel_connections', 'order_import'],
    limits: { maxSkus: 50_000, maxChannelConnections: 3 },
  },
  scale: {
    key: 'scale',
    features: [
      'catalog_import',
      'inventory_sync',
      'channel_connections',
      'order_import',
      'crm_sync',
    ],
    limits: { maxSkus: 100_000, maxChannelConnections: 10 },
  },
};

export function planForHandle(handle: string | null | undefined): PlanDefinition | null {
  if (!handle) return null;
  return PLAN_CATALOG[handle] ?? null;
}
