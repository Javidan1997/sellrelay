import type { NormalizedStoreEvent } from '@sellrelay/core';
import { repo, tenancy } from '@sellrelay/persistence';
import { TenantCache } from '@sellrelay/ratelimit';
import { pseudonymize } from '@sellrelay/security';
import type { AppDeps, TenantScope } from '../deps.ts';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Mandatory Shopify privacy webhooks. Wave 0 stores no customer or order data, so customer
 * requests are recorded and completed with that finding. shop/redact erases all store-scoped data
 * SellRelay holds. Raw personal identifiers are never stored: subject refs are pseudonymized.
 * Propagation to connected external systems is not automatic: Wave 0 has none; later waves must
 * record per-system outcomes (see SECURITY.md).
 */
export async function handlePrivacyEvent(
  deps: AppDeps,
  scope: TenantScope,
  input: { storeId: string; installationId: string; event: NormalizedStoreEvent; receivedAt: Date },
): Promise<{ status: 'completed' | 'needs_review' }> {
  const { event } = input;
  const topic = event.type;
  const subject =
    'customerRef' in event && event.customerRef
      ? pseudonymize(deps.privacyHashKey, `shopify:customer:${event.customerRef}`)
      : null;
  const dueAt = new Date(input.receivedAt.getTime() + 30 * DAY);

  if (event.type === 'privacy.customer_data_request' || event.type === 'privacy.customer_redact') {
    return scope.tx(async (tx) => {
      const id = await repo.recordPrivacyRequest(tx, {
        source: 'shopify',
        topic,
        subjectRefHash: subject,
        dueAt,
      });
      await repo.completePrivacyRequest(tx, id, 'completed', {
        customerDataHeld: false,
        note: 'SellRelay Wave 0 does not store customer or order data; nothing to export or redact.',
        externalPropagation: 'none (no connected external systems hold customer data in Wave 0)',
      });
      await repo.logActivity(tx, {
        category: 'privacy',
        severity: 'info',
        message: `Privacy request processed: ${topic}`,
        details: { requestId: id },
      });
      return { status: 'completed' as const };
    });
  }

  if (event.type === 'privacy.shop_redact') {
    const result = await scope.tx(async (tx) => {
      const id = await repo.recordPrivacyRequest(tx, {
        source: 'shopify',
        topic,
        subjectRefHash: null,
        dueAt,
      });
      const inst = await tenancy.getInstallation(tx, input.installationId);
      if (inst?.status === 'active') {
        // Reinstalled before redaction was delivered: do not erase an active installation's data.
        await repo.completePrivacyRequest(tx, id, 'needs_review', {
          reason: 'installation active again; erasure skipped pending review',
        });
        return { status: 'needs_review' as const };
      }
      const counts = await tenancy.redactStoreData(tx, input.storeId, input.installationId);
      await repo.completePrivacyRequest(tx, id, 'completed', { erased: counts });
      await repo.logActivity(tx, {
        category: 'privacy',
        severity: 'info',
        message: 'Shop data erased (shop/redact)',
        details: { requestId: id },
      });
      return { status: 'completed' as const };
    });
    if (result.status === 'completed')
      await new TenantCache(deps.redis).purgeTenant(scope.tenantId).catch(() => undefined);
    return result;
  }
  return { status: 'needs_review' };
}
