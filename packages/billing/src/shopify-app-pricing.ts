import { FREE_PLAN, ProviderFailure, type Entitlements } from '@sellrelay/core';
import {
  ACTIVE_SUBSCRIPTIONS_QUERY,
  shopHandle,
  type ShopifyGraphqlClient,
} from '@sellrelay/platform-shopify';
import { planForHandle } from './plans.ts';
import type { BillingProvider, BillingSubject, UsageReportResult } from './provider.ts';

interface ActiveSubscription {
  id: string;
  name: string;
  status: string;
  test: boolean;
  currentPeriodEnd: string | null;
  lineItems: { plan: { pricingDetails: { __typename: string; planHandle?: string | null } } }[];
}

/**
 * Shopify App Pricing entitlement verification.
 *
 * Verified server-side through the Admin API `currentAppInstallation.activeSubscriptions`.
 * Shopify's migration guidance also recommends the Partner API `activeSubscription` query; its
 * field schema could not be read in this environment (shopify.dev blocked), so that path is not
 * implemented and the result is fail-closed: an unverifiable paid plan grants only free features.
 *
 * This provider never creates subscriptions (no appSubscriptionCreate / billing.request): plans
 * are configured in the Partner Dashboard and selected on Shopify's hosted plan selection page.
 */
export class ShopifyAppPricingProvider implements BillingProvider {
  readonly key = 'shopify_app_pricing';
  private readonly client: (subject: BillingSubject) => Promise<ShopifyGraphqlClient>;
  private readonly appHandle: string;
  private readonly now: () => Date;

  constructor(opts: {
    client: (subject: BillingSubject) => Promise<ShopifyGraphqlClient>;
    appHandle: string;
    now?: () => Date;
  }) {
    this.client = opts.client;
    this.appHandle = opts.appHandle;
    this.now = opts.now ?? (() => new Date());
  }

  async verifyEntitlements(subject: BillingSubject, signal?: AbortSignal): Promise<Entitlements> {
    const gql = await this.client(subject);
    let subs: ActiveSubscription[];
    try {
      const data = await gql.request<{
        currentAppInstallation: { activeSubscriptions: ActiveSubscription[] };
      }>(ACTIVE_SUBSCRIPTIONS_QUERY, {}, signal ? { signal } : {});
      subs = data.currentAppInstallation.activeSubscriptions;
    } catch (e) {
      if (e instanceof ProviderFailure && e.error.code === 'permanent') {
        // Schema mismatch or similar: cannot verify → fail closed, but keep free features.
        return this.entitlements(FREE_PLAN.key, 'unknown', FREE_PLAN, false, null);
      }
      throw e;
    }
    return evaluateShopifySubscriptions(subs, this.now());
  }

  private entitlements(
    planKey: string,
    status: Entitlements['status'],
    plan: { features: readonly Entitlements['features'][number][]; limits: Entitlements['limits'] },
    test: boolean,
    subscriptionId: string | null,
  ): Entitlements {
    return {
      planKey,
      status,
      features: plan.features,
      limits: plan.limits,
      test,
      verifiedAt: this.now().toISOString(),
      source: subscriptionId ? `shopify:${subscriptionId}` : 'shopify:none',
    };
  }

  planManagementUrl(subject: BillingSubject): string {
    return `https://admin.shopify.com/store/${shopHandle(subject.accountRef)}/charges/${encodeURIComponent(this.appHandle)}/pricing_plans`;
  }

  async reportUsage(): Promise<UsageReportResult> {
    return {
      status: 'blocked',
      reason:
        'App Events API usage reporting not implemented: official endpoint/auth documentation could not be verified in this environment.',
    };
  }
}

/** Pure evaluation (unit-tested): only ACTIVE subscriptions with a known plan handle grant paid features. */
export function evaluateShopifySubscriptions(
  subs: readonly ActiveSubscription[],
  now: Date,
): Entitlements {
  const verifiedAt = now.toISOString();
  const active = subs.filter((s) => s.status === 'ACTIVE');
  for (const sub of active) {
    const handle = sub.lineItems
      .map((li) => li.plan.pricingDetails.planHandle)
      .find((h): h is string => typeof h === 'string' && h.length > 0);
    const plan = planForHandle(handle);
    if (plan) {
      return {
        planKey: plan.key,
        status: 'active',
        features: plan.features,
        limits: plan.limits,
        test: sub.test,
        verifiedAt,
        source: `shopify:${sub.id}`,
      };
    }
  }
  if (active.length > 0) {
    // Active subscription whose plan we cannot map: do not guess from the display name.
    return {
      planKey: FREE_PLAN.key,
      status: 'unknown',
      features: FREE_PLAN.features,
      limits: FREE_PLAN.limits,
      test: active[0]!.test,
      verifiedAt,
      source: `shopify:${active[0]!.id}`,
    };
  }
  return {
    planKey: FREE_PLAN.key,
    status: 'active',
    features: FREE_PLAN.features,
    limits: FREE_PLAN.limits,
    test: false,
    verifiedAt,
    source: 'shopify:none',
  };
}

export type { ActiveSubscription };
