import type pg from 'pg';
import type { Tx } from '../db.ts';
import { withSystemTx } from '../db.ts';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead' | 'cancelled';

export interface JobRow {
  readonly tenant_id: string;
  readonly id: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly status: JobStatus;
  readonly priority: number;
  readonly run_at: Date;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly store_id: string | null;
  readonly connection_id: string | null;
  readonly concurrency_key: string | null;
  readonly entity_key: string | null;
  readonly entity_version: string | null;
  readonly coalesce_key: string | null;
  readonly lease_owner: string | null;
  readonly lease_expires_at: Date | null;
  readonly cancel_requested: boolean;
  readonly last_error: Record<string, unknown> | null;
  readonly result: Record<string, unknown> | null;
  readonly correlation_id: string | null;
  readonly replay_of: string | null;
  readonly created_at: Date;
  readonly started_at: Date | null;
  readonly finished_at: Date | null;
}

export interface EnqueueJob {
  readonly tenantId: string;
  readonly kind: string;
  readonly payload?: Record<string, unknown>;
  readonly priority?: number;
  readonly runAt?: Date;
  readonly maxAttempts?: number;
  readonly storeId?: string;
  readonly connectionId?: string;
  /** Shared concurrency bucket, e.g. `store:<id>` or `conn:<id>` (bounded concurrency per connection). */
  readonly concurrencyKey?: string;
  /** Serializes jobs touching one entity (e.g. `variant:<id>@conn:<id>`). */
  readonly entityKey?: string;
  /** Integer version (e.g. source epoch ms). Newer queued updates replace older ones. */
  readonly entityVersion?: string;
  /** Queued jobs with the same key are coalesced into one (latest payload wins if newer). */
  readonly coalesceKey?: string;
  readonly correlationId?: string;
}

export interface EnqueueResult {
  readonly id: string;
  /** True when an existing queued job absorbed this request. */
  readonly coalesced: boolean;
}

/**
 * Enqueue inside the caller's transaction (transactional with inbox/outbox/domain writes).
 * Coalescing: if a queued job with the same coalesce key exists, its payload/version is replaced
 * only when the new version is newer; obsolete stock/price updates are therefore never sent.
 */
export async function enqueueJob(tx: Tx, job: EnqueueJob): Promise<EnqueueResult> {
  const res = await tx.query<{ id: string; coalesced: boolean }>(
    `INSERT INTO jobs (tenant_id, kind, payload, priority, run_at, max_attempts, store_id, connection_id,
                       concurrency_key, entity_key, entity_version, coalesce_key, correlation_id)
     VALUES ($1, $2, $3, $4, COALESCE($5, now()), $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (tenant_id, coalesce_key) WHERE status = 'queued' AND coalesce_key IS NOT NULL
     DO UPDATE SET
       payload = CASE WHEN jobs.entity_version IS NULL OR EXCLUDED.entity_version IS NULL
                        OR EXCLUDED.entity_version::numeric >= jobs.entity_version::numeric
                      THEN EXCLUDED.payload ELSE jobs.payload END,
       entity_version = CASE WHEN jobs.entity_version IS NULL OR EXCLUDED.entity_version IS NULL
                        OR EXCLUDED.entity_version::numeric >= jobs.entity_version::numeric
                      THEN EXCLUDED.entity_version ELSE jobs.entity_version END,
       run_at = LEAST(jobs.run_at, EXCLUDED.run_at),
       priority = GREATEST(jobs.priority, EXCLUDED.priority),
       updated_at = now()
     RETURNING id, (xmax <> 0) AS coalesced`,
    [
      job.tenantId,
      job.kind,
      job.payload ?? {},
      job.priority ?? 0,
      job.runAt ?? null,
      job.maxAttempts ?? 10,
      job.storeId ?? null,
      job.connectionId ?? null,
      job.concurrencyKey ?? null,
      job.entityKey ?? null,
      job.entityVersion ?? null,
      job.coalesceKey ?? null,
      job.correlationId ?? null,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('enqueueJob returned no row');
  return { id: row.id, coalesced: row.coalesced };
}

export interface ClaimOptions {
  readonly limit: number;
  readonly leaseSeconds: number;
  readonly perTenant?: number;
  readonly maxRunningPerTenant?: number;
  readonly maxRunningPerKey?: number;
  readonly kinds?: readonly string[];
}

export async function claimJobs(
  pool: pg.Pool,
  workerId: string,
  opts: ClaimOptions,
): Promise<JobRow[]> {
  return withSystemTx(
    pool,
    async (tx) =>
      (
        await tx.query<JobRow>('SELECT * FROM claim_jobs($1, $2, $3, $4, $5, $6, $7)', [
          workerId,
          opts.limit,
          opts.leaseSeconds,
          opts.perTenant ?? 2,
          opts.maxRunningPerTenant ?? 8,
          opts.maxRunningPerKey ?? 4,
          opts.kinds ?? null,
        ])
      ).rows,
  );
}

export async function reclaimExpiredLeases(pool: pg.Pool, limit = 500): Promise<number> {
  return withSystemTx(pool, async (tx) => {
    const r = await tx.query<{ n: number }>('SELECT reclaim_expired_leases($1) AS n', [limit]);
    return r.rows[0]?.n ?? 0;
  });
}

/** Extends the lease. Returns false if the lease was lost (fencing); reports cancellation requests. */
export async function renewLease(
  tx: Tx,
  jobId: string,
  workerId: string,
  leaseSeconds: number,
): Promise<{ held: boolean; cancelRequested: boolean }> {
  const r = await tx.query<{ cancel_requested: boolean }>(
    `UPDATE jobs SET lease_expires_at = now() + make_interval(secs => $3), updated_at = now()
     WHERE id = $1 AND lease_owner = $2 AND status = 'running'
     RETURNING cancel_requested`,
    [jobId, workerId, leaseSeconds],
  );
  const row = r.rows[0];
  return row
    ? { held: true, cancelRequested: row.cancel_requested }
    : { held: false, cancelRequested: false };
}

export class LeaseLostError extends Error {
  constructor(jobId: string) {
    super(`Lease for job ${jobId} is no longer held by this worker`);
    this.name = 'LeaseLostError';
  }
}

async function finish(
  tx: Tx,
  jobId: string,
  workerId: string,
  setSql: string,
  params: unknown[],
): Promise<void> {
  const r = await tx.query(
    `UPDATE jobs SET ${setSql}, lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
    [jobId, workerId, ...params],
  );
  if (r.rowCount !== 1) throw new LeaseLostError(jobId);
}

export function completeJob(
  tx: Tx,
  jobId: string,
  workerId: string,
  result: Record<string, unknown> = {},
): Promise<void> {
  return finish(tx, jobId, workerId, `status = 'succeeded', result = $3, finished_at = now()`, [
    result,
  ]);
}

export function retryJob(
  tx: Tx,
  jobId: string,
  workerId: string,
  error: Record<string, unknown>,
  runAt: Date,
): Promise<void> {
  return finish(tx, jobId, workerId, `status = 'queued', last_error = $3, run_at = $4`, [
    error,
    runAt,
  ]);
}

export function deadLetterJob(
  tx: Tx,
  jobId: string,
  workerId: string,
  error: Record<string, unknown>,
): Promise<void> {
  return finish(tx, jobId, workerId, `status = 'dead', last_error = $3, finished_at = now()`, [
    error,
  ]);
}

export function cancelRunningJob(
  tx: Tx,
  jobId: string,
  workerId: string,
  reason: string,
): Promise<void> {
  return finish(tx, jobId, workerId, `status = 'cancelled', last_error = $3, finished_at = now()`, [
    { code: 'cancelled', message: reason },
  ]);
}

/**
 * Re-queue a multi-step job (e.g. polling a bulk export) without consuming a retry attempt.
 * The payload is replaced so state machines can persist their progress.
 */
export function continueJobLater(
  tx: Tx,
  jobId: string,
  workerId: string,
  runAt: Date,
  payload: Record<string, unknown>,
): Promise<void> {
  return finish(
    tx,
    jobId,
    workerId,
    `status = 'queued', run_at = $3, payload = $4, attempts = GREATEST(attempts - 1, 0)`,
    [runAt, payload],
  );
}

/** Cancels pending work for a store and/or connection (uninstall, disconnect, disable). */
export async function cancelJobsForScope(
  tx: Tx,
  scope: { storeId?: string; connectionIds?: readonly string[] },
  reason: string,
): Promise<{ cancelled: number; cancelRequested: number }> {
  const params = [
    scope.storeId ?? null,
    scope.connectionIds ?? [],
    { code: 'cancelled', message: reason },
  ];
  const queued = await tx.query(
    `UPDATE jobs SET status = 'cancelled', last_error = $3, finished_at = now(), updated_at = now()
     WHERE status = 'queued' AND (store_id = $1 OR connection_id = ANY ($2::uuid[]))`,
    params,
  );
  const running = await tx.query(
    `UPDATE jobs SET cancel_requested = true, updated_at = now()
     WHERE status = 'running' AND (store_id = $1 OR connection_id = ANY ($2::uuid[]))`,
    params.slice(0, 2),
  );
  return { cancelled: queued.rowCount ?? 0, cancelRequested: running.rowCount ?? 0 };
}

export async function getJob(tx: Tx, jobId: string): Promise<JobRow | null> {
  return (await tx.query<JobRow>('SELECT * FROM jobs WHERE id = $1', [jobId])).rows[0] ?? null;
}

export async function listJobs(
  tx: Tx,
  opts: { status?: JobStatus; limit: number },
): Promise<JobRow[]> {
  return (
    await tx.query<JobRow>(
      `SELECT * FROM jobs WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC LIMIT $2`,
      [opts.status ?? null, opts.limit],
    )
  ).rows;
}

export async function replayJob(
  tx: Tx,
  tenantId: string,
  jobId: string,
  actor: string,
  reason: string,
): Promise<string> {
  const r = await tx.query<{ id: string }>('SELECT replay_job($1, $2, $3, $4) AS id', [
    tenantId,
    jobId,
    actor,
    reason,
  ]);
  const id = r.rows[0]?.id;
  if (!id) throw new Error('replay failed');
  return id;
}

export interface QueueStat {
  readonly kind: string;
  readonly status: string;
  readonly jobs: bigint;
  readonly oldest_age_seconds: number;
}

export async function queueStats(
  pool: pg.Pool,
): Promise<{ jobs: QueueStat[]; outboxPending: number; outboxOldestAgeSeconds: number }> {
  return withSystemTx(pool, async (tx) => {
    const jobs = (await tx.query<QueueStat>('SELECT * FROM queue_stats()')).rows;
    const o = (
      await tx.query<{ pending: bigint; oldest_age_seconds: number }>(
        'SELECT * FROM outbox_stats()',
      )
    ).rows[0];
    return {
      jobs,
      outboxPending: Number(o?.pending ?? 0n),
      outboxOldestAgeSeconds: o?.oldest_age_seconds ?? 0,
    };
  });
}

/** Graceful shutdown: hand the job back without consuming an attempt. */
export function releaseJob(tx: Tx, jobId: string, workerId: string): Promise<void> {
  return finish(
    tx,
    jobId,
    workerId,
    `status = 'queued', run_at = now(), attempts = GREATEST(attempts - 1, 0)`,
    [],
  );
}
