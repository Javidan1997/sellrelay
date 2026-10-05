import type pg from 'pg';
import type { Tx } from '../db.ts';
import { withSystemTx } from '../db.ts';
import { cancelJobsForScope } from './jobs.ts';

export type Role = 'owner' | 'admin' | 'member' | 'viewer';

export interface ProvisionResult {
  readonly tenantId: string;
  readonly storeId: string;
  readonly installationId: string;
  readonly userId: string;
  readonly role: Role;
  /** True when the installation was created or re-activated by this call. */
  readonly activated: boolean;
}

/**
 * Exception (ADR 0005 #2): called only after the Shopify session token was verified.
 * Creates or re-activates tenant/store/installation and the user's membership.
 */
export async function provisionShopifyInstallation(
  pool: pg.Pool,
  input: { shopDomain: string; shopName?: string; userSubject: string; apiVersion: string },
): Promise<ProvisionResult> {
  return withSystemTx(pool, async (tx) => {
    const r = await tx.query<{
      tenant_id: string;
      store_id: string;
      installation_id: string;
      user_id: string;
      role: Role;
      activated: boolean;
    }>('SELECT * FROM provision_shopify_installation($1, $2, $3, $4)', [
      input.shopDomain,
      input.shopName ?? '',
      input.userSubject,
      input.apiVersion,
    ]);
    const row = r.rows[0];
    if (!row) throw new Error('provisioning returned no row');
    return {
      tenantId: row.tenant_id,
      storeId: row.store_id,
      installationId: row.installation_id,
      userId: row.user_id,
      role: row.role,
      activated: row.activated,
    };
  });
}

export interface InstallationRef {
  readonly tenantId: string;
  readonly storeId: string;
  readonly installationId: string;
  readonly status: 'active' | 'uninstalled';
}

/** Exception (ADR 0005 #1): webhook routing before any tenant context exists. */
export async function resolveShopifyInstallation(
  pool: pg.Pool,
  shopDomain: string,
): Promise<InstallationRef | null> {
  return withSystemTx(pool, async (tx) => {
    const r = await tx.query<{
      tenant_id: string;
      store_id: string;
      installation_id: string;
      installation_status: 'active' | 'uninstalled';
    }>('SELECT * FROM resolve_shopify_installation($1)', [shopDomain]);
    const row = r.rows[0];
    return row
      ? {
          tenantId: row.tenant_id,
          storeId: row.store_id,
          installationId: row.installation_id,
          status: row.installation_status,
        }
      : null;
  });
}

export async function resolveMembership(
  pool: pg.Pool,
  provider: string,
  subject: string,
  tenantId: string,
): Promise<{ userId: string; role: Role } | null> {
  return withSystemTx(pool, async (tx) => {
    const r = await tx.query<{ user_id: string; role: Role }>(
      'SELECT * FROM resolve_membership($1, $2, $3)',
      [provider, subject, tenantId],
    );
    const row = r.rows[0];
    return row ? { userId: row.user_id, role: row.role } : null;
  });
}

export async function updateInstallationScopes(
  tx: Tx,
  installationId: string,
  scopes: readonly string[],
): Promise<void> {
  await tx.query('UPDATE installations SET scopes = $2, updated_at = now() WHERE id = $1', [
    installationId,
    scopes,
  ]);
}

export async function updateStoreProfile(
  tx: Tx,
  storeId: string,
  profile: { name?: string; currency?: string; externalStoreId?: string },
): Promise<void> {
  await tx.query(
    `UPDATE stores SET name = COALESCE($2, name), currency = COALESCE($3, currency),
       external_store_id = COALESCE($4, external_store_id), updated_at = now() WHERE id = $1`,
    [storeId, profile.name ?? null, profile.currency ?? null, profile.externalStoreId ?? null],
  );
}

export interface InstallationRow {
  readonly id: string;
  readonly store_id: string;
  readonly host: string;
  readonly status: 'active' | 'uninstalled';
  readonly scopes: string[];
  readonly installed_at: Date | null;
  readonly uninstalled_at: Date | null;
}

export async function getInstallation(
  tx: Tx,
  installationId: string,
): Promise<InstallationRow | null> {
  return (
    (await tx.query<InstallationRow>('SELECT * FROM installations WHERE id = $1', [installationId]))
      .rows[0] ?? null
  );
}

export interface StoreRow {
  readonly id: string;
  readonly platform: string;
  readonly domain: string;
  readonly name: string | null;
  readonly currency: string | null;
  readonly status: string;
}

export async function getStore(tx: Tx, storeId: string): Promise<StoreRow | null> {
  return (
    (
      await tx.query<StoreRow>(
        'SELECT id, platform, domain, name, currency, status FROM stores WHERE id = $1',
        [storeId],
      )
    ).rows[0] ?? null
  );
}

/**
 * Uninstall: immediately disables normal sync, cancels pending work and removes credentials.
 * Store data is retained until the shop/redact lifecycle event (or the retention policy) purges it,
 * so required privacy processing remains possible.
 */
export async function markInstallationUninstalled(
  tx: Tx,
  installationId: string,
): Promise<{
  cancelledJobs: number;
  cancelRequested: number;
  credentialsDeleted: number;
  connectionsDisabled: number;
}> {
  const inst = (
    await tx.query<{ store_id: string }>(
      `UPDATE installations SET status = 'uninstalled', uninstalled_at = now(), updated_at = now()
       WHERE id = $1 RETURNING store_id`,
      [installationId],
    )
  ).rows[0];
  if (!inst) throw new Error('installation not found in tenant context');
  await tx.query(
    `UPDATE stores SET status = 'uninstalled', updated_at = now() WHERE id = $1 AND status = 'active'`,
    [inst.store_id],
  );
  // Channel connections are tenant-wide; disable them when no other store installation remains active.
  const conns = await tx.query<{ id: string }>(
    `UPDATE channel_connections SET sync_enabled = false, updated_at = now()
     WHERE sync_enabled AND NOT EXISTS (SELECT 1 FROM installations WHERE status = 'active' AND id <> $1)
     RETURNING id`,
    [installationId],
  );
  const jobs = await cancelJobsForScope(
    tx,
    { storeId: inst.store_id, connectionIds: conns.rows.map((r) => r.id) },
    'installation uninstalled',
  );
  const creds = await tx.query(
    `DELETE FROM credentials WHERE owner_kind = 'installation' AND owner_id = $1`,
    [installationId],
  );
  await tx.query(
    `UPDATE billing_entitlements SET status = 'none', features = '{}', updated_at = now() WHERE installation_id = $1`,
    [installationId],
  );
  return {
    cancelledJobs: jobs.cancelled,
    cancelRequested: jobs.cancelRequested,
    credentialsDeleted: creds.rowCount ?? 0,
    connectionsDisabled: conns.rowCount ?? 0,
  };
}

/**
 * shop/redact: erase store-scoped data held by SellRelay. Keeps the minimal non-personal audit trail
 * (privacy_requests, activity metadata) required to evidence the processing.
 */
export async function redactStoreData(
  tx: Tx,
  storeId: string,
  installationId: string,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const del = async (label: string, sql: string, params: unknown[]) => {
    counts[label] = (await tx.query(sql, params)).rowCount ?? 0;
  };
  await del(
    'inventory_levels',
    `DELETE FROM inventory_levels il USING locations l WHERE il.location_id = l.id AND il.tenant_id = l.tenant_id AND l.store_id = $1`,
    [storeId],
  );
  await del('products', `DELETE FROM products WHERE store_id = $1`, [storeId]);
  await del('locations', `DELETE FROM locations WHERE store_id = $1`, [storeId]);
  await del('external_references', `DELETE FROM external_references WHERE system_id = $1`, [
    storeId,
  ]);
  await del('sync_checkpoints', `DELETE FROM sync_checkpoints WHERE store_id = $1`, [storeId]);
  await del(
    'credentials',
    `DELETE FROM credentials WHERE owner_kind = 'installation' AND owner_id = $1`,
    [installationId],
  );
  await del(
    'inbox_payloads',
    `UPDATE webhook_inbox SET payload = NULL, payload_purged_at = now() WHERE installation_id = $1 AND payload IS NOT NULL`,
    [installationId],
  );
  await del('entity_sync_state', `DELETE FROM entity_sync_state WHERE target_id = $1`, [storeId]);
  await tx.query(
    `UPDATE stores SET status = 'redacted', name = NULL, updated_at = now() WHERE id = $1`,
    [storeId],
  );
  return counts;
}

export interface WorkspaceOverview {
  readonly tenant: { id: string; name: string; status: string };
  readonly stores: StoreRow[];
  readonly counts: {
    products: number;
    variants: number;
    locations: number;
    inventoryLevels: number;
  };
}

export async function getWorkspaceOverview(tx: Tx): Promise<WorkspaceOverview | null> {
  const tenant = (
    await tx.query<{ id: string; name: string; status: string }>(
      'SELECT id, name, status FROM tenants',
    )
  ).rows[0];
  if (!tenant) return null;
  const stores = (
    await tx.query<StoreRow>(
      'SELECT id, platform, domain, name, currency, status FROM stores ORDER BY created_at',
    )
  ).rows;
  const c = (
    await tx.query<{ products: bigint; variants: bigint; locations: bigint; levels: bigint }>(
      `SELECT (SELECT count(*) FROM products WHERE deleted_at IS NULL) AS products,
              (SELECT count(*) FROM variants WHERE deleted_at IS NULL) AS variants,
              (SELECT count(*) FROM locations) AS locations,
              (SELECT count(*) FROM inventory_levels) AS levels`,
    )
  ).rows[0];
  return {
    tenant,
    stores,
    counts: {
      products: Number(c?.products ?? 0n),
      variants: Number(c?.variants ?? 0n),
      locations: Number(c?.locations ?? 0n),
      inventoryLevels: Number(c?.levels ?? 0n),
    },
  };
}
