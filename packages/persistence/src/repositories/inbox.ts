import type { Tx } from '../db.ts';

export interface InboxInsert {
  readonly tenantId: string;
  readonly source: string;
  readonly installationId: string;
  readonly topic: string;
  /** Provider event id when available, else delivery id, else a body hash. */
  readonly dedupeKey: string;
  readonly providerEventId?: string;
  readonly providerDeliveryId?: string;
  readonly apiVersion?: string;
  readonly triggeredAt?: string;
  readonly payload: unknown;
}

export interface InboxInsertResult {
  readonly id: string;
  readonly duplicate: boolean;
  readonly status: string;
}

/** Durable, idempotent insert. A unique constraint rejects duplicate provider events. */
export async function insertInboxEvent(tx: Tx, e: InboxInsert): Promise<InboxInsertResult> {
  const r = await tx.query<{ id: string; duplicate: boolean; status: string }>(
    `INSERT INTO webhook_inbox (tenant_id, source, installation_id, topic, dedupe_key, provider_event_id,
                                provider_delivery_id, api_version, triggered_at, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (tenant_id, source, installation_id, topic, dedupe_key)
     DO UPDATE SET duplicate_count = webhook_inbox.duplicate_count + 1
     RETURNING id, (xmax <> 0) AS duplicate, status`,
    [
      e.tenantId,
      e.source,
      e.installationId,
      e.topic,
      e.dedupeKey,
      e.providerEventId ?? null,
      e.providerDeliveryId ?? null,
      e.apiVersion ?? null,
      e.triggeredAt ?? null,
      JSON.stringify(e.payload ?? null),
    ],
  );
  const row = r.rows[0];
  if (!row) throw new Error('inbox insert returned no row');
  return row;
}

export interface InboxRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly source: string;
  readonly installation_id: string;
  readonly topic: string;
  readonly payload: unknown;
  readonly status: string;
  readonly triggered_at: Date | null;
  readonly received_at: Date;
  readonly api_version: string | null;
}

export async function getInboxEvent(tx: Tx, id: string): Promise<InboxRow | null> {
  return (
    (await tx.query<InboxRow>('SELECT * FROM webhook_inbox WHERE id = $1', [id])).rows[0] ?? null
  );
}

export async function markInboxProcessed(
  tx: Tx,
  id: string,
  status: 'processed' | 'ignored' = 'processed',
): Promise<void> {
  await tx.query(
    `UPDATE webhook_inbox SET status = $2, processed_at = now(), last_error = NULL WHERE id = $1`,
    [id, status],
  );
}

export async function markInboxFailed(tx: Tx, id: string, error: string): Promise<void> {
  await tx.query(`UPDATE webhook_inbox SET status = 'failed', last_error = $2 WHERE id = $1`, [
    id,
    error.slice(0, 2000),
  ]);
}
