import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type {
  NormalizedStoreEvent,
  RawWebhookRequest,
  VerifiedWebhook,
  WebhookVerificationFailure,
} from '@sellrelay/core';
import { inventoryItemGid, locationGid, normalizeShopDomain, productGid } from './shop-domain.ts';

/** Shopify sends classic `x-shopify-*` headers or events-style `shopify-*` headers. */
function header(
  h: RawWebhookRequest['headers'],
  classic: string,
  events: string,
): string | undefined {
  return h[classic] ?? h[events] ?? undefined;
}

export function computeWebhookHmac(secret: string, rawBody: Buffer): string {
  return createHmac('sha256', secret).update(rawBody).digest('base64');
}

/**
 * Verify HMAC-SHA256 over the RAW body (never a re-serialized JSON object), timing-safe.
 * Only after verification is the body parsed.
 */
export function verifyShopifyWebhook(
  req: RawWebhookRequest,
  secret: string,
): { ok: true; webhook: VerifiedWebhook } | { ok: false; reason: WebhookVerificationFailure } {
  const h = req.headers;
  const hmac = header(h, 'x-shopify-hmac-sha256', 'shopify-hmac-sha256');
  const topic = header(h, 'x-shopify-topic', 'shopify-topic');
  const domain = header(h, 'x-shopify-shop-domain', 'shopify-shop-domain');
  if (!hmac || !topic || !domain) return { ok: false, reason: 'missing_headers' };
  const expected = Buffer.from(computeWebhookHmac(secret, req.rawBody));
  const given = Buffer.from(hmac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    return { ok: false, reason: 'invalid_signature' };
  const shop = normalizeShopDomain(domain);
  if (!shop) return { ok: false, reason: 'missing_headers' };
  let payload: unknown;
  try {
    payload = JSON.parse(req.rawBody.toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid_body' };
  }
  const eventId = header(h, 'x-shopify-event-id', 'shopify-event-id');
  const deliveryId = header(h, 'x-shopify-webhook-id', 'shopify-webhook-id');
  const apiVersion = header(h, 'x-shopify-api-version', 'shopify-api-version');
  const triggeredAt = header(h, 'x-shopify-triggered-at', 'shopify-triggered-at');
  return {
    ok: true,
    webhook: {
      platform: 'shopify',
      topic: topic.toLowerCase(),
      storeIdentity: shop,
      ...(eventId ? { providerEventId: eventId } : {}),
      ...(deliveryId ? { providerDeliveryId: deliveryId } : {}),
      ...(apiVersion ? { apiVersion } : {}),
      ...(triggeredAt ? { triggeredAt } : {}),
      payload,
    },
  };
}

/** Dedupe key: provider event id (stable across retries), else delivery id, else body hash. */
export function webhookDedupeKey(w: VerifiedWebhook, rawBody: Buffer): string {
  return (
    w.providerEventId ??
    w.providerDeliveryId ??
    `sha256:${createHash('sha256').update(rawBody).digest('hex')}`
  );
}

export const COMPLIANCE_TOPICS = new Set([
  'customers/data_request',
  'customers/redact',
  'shop/redact',
]);

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;

/**
 * Normalize a verified webhook into canonical store events. Product webhooks are treated as
 * refresh triggers (the product is re-fetched via GraphQL), so payload shape changes cannot
 * corrupt canonical data and out-of-order deliveries are resolved by source timestamps.
 */
export function normalizeShopifyWebhook(w: VerifiedWebhook): NormalizedStoreEvent[] {
  const p = obj(w.payload);
  switch (w.topic) {
    case 'products/create':
    case 'products/update': {
      const id = str(p['admin_graphql_api_id']) ?? str(p['id']);
      if (!id) return [{ type: 'ignored', reason: 'missing product id' }];
      const updatedAt = str(p['updated_at']);
      return [
        {
          type: 'product.refresh_requested',
          productExternalId: productGid(id),
          ...(updatedAt ? { sourceUpdatedAt: updatedAt } : {}),
        },
      ];
    }
    case 'products/delete': {
      const id = str(p['id']);
      return id
        ? [{ type: 'product.deleted', productExternalId: productGid(id) }]
        : [{ type: 'ignored', reason: 'missing product id' }];
    }
    case 'inventory_levels/update': {
      const item = str(p['inventory_item_id']);
      const loc = str(p['location_id']);
      const available = p['available'];
      const updatedAt = str(p['updated_at']) ?? w.triggeredAt;
      if (!item || !loc || typeof available !== 'number' || !updatedAt)
        return [{ type: 'ignored', reason: 'untracked or incomplete inventory level' }];
      return [
        {
          type: 'inventory.level_reported',
          level: {
            kind: 'inventory_level',
            inventoryItemExternalId: inventoryItemGid(item),
            locationExternalId: locationGid(loc),
            available,
            sourceUpdatedAt: updatedAt,
          },
        },
      ];
    }
    case 'locations/create':
    case 'locations/update':
    case 'locations/delete': {
      const id = str(p['admin_graphql_api_id']) ?? str(p['id']);
      return id
        ? [{ type: 'location.changed', locationExternalId: locationGid(id) }]
        : [{ type: 'ignored', reason: 'missing location id' }];
    }
    case 'app/uninstalled':
      return [{ type: 'lifecycle.uninstalled' }];
    case 'app/scopes_update': {
      const current = Array.isArray(p['current'])
        ? (p['current'] as unknown[]).filter((s): s is string => typeof s === 'string')
        : [];
      return [{ type: 'lifecycle.scopes_updated', scopes: current }];
    }
    case 'bulk_operations/finish': {
      const id = str(p['admin_graphql_api_id']);
      return id
        ? [{ type: 'catalog.export_finished', exportId: id }]
        : [{ type: 'ignored', reason: 'missing bulk operation id' }];
    }
    case 'app_subscriptions/update':
      // Never trusted as entitlement proof: triggers server-side re-verification only.
      return [{ type: 'billing.subscription_changed' }];
    case 'customers/data_request': {
      const customer = str(obj(p['customer'])['id']);
      const requestRef = str(obj(p['data_request'])['id']) ?? 'unknown';
      return [
        {
          type: 'privacy.customer_data_request',
          requestRef,
          ...(customer ? { customerRef: customer } : {}),
        },
      ];
    }
    case 'customers/redact': {
      const customer = str(obj(p['customer'])['id']);
      return [{ type: 'privacy.customer_redact', ...(customer ? { customerRef: customer } : {}) }];
    }
    case 'shop/redact':
      return [{ type: 'privacy.shop_redact' }];
    default:
      return [{ type: 'ignored', reason: `unhandled topic ${w.topic}` }];
  }
}

/**
 * Data minimization for compliance webhooks: keep only identifiers needed to process the request
 * (shop, customer id, order ids, request id); drop email, phone and any other personal fields
 * before anything is persisted.
 */
export function minimizeCompliancePayload(topic: string, payload: unknown): unknown {
  if (!COMPLIANCE_TOPICS.has(topic)) return payload;
  const p = obj(payload);
  const customer = obj(p['customer']);
  const ids = (v: unknown) =>
    Array.isArray(v) ? v.filter((x) => typeof x === 'number' || typeof x === 'string') : undefined;
  return {
    shop_id: p['shop_id'] ?? null,
    shop_domain: p['shop_domain'] ?? null,
    ...(customer['id'] !== undefined ? { customer: { id: customer['id'] } } : {}),
    ...(ids(p['orders_requested']) ? { orders_requested: ids(p['orders_requested']) } : {}),
    ...(ids(p['orders_to_redact']) ? { orders_to_redact: ids(p['orders_to_redact']) } : {}),
    ...(obj(p['data_request'])['id'] !== undefined
      ? { data_request: { id: obj(p['data_request'])['id'] } }
      : {}),
  };
}
