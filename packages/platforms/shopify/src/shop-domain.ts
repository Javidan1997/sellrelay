/**
 * Strict shop domain validation. Only `<handle>.myshopify.com` is accepted for outbound Admin
 * API calls (prevents SSRF via attacker-controlled hosts).
 */
const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function normalizeShopDomain(input: string): string | null {
  const shop = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  return SHOP_RE.test(shop) ? shop : null;
}

export function requireShopDomain(input: string): string {
  const shop = normalizeShopDomain(input);
  if (!shop) throw new Error('Invalid shop domain');
  return shop;
}

/** Store handle used in admin.shopify.com URLs (e.g. plan selection page). */
export function shopHandle(shopDomain: string): string {
  return requireShopDomain(shopDomain).replace(/\.myshopify\.com$/, '');
}

export const productGid = (id: string | number) =>
  String(id).startsWith('gid://') ? String(id) : `gid://shopify/Product/${id}`;
export const inventoryItemGid = (id: string | number) =>
  String(id).startsWith('gid://') ? String(id) : `gid://shopify/InventoryItem/${id}`;
export const locationGid = (id: string | number) =>
  String(id).startsWith('gid://') ? String(id) : `gid://shopify/Location/${id}`;
