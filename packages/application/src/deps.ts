import type pg from 'pg';
import type { Redis } from 'ioredis';
import type { RateBudget } from '@sellrelay/core';
import type { Logger, Metrics } from '@sellrelay/observability';
import type { Tx } from '@sellrelay/persistence';
import type { FetchLike, ShopifyAppConfig } from '@sellrelay/platform-shopify';
import type { SecretBox } from '@sellrelay/security';

/** Process-wide dependencies. `pool` is the role-specific pool of the running service. */
export interface AppDeps {
  readonly pool: pg.Pool;
  readonly secretBox: SecretBox;
  readonly redis: Redis;
  readonly budget: RateBudget;
  readonly shopify: ShopifyAppConfig;
  readonly log: Logger;
  readonly metrics?: Metrics;
  readonly fetch?: FetchLike;
  /** Key for pseudonymizing personal identifiers in privacy audit records. */
  readonly privacyHashKey: string;
}

/** A unit of work bound to one tenant (provided by API requests or worker jobs). */
export interface TenantScope {
  readonly tenantId: string;
  readonly correlationId: string;
  readonly signal?: AbortSignal;
  readonly jobId?: string;
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export const JobKinds = {
  webhookProcess: 'shopify.webhook.process',
  catalogImport: 'shopify.catalog.import',
  productRefresh: 'shopify.product.refresh',
  locationsSync: 'shopify.locations.sync',
  shopProfileSync: 'shopify.shop.profile_sync',
  credentialsRefresh: 'shopify.credentials.refresh',
  billingVerify: 'billing.verify',
  inventoryReconcile: 'inventory.reconcile',
} as const;
