import type { Tx } from '../db.ts';

// ---------------------------------------------------------------- entity version checks
/** Atomically accept a version only if newer than the last applied one (rejects stale updates). */
export async function acceptEntityVersion(
  tx: Tx,
  targetId: string,
  entityKey: string,
  version: string,
): Promise<boolean> {
  const r = await tx.query(
    `INSERT INTO entity_sync_state (tenant_id, target_id, entity_key, last_applied_version)
     VALUES (app_current_tenant(), $1, $2, $3)
     ON CONFLICT (tenant_id, target_id, entity_key) DO UPDATE SET last_applied_version = EXCLUDED.last_applied_version, updated_at = now()
     WHERE entity_sync_state.last_applied_version::numeric < EXCLUDED.last_applied_version::numeric`,
    [targetId, entityKey, version],
  );
  return r.rowCount === 1;
}

// ---------------------------------------------------------------- activity
export interface ActivityInput {
  readonly category: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly jobId?: string;
  readonly storeId?: string;
  readonly connectionId?: string;
}

export async function logActivity(tx: Tx, a: ActivityInput): Promise<void> {
  await tx.query(
    `INSERT INTO activity_log (tenant_id, category, severity, message, details, job_id, store_id, connection_id)
     VALUES (app_current_tenant(), $1, $2, $3, $4, $5, $6, $7)`,
    [
      a.category,
      a.severity,
      a.message,
      a.details ?? {},
      a.jobId ?? null,
      a.storeId ?? null,
      a.connectionId ?? null,
    ],
  );
}

export interface ActivityRow {
  readonly id: string;
  readonly occurred_at: Date;
  readonly category: string;
  readonly severity: string;
  readonly message: string;
  readonly details: Record<string, unknown>;
  readonly job_id: string | null;
}

export async function listActivity(tx: Tx, limit: number): Promise<ActivityRow[]> {
  return (
    await tx.query<ActivityRow>(
      'SELECT id, occurred_at, category, severity, message, details, job_id FROM activity_log ORDER BY occurred_at DESC LIMIT $1',
      [limit],
    )
  ).rows;
}

// ---------------------------------------------------------------- checkpoints
export interface CheckpointRow {
  readonly id: string;
  readonly store_id: string;
  readonly kind: string;
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  readonly state: Record<string, unknown>;
  readonly counters: Record<string, number>;
  readonly job_id: string | null;
  readonly error: string | null;
  readonly started_at: Date;
  readonly updated_at: Date;
  readonly completed_at: Date | null;
}

/** Start (or return the already-active) checkpoint for a store-level long-running sync. */
export async function startCheckpoint(
  tx: Tx,
  storeId: string,
  kind: string,
): Promise<{ checkpoint: CheckpointRow; created: boolean }> {
  const existing = (
    await tx.query<CheckpointRow>(
      `SELECT * FROM sync_checkpoints WHERE store_id = $1 AND kind = $2 AND status IN ('pending', 'running')`,
      [storeId, kind],
    )
  ).rows[0];
  if (existing) return { checkpoint: existing, created: false };
  const row = (
    await tx.query<CheckpointRow>(
      `INSERT INTO sync_checkpoints (tenant_id, store_id, kind, status) VALUES (app_current_tenant(), $1, $2, 'pending') RETURNING *`,
      [storeId, kind],
    )
  ).rows[0]!;
  return { checkpoint: row, created: true };
}

export async function getCheckpoint(tx: Tx, id: string): Promise<CheckpointRow | null> {
  return (
    (await tx.query<CheckpointRow>('SELECT * FROM sync_checkpoints WHERE id = $1', [id])).rows[0] ??
    null
  );
}

export async function latestCheckpoint(
  tx: Tx,
  storeId: string,
  kind: string,
): Promise<CheckpointRow | null> {
  return (
    (
      await tx.query<CheckpointRow>(
        'SELECT * FROM sync_checkpoints WHERE store_id = $1 AND kind = $2 ORDER BY started_at DESC LIMIT 1',
        [storeId, kind],
      )
    ).rows[0] ?? null
  );
}

export async function updateCheckpoint(
  tx: Tx,
  id: string,
  patch: {
    status?: CheckpointRow['status'];
    state?: Record<string, unknown>;
    counters?: Record<string, number>;
    jobId?: string;
    error?: string | null;
  },
): Promise<void> {
  await tx.query(
    `UPDATE sync_checkpoints SET
       status = COALESCE($2, status), state = COALESCE($3, state), counters = COALESCE($4, counters),
       job_id = COALESCE($5, job_id), error = CASE WHEN $6::boolean THEN $7 ELSE error END,
       completed_at = CASE WHEN $2 IN ('completed', 'failed', 'cancelled') THEN now() ELSE completed_at END,
       updated_at = now()
     WHERE id = $1`,
    [
      id,
      patch.status ?? null,
      patch.state ?? null,
      patch.counters ?? null,
      patch.jobId ?? null,
      patch.error !== undefined,
      patch.error ?? null,
    ],
  );
}

// ---------------------------------------------------------------- entitlements
export interface EntitlementRow {
  readonly installation_id: string;
  readonly provider: string;
  readonly plan_key: string;
  readonly status: 'active' | 'trial' | 'none' | 'frozen' | 'unknown';
  readonly features: string[];
  readonly limits: { maxSkus: number; maxChannelConnections: number };
  readonly test: boolean;
  readonly provider_subscription_id: string | null;
  readonly verified_at: Date | null;
}

export async function upsertEntitlements(
  tx: Tx,
  e: {
    installationId: string;
    provider: string;
    planKey: string;
    status: EntitlementRow['status'];
    features: readonly string[];
    limits: EntitlementRow['limits'];
    test: boolean;
    providerSubscriptionId: string | null;
    verifiedAt: Date | null;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO billing_entitlements (tenant_id, installation_id, provider, plan_key, status, features, limits, test,
                                      provider_subscription_id, verified_at)
     VALUES (app_current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (tenant_id, installation_id) DO UPDATE SET provider = EXCLUDED.provider, plan_key = EXCLUDED.plan_key,
       status = EXCLUDED.status, features = EXCLUDED.features, limits = EXCLUDED.limits, test = EXCLUDED.test,
       provider_subscription_id = EXCLUDED.provider_subscription_id, verified_at = EXCLUDED.verified_at, updated_at = now()`,
    [
      e.installationId,
      e.provider,
      e.planKey,
      e.status,
      e.features,
      e.limits,
      e.test,
      e.providerSubscriptionId,
      e.verifiedAt,
    ],
  );
}

export async function getEntitlements(
  tx: Tx,
  installationId: string,
): Promise<EntitlementRow | null> {
  return (
    (
      await tx.query<EntitlementRow>(
        'SELECT * FROM billing_entitlements WHERE installation_id = $1',
        [installationId],
      )
    ).rows[0] ?? null
  );
}

// ---------------------------------------------------------------- privacy
export async function recordPrivacyRequest(
  tx: Tx,
  r: { source: string; topic: string; subjectRefHash: string | null; dueAt: Date },
): Promise<string> {
  return (
    await tx.query<{ id: string }>(
      `INSERT INTO privacy_requests (tenant_id, source, topic, subject_ref_hash, status, due_at)
     VALUES (app_current_tenant(), $1, $2, $3, 'received', $4) RETURNING id`,
      [r.source, r.topic, r.subjectRefHash, r.dueAt],
    )
  ).rows[0]!.id;
}

export async function completePrivacyRequest(
  tx: Tx,
  id: string,
  status: 'completed' | 'needs_review',
  outcome: Record<string, unknown>,
): Promise<void> {
  await tx.query(
    `UPDATE privacy_requests SET status = $2, outcome = $3, completed_at = CASE WHEN $2 = 'completed' THEN now() END WHERE id = $1`,
    [id, status, outcome],
  );
}

export async function listPrivacyRequests(
  tx: Tx,
  limit: number,
): Promise<Record<string, unknown>[]> {
  return (
    await tx.query(
      'SELECT id, source, topic, status, received_at, due_at, completed_at, outcome FROM privacy_requests ORDER BY received_at DESC LIMIT $1',
      [limit],
    )
  ).rows;
}

// ---------------------------------------------------------------- flags / kill switches
/**
 * Kill switch semantics: an enabled `kill_switch` flag at global or tenant level for the given
 * scope (integration key) or for scope `*` blocks work.
 */
export async function isKillSwitchActive(tx: Tx, scopeKey: string): Promise<boolean> {
  const r = await tx.query(
    `SELECT 1 FROM feature_flags WHERE flag = 'kill_switch' AND enabled AND (scope_key = $1 OR scope_key = '*') LIMIT 1`,
    [scopeKey],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Feature flag evaluation: tenant-specific row overrides the global row; default false. */
export async function isFeatureEnabled(
  tx: Tx,
  flag: string,
  scopeKey: string | null = null,
): Promise<boolean> {
  const r = await tx.query<{ enabled: boolean }>(
    `SELECT enabled FROM feature_flags WHERE flag = $1 AND scope_key IS NOT DISTINCT FROM $2
     ORDER BY tenant_id NULLS LAST LIMIT 1`,
    [flag, scopeKey],
  );
  return r.rows[0]?.enabled ?? false;
}

// ---------------------------------------------------------------- connections
export interface ConnectionRow {
  readonly id: string;
  readonly channel_key: string;
  readonly state: string;
  readonly sync_enabled: boolean;
  readonly activated_at: Date | null;
  readonly initial_preview_completed_at: Date | null;
  readonly region: string | null;
}

export async function listConnections(tx: Tx): Promise<ConnectionRow[]> {
  return (
    await tx.query<ConnectionRow>(
      'SELECT id, channel_key, state, sync_enabled, activated_at, initial_preview_completed_at, region FROM channel_connections ORDER BY created_at',
    )
  ).rows;
}

export async function listSyncEnabledConnections(tx: Tx): Promise<ConnectionRow[]> {
  return (
    await tx.query<ConnectionRow>(
      `SELECT id, channel_key, state, sync_enabled, activated_at, initial_preview_completed_at, region
     FROM channel_connections WHERE sync_enabled AND state = 'connected' AND activated_at IS NOT NULL`,
    )
  ).rows;
}
