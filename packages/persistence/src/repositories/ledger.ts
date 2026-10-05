import { createHash } from 'node:crypto';
import type { Tx } from '../db.ts';

export type LedgerStatus = 'pending' | 'sent' | 'succeeded' | 'failed' | 'unknown';

export interface LedgerEntry {
  readonly id: string;
  readonly status: LedgerStatus;
  readonly external_ref: string | null;
  readonly attempts: number;
  readonly request_hash: string;
}

export function hashRequest(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

/**
 * Persist intent BEFORE any external write. Returns the existing entry if this idempotency key
 * was already recorded (so callers can short-circuit on `succeeded` or reconcile on `unknown`).
 */
export async function beginOperation(
  tx: Tx,
  op: {
    targetKind: 'store' | 'channel' | 'crm';
    targetId: string;
    operation: string;
    idempotencyKey: string;
    request: unknown;
    jobId?: string;
  },
): Promise<{ entry: LedgerEntry; created: boolean }> {
  const requestHash = hashRequest(op.request);
  const r = await tx.query<LedgerEntry & { created: boolean }>(
    `INSERT INTO operation_ledger (tenant_id, target_kind, target_id, operation, idempotency_key, request_hash, status, job_id)
     VALUES (app_current_tenant(), $1, $2, $3, $4, $5, 'pending', $6)
     ON CONFLICT (tenant_id, target_id, operation, idempotency_key) DO UPDATE SET updated_at = operation_ledger.updated_at
     RETURNING id, status, external_ref, attempts, request_hash, (xmax = 0) AS created`,
    [op.targetKind, op.targetId, op.operation, op.idempotencyKey, requestHash, op.jobId ?? null],
  );
  const row = r.rows[0]!;
  if (!row.created && row.request_hash !== requestHash) {
    throw new Error(`Idempotency key reused with a different request for ${op.operation}`);
  }
  return { entry: row, created: row.created };
}

/** Mark that the request is about to leave (committed before the HTTP call). */
export async function markOperationSent(tx: Tx, id: string): Promise<void> {
  await tx.query(
    `UPDATE operation_ledger SET status = 'sent', attempts = attempts + 1, updated_at = now() WHERE id = $1`,
    [id],
  );
}

export async function recordOperationOutcome(
  tx: Tx,
  id: string,
  outcome: {
    status: 'succeeded' | 'failed' | 'unknown';
    externalRef?: string;
    error?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.query(
    `UPDATE operation_ledger SET status = $2, external_ref = COALESCE($3, external_ref), last_error = $4, updated_at = now() WHERE id = $1`,
    [id, outcome.status, outcome.externalRef ?? null, outcome.error ?? null],
  );
}

export async function getOperation(tx: Tx, id: string): Promise<LedgerEntry | null> {
  return (
    (
      await tx.query<LedgerEntry>(
        'SELECT id, status, external_ref, attempts, request_hash FROM operation_ledger WHERE id = $1',
        [id],
      )
    ).rows[0] ?? null
  );
}
