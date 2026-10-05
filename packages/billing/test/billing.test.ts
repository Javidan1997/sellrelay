import { describe, expect, it } from 'vitest';
import { hasFeature } from '../../core/src/index.ts';
import {
  ShopifyAppPricingProvider,
  evaluateShopifySubscriptions,
  type ActiveSubscription,
} from '../src/index.ts';

const now = new Date('2026-10-05T00:00:00Z');
const sub = (
  over: Partial<ActiveSubscription> & { handle?: string | null },
): ActiveSubscription => ({
  id: 'gid://shopify/AppSubscription/1',
  name: 'Whatever Name',
  status: 'ACTIVE',
  test: true,
  currentPeriodEnd: null,
  lineItems: [
    {
      plan: {
        pricingDetails: {
          __typename: 'AppRecurringPricing',
          planHandle: over.handle === undefined ? 'growth' : over.handle,
        },
      },
    },
  ],
  ...over,
});

describe('Shopify App Pricing entitlement evaluation', () => {
  it('grants plan features only for an ACTIVE subscription with a known plan handle', () => {
    const e = evaluateShopifySubscriptions([sub({})], now);
    expect(e).toMatchObject({ planKey: 'growth', status: 'active', test: true });
    expect(hasFeature(e, 'inventory_sync')).toBe(true);
  });

  it('never trusts the display name: unknown handle → free features, status unknown', () => {
    const e = evaluateShopifySubscriptions([sub({ name: 'Scale', handle: 'made-up' })], now);
    expect(e).toMatchObject({ planKey: 'free', status: 'unknown' });
    expect(hasFeature(e, 'inventory_sync')).toBe(false);
    expect(hasFeature(e, 'catalog_import')).toBe(false); // fail-closed while unknown
  });

  it('ignores non-active subscriptions; no subscription → free plan', () => {
    const e = evaluateShopifySubscriptions(
      [sub({ status: 'PENDING' }), sub({ status: 'CANCELLED' })],
      now,
    );
    expect(e).toMatchObject({ planKey: 'free', status: 'active', source: 'shopify:none' });
    expect(hasFeature(e, 'catalog_import')).toBe(true);
    expect(hasFeature(e, 'inventory_sync')).toBe(false);
  });

  it('builds the hosted plan selection URL and reports usage as blocked', async () => {
    const p = new ShopifyAppPricingProvider({
      client: async () => {
        throw new Error('unused');
      },
      appHandle: 'sellrelay',
    });
    const subject = {
      tenantId: 't',
      installationId: 'i',
      accountRef: 'synthetic-demo.myshopify.com',
    };
    expect(p.planManagementUrl(subject)).toBe(
      'https://admin.shopify.com/store/synthetic-demo/charges/sellrelay/pricing_plans',
    );
    expect(await p.reportUsage()).toMatchObject({ status: 'blocked' });
  });
});
