import type { ConnectionState } from '../capabilities/types.ts';
import type { Entitlements } from '../entitlements.ts';
import { hasFeature } from '../entitlements.ts';

export interface ConnectionSyncState {
  readonly state: ConnectionState;
  readonly syncEnabled: boolean;
  readonly activatedAt: string | null;
  readonly initialPreviewCompletedAt: string | null;
}

export type SyncBlockReason =
  | 'not_connected'
  | 'not_activated'
  | 'preview_required'
  | 'sync_disabled'
  | 'kill_switch'
  | 'not_entitled'
  | 'installation_inactive';

/**
 * A successful connection never enables synchronization by itself. Sync requires an explicit
 * merchant activation after an initial preview, an active installation, entitlement, and no kill switch.
 */
export function evaluateSyncPermission(input: {
  readonly connection: ConnectionSyncState;
  readonly installationActive: boolean;
  readonly entitlements: Entitlements;
  readonly killSwitchActive: boolean;
}): { allowed: true } | { allowed: false; reason: SyncBlockReason } {
  if (!input.installationActive) return { allowed: false, reason: 'installation_inactive' };
  if (input.killSwitchActive) return { allowed: false, reason: 'kill_switch' };
  if (input.connection.state !== 'connected') return { allowed: false, reason: 'not_connected' };
  if (!input.connection.initialPreviewCompletedAt)
    return { allowed: false, reason: 'preview_required' };
  if (!input.connection.activatedAt) return { allowed: false, reason: 'not_activated' };
  if (!input.connection.syncEnabled) return { allowed: false, reason: 'sync_disabled' };
  if (!hasFeature(input.entitlements, 'inventory_sync'))
    return { allowed: false, reason: 'not_entitled' };
  return { allowed: true };
}
