import type { Tx } from '../db.ts';

/** Opaque encrypted envelope produced by packages/security. Plaintext never touches this layer. */
export type CredentialEnvelope = Record<string, unknown>;

export interface CredentialRow {
  readonly id: string;
  readonly owner_kind: 'installation' | 'connection';
  readonly owner_id: string;
  readonly kind: string;
  readonly envelope: CredentialEnvelope;
  readonly key_id: string;
  readonly access_expires_at: Date | null;
  readonly refresh_expires_at: Date | null;
  readonly refresh_lock_owner: string | null;
  readonly refresh_lock_until: Date | null;
  readonly version: number;
}

export interface CredentialWrite {
  readonly ownerKind: 'installation' | 'connection';
  readonly ownerId: string;
  readonly kind: string;
  readonly envelope: CredentialEnvelope;
  readonly keyId: string;
  readonly accessExpiresAt: Date | null;
  readonly refreshExpiresAt: Date | null;
}

export async function upsertCredential(tx: Tx, c: CredentialWrite): Promise<string> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO credentials (tenant_id, owner_kind, owner_id, kind, envelope, key_id, access_expires_at, refresh_expires_at)
     VALUES (app_current_tenant(), $1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, owner_kind, owner_id, kind) DO UPDATE SET
       envelope = EXCLUDED.envelope, key_id = EXCLUDED.key_id, access_expires_at = EXCLUDED.access_expires_at,
       refresh_expires_at = EXCLUDED.refresh_expires_at, refresh_lock_owner = NULL, refresh_lock_until = NULL,
       version = credentials.version + 1, updated_at = now()
     RETURNING id`,
    [c.ownerKind, c.ownerId, c.kind, c.envelope, c.keyId, c.accessExpiresAt, c.refreshExpiresAt],
  );
  return r.rows[0]!.id;
}

export async function getCredential(
  tx: Tx,
  ownerKind: string,
  ownerId: string,
  kind: string,
): Promise<CredentialRow | null> {
  return (
    (
      await tx.query<CredentialRow>(
        'SELECT * FROM credentials WHERE owner_kind = $1 AND owner_id = $2 AND kind = $3',
        [ownerKind, ownerId, kind],
      )
    ).rows[0] ?? null
  );
}

export async function getCredentialById(tx: Tx, id: string): Promise<CredentialRow | null> {
  return (
    (await tx.query<CredentialRow>('SELECT * FROM credentials WHERE id = $1', [id])).rows[0] ?? null
  );
}

/**
 * Concurrent-refresh protection: exactly one caller wins a short lock. Others wait and re-read.
 * The lock is a row lease (not a held transaction) so the refresh HTTP call happens outside any tx.
 */
export async function tryAcquireRefreshLock(
  tx: Tx,
  credentialId: string,
  owner: string,
  seconds: number,
): Promise<CredentialRow | null> {
  return (
    (
      await tx.query<CredentialRow>(
        `UPDATE credentials SET refresh_lock_owner = $2, refresh_lock_until = now() + make_interval(secs => $3)
         WHERE id = $1 AND (refresh_lock_until IS NULL OR refresh_lock_until < now() OR refresh_lock_owner = $2)
         RETURNING *`,
        [credentialId, owner, seconds],
      )
    ).rows[0] ?? null
  );
}

/** Stores refreshed tokens only if this caller still holds the lock and the version is unchanged. */
export async function storeRefreshedCredential(
  tx: Tx,
  credentialId: string,
  owner: string,
  expectedVersion: number,
  c: Pick<CredentialWrite, 'envelope' | 'keyId' | 'accessExpiresAt' | 'refreshExpiresAt'>,
): Promise<boolean> {
  const r = await tx.query(
    `UPDATE credentials SET envelope = $4, key_id = $5, access_expires_at = $6, refresh_expires_at = $7,
       refresh_lock_owner = NULL, refresh_lock_until = NULL, version = version + 1, updated_at = now()
     WHERE id = $1 AND refresh_lock_owner = $2 AND version = $3`,
    [
      credentialId,
      owner,
      expectedVersion,
      c.envelope,
      c.keyId,
      c.accessExpiresAt,
      c.refreshExpiresAt,
    ],
  );
  return r.rowCount === 1;
}

export async function releaseRefreshLock(
  tx: Tx,
  credentialId: string,
  owner: string,
): Promise<void> {
  await tx.query(
    `UPDATE credentials SET refresh_lock_owner = NULL, refresh_lock_until = NULL WHERE id = $1 AND refresh_lock_owner = $2`,
    [credentialId, owner],
  );
}

export async function deleteCredential(tx: Tx, credentialId: string): Promise<void> {
  await tx.query('DELETE FROM credentials WHERE id = $1', [credentialId]);
}
