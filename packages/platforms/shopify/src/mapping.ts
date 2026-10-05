import {
  parseMoney,
  type CatalogInventoryLevelRecord,
  type CatalogProductRecord,
  type CatalogVariantRecord,
  type ProductStatus,
} from '@sellrelay/core';

type Obj = Record<string, unknown>;
const s = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

function mapStatus(v: unknown): ProductStatus {
  switch (v) {
    case 'ACTIVE':
      return 'active';
    case 'DRAFT':
      return 'draft';
    case 'ARCHIVED':
      return 'archived';
    default:
      return 'unlisted';
  }
}

/**
 * Shopify product → canonical record. Shopify-specific fields stay under the `shopify`
 * extension namespace. Title/description are the shop's default-locale text (translations: Wave 1).
 */
export function mapProduct(node: Obj, defaultLocale = 'default'): CatalogProductRecord {
  const description = s(node['descriptionHtml']);
  const options = Array.isArray(node['options']) ? (node['options'] as Obj[]) : [];
  return {
    kind: 'product',
    externalId: String(node['id']),
    title: { [defaultLocale]: String(node['title'] ?? '') },
    ...(description ? { descriptionHtml: { [defaultLocale]: description } } : {}),
    ...(s(node['handle']) ? { handle: s(node['handle'])! } : {}),
    ...(s(node['vendor']) ? { vendor: s(node['vendor'])! } : {}),
    ...(s(node['productType']) ? { productType: s(node['productType'])! } : {}),
    status: mapStatus(node['status']),
    tags: Array.isArray(node['tags'])
      ? (node['tags'] as unknown[]).filter((t): t is string => typeof t === 'string')
      : [],
    extensions: {
      shopify: {
        options: options.map((o) => ({
          name: String(o['name'] ?? ''),
          values: Array.isArray(o['optionValues'])
            ? (o['optionValues'] as Obj[]).map((v) => String(v['name'] ?? ''))
            : [],
        })),
      },
    },
    sourceUpdatedAt: String(node['updatedAt']),
  };
}

export function mapVariant(
  node: Obj,
  productExternalId: string,
  currency: string,
): CatalogVariantRecord {
  const selected = Array.isArray(node['selectedOptions']) ? (node['selectedOptions'] as Obj[]) : [];
  const item = (node['inventoryItem'] ?? {}) as Obj;
  const compareAt = s(node['compareAtPrice']);
  return {
    kind: 'variant',
    externalId: String(node['id']),
    productExternalId,
    ...(s(item['id']) ? { inventoryItemExternalId: s(item['id'])! } : {}),
    ...(s(node['sku']) ? { sku: s(node['sku'])! } : {}),
    ...(s(node['barcode']) ? { barcode: s(node['barcode'])! } : {}),
    title: String(node['title'] ?? ''),
    price: parseMoney(String(node['price'] ?? '0'), currency),
    ...(compareAt ? { compareAtPrice: parseMoney(compareAt, currency) } : {}),
    inventoryTracked: item['tracked'] !== false,
    optionValues: Object.fromEntries(selected.map((o) => [String(o['name']), String(o['value'])])),
    extensions: {},
    sourceUpdatedAt: String(node['updatedAt']),
  };
}

export function mapInventoryLevel(
  node: Obj,
  inventoryItemExternalId: string,
): CatalogInventoryLevelRecord | null {
  const quantities = Array.isArray(node['quantities']) ? (node['quantities'] as Obj[]) : [];
  const available = quantities.find((q) => q['name'] === 'available')?.['quantity'];
  const location = ((node['location'] ?? {}) as Obj)['id'];
  if (typeof available !== 'number' || typeof location !== 'string') return null;
  return {
    kind: 'inventory_level',
    inventoryItemExternalId,
    locationExternalId: location,
    available,
    sourceUpdatedAt: String(node['updatedAt']),
  };
}

/** Classify a bulk JSONL line by its GID type. */
export function gidType(id: unknown): string | undefined {
  return typeof id === 'string' ? /^gid:\/\/shopify\/(\w+)\//.exec(id)?.[1] : undefined;
}
