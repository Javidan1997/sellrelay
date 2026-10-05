import type { Entitlements } from '@sellrelay/core';

export interface BillingSubject {
  readonly tenantId: string;
  readonly installationId: string;
  /** Host-specific identity, e.g. Shopify shop domain. */
  readonly accountRef: string;
}

export type UsageReportResult =
  | { readonly status: 'reported' }
  | { readonly status: 'blocked'; readonly reason: string }
  | { readonly status: 'failed'; readonly reason: string; readonly retryable: boolean };

/**
 * Billing provider port. Business rules consume only the neutral `Entitlements` it returns.
 * Implementations MUST verify server-side with the provider; client-supplied plan names or
 * billing redirect parameters are never proof of entitlement.
 */
export interface BillingProvider {
  readonly key: string;
  verifyEntitlements(subject: BillingSubject, signal?: AbortSignal): Promise<Entitlements>;
  /** Where the merchant manages their plan (host-rendered page), if the provider hosts one. */
  planManagementUrl(subject: BillingSubject): string | null;
  reportUsage(
    subject: BillingSubject,
    meter: string,
    quantity: string,
    idempotencyKey: string,
  ): Promise<UsageReportResult>;
}
