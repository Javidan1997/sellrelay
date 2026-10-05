import type {
  CrmOperation,
  IntegrationDescriptor,
  MarketplaceOperation,
  OperationKey,
  OperationSupport,
  StorePlatformOperation,
} from './types.ts';

const planned = (note?: string): OperationSupport =>
  note ? { status: 'planned', note } : { status: 'planned' };
const available = (note?: string): OperationSupport =>
  note ? { status: 'available', note } : { status: 'available' };

function allPlanned<Op extends string>(
  ops: readonly Op[],
  note: string,
): Record<Op, OperationSupport> {
  return Object.fromEntries(ops.map((op) => [op, planned(note)])) as Record<Op, OperationSupport>;
}

export const STORE_PLATFORM_OPERATIONS: readonly StorePlatformOperation[] = [
  'install_auth',
  'catalog_read',
  'translations_read',
  'locations_read',
  'inventory_read',
  'inventory_write',
  'order_create',
  'fulfillment_write',
  'webhooks',
  'event_normalization',
  'billing',
];

export const MARKETPLACE_OPERATIONS: readonly MarketplaceOperation[] = [
  'auth',
  'connection_test',
  'categories',
  'required_attributes',
  'listing_publish',
  'offers',
  'stock',
  'prices',
  'order_ingest',
  'tracking',
  'returns',
];

export const CRM_OPERATIONS: readonly CrmOperation[] = [
  'auth',
  'connection_test',
  'contact_upsert',
  'company_upsert',
  'deal_or_sales_order',
  'line_items',
  'pipeline_metadata',
];

const RESEARCH_PENDING = 'Provider research is performed at the start of the assigned wave.';

function plannedStorePlatform(
  key: string,
  displayName: string,
  wave: string,
): IntegrationDescriptor<StorePlatformOperation> {
  return {
    key,
    kind: 'store_platform',
    displayName,
    wave,
    implementation: 'planned',
    verification: 'none',
    approval: 'pending',
    approvalNote: `Distribution, review and billing requirements not yet researched. ${RESEARCH_PENDING}`,
    regions: [],
    operations: allPlanned(STORE_PLATFORM_OPERATIONS, `Planned for ${wave}.`),
  };
}

function plannedMarketplace(
  key: string,
  displayName: string,
  wave: string,
  approvalNote: string,
): IntegrationDescriptor<MarketplaceOperation> {
  return {
    key,
    kind: 'marketplace',
    displayName,
    wave,
    implementation: 'planned',
    verification: 'none',
    approval: 'pending',
    approvalNote,
    regions: [],
    operations: allPlanned(MARKETPLACE_OPERATIONS, `Planned for ${wave}.`),
  };
}

function plannedCrm(
  key: string,
  displayName: string,
  wave: string,
): IntegrationDescriptor<CrmOperation> {
  return {
    key,
    kind: 'crm',
    displayName,
    wave,
    implementation: 'planned',
    verification: 'none',
    approval: 'pending',
    approvalNote: RESEARCH_PENDING,
    regions: [],
    operations: allPlanned(CRM_OPERATIONS, `Planned for ${wave}. One-way store → CRM first.`),
  };
}

/**
 * Shopify — Wave 0 scope. Verification stays "mock-only" until the gate checks are executed
 * against a supplied development store; see docs/waves/wave-0/GATE_REPORT.md.
 */
export const SHOPIFY: IntegrationDescriptor<StorePlatformOperation> = {
  key: 'shopify',
  kind: 'store_platform',
  displayName: 'Shopify',
  wave: 'Wave 0',
  implementation: 'implemented',
  verification: 'mock-only',
  approval: 'pending',
  approvalNote:
    'Shopify App Store review not submitted. Protected customer data access not requested (not needed in Wave 0).',
  regions: ['global'],
  operations: {
    install_auth: available('Managed installation + token exchange (expiring offline tokens).'),
    catalog_read: available('Bulk operations with resumable checkpoints.'),
    translations_read: planned('Wave 1 (language engine).'),
    locations_read: available(),
    inventory_read: available('Bulk export + inventory_levels/update webhooks.'),
    inventory_write: planned('Wave 1 (order import inventory effects).'),
    order_create: planned('Wave 1 (marketplace order import).'),
    fulfillment_write: planned('Wave 1 (tracking sync).'),
    webhooks: available('HMAC-verified on raw body, durable inbox.'),
    event_normalization: available(),
    billing: available(
      'Shopify App Pricing entitlement verification via Admin API. Usage reporting blocked pending docs.',
    ),
  },
};

export const STORE_PLATFORMS: readonly IntegrationDescriptor<StorePlatformOperation>[] = [
  SHOPIFY,
  plannedStorePlatform('woocommerce', 'WooCommerce', 'Wave P1'),
  plannedStorePlatform('bigcommerce', 'BigCommerce', 'Wave P2+'),
  plannedStorePlatform('adobe_commerce', 'Adobe Commerce (Magento)', 'Wave P2+'),
  plannedStorePlatform('shopware', 'Shopware', 'Wave P2+'),
  plannedStorePlatform('prestashop', 'PrestaShop', 'Wave P2+'),
  plannedStorePlatform('wix', 'Wix', 'Wave P2+'),
  plannedStorePlatform('ecwid', 'Ecwid', 'Wave P2+'),
];

export const MARKETPLACES: readonly IntegrationDescriptor<MarketplaceOperation>[] = [
  plannedMarketplace('metro', 'METRO Markets (Makro)', 'Wave 1', RESEARCH_PENDING),
  plannedMarketplace('kaufland', 'Kaufland', 'Wave 2', RESEARCH_PENDING),
  plannedMarketplace('allegro', 'Allegro', 'Wave 3a', RESEARCH_PENDING),
  plannedMarketplace('bol', 'bol.com', 'Wave 3b', RESEARCH_PENDING),
  plannedMarketplace(
    'otto',
    'OTTO Market',
    'Wave 3c',
    `Partner requirements must be confirmed. ${RESEARCH_PENDING}`,
  ),
  plannedMarketplace(
    'amazon',
    'Amazon',
    'Wave 6a',
    'SP-API developer registration and restricted-data access require confirmation from the merchant/operator.',
  ),
  plannedMarketplace(
    'ebay',
    'eBay',
    'Wave 6b',
    'Developer program and marketplace account-deletion notification requirements must be confirmed.',
  ),
  plannedMarketplace(
    'walmart',
    'Walmart',
    'Wave 6c',
    'Partner/solution-provider access must be confirmed.',
  ),
  plannedMarketplace('etsy', 'Etsy', 'Wave 6d', 'Commercial API access must be confirmed.'),
  plannedMarketplace(
    'tiktok_shop',
    'TikTok Shop',
    'Wave 6e',
    'Partner app approval must be confirmed.',
  ),
];

export const CRMS: readonly IntegrationDescriptor<CrmOperation>[] = [
  plannedCrm('hubspot', 'HubSpot', 'Wave 4a'),
  plannedCrm('zoho_crm', 'Zoho CRM', 'Wave 4b'),
  plannedCrm('pipedrive', 'Pipedrive', 'Wave 5a'),
  plannedCrm('odoo', 'Odoo', 'Wave 5b'),
];

export const ALL_INTEGRATIONS: readonly IntegrationDescriptor[] = [
  ...(STORE_PLATFORMS as readonly IntegrationDescriptor[]),
  ...(MARKETPLACES as readonly IntegrationDescriptor[]),
  ...(CRMS as readonly IntegrationDescriptor[]),
];

export function findIntegration(key: string): IntegrationDescriptor | undefined {
  return ALL_INTEGRATIONS.find((d) => d.key === key);
}

/** UI and API must treat an operation as usable only if this returns true. */
export function isOperationAvailable(descriptor: IntegrationDescriptor, op: OperationKey): boolean {
  if (descriptor.implementation !== 'implemented') return false;
  const support = (descriptor.operations as Readonly<Record<string, OperationSupport>>)[op];
  return support?.status === 'available';
}
