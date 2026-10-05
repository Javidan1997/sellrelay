import type pg from 'pg';
import type { DomainEvent } from '@sellrelay/core';
import type { Tx } from '../db.ts';
import { withSystemTx } from '../db.ts';

/** Append domain events in the same transaction as the state change that produced them. */
export async function appendOutbox(
  tx: Tx,
  events: readonly Omit<DomainEvent, 'id' | 'occurredAt'>[],
): Promise<void> {
  if (events.length === 0) return;
  await tx.query(
    `INSERT INTO outbox (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, correlation_id)
     SELECT x.tenant_id, x.type, x.aggregate_type, x.aggregate_id, x.aggregate_version, x.payload, x.correlation_id
     FROM jsonb_to_recordset($1::jsonb) AS x(tenant_id uuid, type text, aggregate_type text, aggregate_id text,
                                           aggregate_version text, payload jsonb, correlation_id text)`,
    [
      JSON.stringify(
        events.map((e) => ({
          tenant_id: e.tenantId,
          type: e.type,
          aggregate_type: e.aggregateType,
          aggregate_id: e.aggregateId,
          aggregate_version: e.aggregateVersion,
          payload: e.payload,
          correlation_id: e.correlationId ?? null,
        })),
      ),
    ],
  );
}

export interface OutboxRow {
  readonly tenant_id: string;
  readonly id: string;
  readonly event_type: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly aggregate_version: string;
  readonly payload: Record<string, unknown>;
  readonly correlation_id: string | null;
  readonly occurred_at: Date;
  readonly attempts: number;
}

export async function claimOutbox(
  pool: pg.Pool,
  workerId: string,
  limit: number,
  leaseSeconds: number,
): Promise<OutboxRow[]> {
  return withSystemTx(
    pool,
    async (tx) =>
      (
        await tx.query<OutboxRow>('SELECT * FROM claim_outbox($1, $2, $3)', [
          workerId,
          limit,
          leaseSeconds,
        ])
      ).rows,
  );
}

export async function markOutboxDispatched(tx: Tx, id: string, workerId: string): Promise<boolean> {
  const r = await tx.query(
    `UPDATE outbox SET dispatched_at = now(), claimed_by = NULL, claim_expires_at = NULL
     WHERE id = $1 AND claimed_by = $2 AND dispatched_at IS NULL`,
    [id, workerId],
  );
  return r.rowCount === 1;
}
