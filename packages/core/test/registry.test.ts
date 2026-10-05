import { describe, expect, it } from 'vitest';
import {
  ALL_INTEGRATIONS,
  CRMS,
  MARKETPLACES,
  STORE_PLATFORMS,
  findIntegration,
  isOperationAvailable,
} from '../src/index.ts';

describe('capability registry', () => {
  it('lists every planned host and connector', () => {
    expect(STORE_PLATFORMS.map((p) => p.key)).toEqual([
      'shopify',
      'woocommerce',
      'bigcommerce',
      'adobe_commerce',
      'shopware',
      'prestashop',
      'wix',
      'ecwid',
    ]);
    expect(MARKETPLACES.map((p) => p.key)).toEqual([
      'metro',
      'kaufland',
      'allegro',
      'bol',
      'otto',
      'amazon',
      'ebay',
      'walmart',
      'etsy',
      'tiktok_shop',
    ]);
    expect(CRMS.map((p) => p.key)).toEqual(['hubspot', 'zoho_crm', 'pipedrive', 'odoo']);
    expect(new Set(ALL_INTEGRATIONS.map((i) => i.key)).size).toBe(ALL_INTEGRATIONS.length);
  });

  it('planned integrations expose no available operations', () => {
    for (const d of ALL_INTEGRATIONS.filter((i) => i.implementation === 'planned')) {
      for (const op of Object.keys(d.operations)) {
        expect(isOperationAvailable(d, op as never)).toBe(false);
      }
      expect(d.verification).toBe('none');
    }
  });

  it('shopify exposes only Wave 0 operations and is not claimed beyond mock verification', () => {
    const shopify = findIntegration('shopify')!;
    expect(shopify.verification).toBe('mock-only');
    expect(isOperationAvailable(shopify, 'catalog_read')).toBe(true);
    expect(isOperationAvailable(shopify, 'order_create')).toBe(false);
    expect(isOperationAvailable(shopify, 'translations_read')).toBe(false);
  });
});
