import type { RawWebhookRequest } from '@sellrelay/core';
import { inbox, jobs, repo, tenancy, withTenant } from '@sellrelay/persistence';
import {
  COMPLIANCE_TOPICS,
  minimizeCompliancePayload,
  webhookDedupeKey,
  type ShopifyAdapter,
} from '@sellrelay/platform-shopify';
import { TenantCache } from '@sellrelay/ratelimit';
import type { AppDeps } from '../deps.ts';
import { JobKinds } from '../deps.ts';

export type IngestResult =
  | {
      readonly status: 401;
      readonly outcome: 'invalid_signature' | 'missing_headers' | 'invalid_body';
    }
  | {
      readonly status: 200;
      readonly outcome: 'accepted' | 'duplicate' | 'unknown_shop' | 'inactive_installation';
      readonly inboxId?: string;
    };

/** Topics still accepted after uninstall (privacy obligations and lifecycle). */
const POST_UNINSTALL_TOPICS = new Set([...COMPLIANCE_TOPICS, 'app/uninstalled']);

/**
 * Webhook ingress: verify HMAC on the raw body → resolve installation from the verified shop
 * header → persist to the inbox and enqueue processing in ONE transaction → acknowledge.
 * `app/uninstalled` is applied synchronously in the same transaction (sync disabled, pending work
 * cancelled, credentials removed) so nothing runs after Shopify revokes access.
 */
export async function ingestShopifyWebhook(
  deps: AppDeps,
  adapter: ShopifyAdapter,
  raw: RawWebhookRequest,
): Promise<IngestResult> {
  const verified = adapter.verifyWebhook(raw);
  if (!verified.ok) {
    deps.metrics?.webhooks.inc({ source: 'shopify', topic: 'unknown', result: verified.reason });
    return { status: 401, outcome: verified.reason };
  }
  const w = verified.webhook;
  const inst = await tenancy.resolveShopifyInstallation(deps.pool, w.storeIdentity);
  if (!inst) {
    // Nothing is held for an unknown shop (e.g. shop/redact after full erasure): acknowledge.
    deps.metrics?.webhooks.inc({ source: 'shopify', topic: w.topic, result: 'unknown_shop' });
    deps.log.info({ topic: w.topic }, 'webhook for unknown shop acknowledged');
    return { status: 200, outcome: 'unknown_shop' };
  }
  if (inst.status !== 'active' && !POST_UNINSTALL_TOPICS.has(w.topic)) {
    deps.metrics?.webhooks.inc({ source: 'shopify', topic: w.topic, result: 'inactive' });
    return { status: 200, outcome: 'inactive_installation' };
  }

  const result = await withTenant(deps.pool, inst.tenantId, async (tx) => {
    const ins = await inbox.insertInboxEvent(tx, {
      tenantId: inst.tenantId,
      source: 'shopify',
      installationId: inst.installationId,
      topic: w.topic,
      dedupeKey: webhookDedupeKey(w, raw.rawBody),
      ...(w.providerEventId ? { providerEventId: w.providerEventId } : {}),
      ...(w.providerDeliveryId ? { providerDeliveryId: w.providerDeliveryId } : {}),
      ...(w.apiVersion ? { apiVersion: w.apiVersion } : {}),
      ...(w.triggeredAt ? { triggeredAt: w.triggeredAt } : {}),
      payload: minimizeCompliancePayload(w.topic, w.payload),
    });
    if (ins.duplicate) return { outcome: 'duplicate' as const, inboxId: ins.id };

    if (w.topic === 'app/uninstalled' && inst.status === 'active') {
      const r = await tenancy.markInstallationUninstalled(tx, inst.installationId);
      await repo.logActivity(tx, {
        category: 'installation',
        severity: 'warning',
        message:
          'SellRelay was uninstalled: synchronization disabled, pending work cancelled, credentials removed',
        details: r,
        storeId: inst.storeId,
      });
      await tx.query(
        `INSERT INTO outbox (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload)
         VALUES (app_current_tenant(), 'installation.uninstalled', 'installation', $1, $2, $3)`,
        [
          inst.installationId,
          String(Date.now()),
          { storeId: inst.storeId, installationId: inst.installationId },
        ],
      );
    }
    await jobs.enqueueJob(tx, {
      tenantId: inst.tenantId,
      kind: JobKinds.webhookProcess,
      payload: { inboxId: ins.id, storeId: inst.storeId, installationId: inst.installationId },
      // Privacy topics are not cancelled with the store's sync work after uninstall.
      ...(COMPLIANCE_TOPICS.has(w.topic) || w.topic === 'app/uninstalled'
        ? {}
        : { storeId: inst.storeId }),
      priority: COMPLIANCE_TOPICS.has(w.topic) ? 5 : 0,
    });
    return { outcome: 'accepted' as const, inboxId: ins.id };
  });

  if (w.topic === 'app/uninstalled' && result.outcome === 'accepted') {
    await new TenantCache(deps.redis)
      .purgeTenant(inst.tenantId)
      .catch((e) => deps.log.warn({ err: e }, 'cache purge failed'));
  }
  deps.metrics?.webhooks.inc({ source: 'shopify', topic: w.topic, result: result.outcome });
  return { status: 200, ...result };
}
