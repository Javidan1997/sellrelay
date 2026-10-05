import type pg from 'pg';
import {
  computeBackoffMs,
  DEFAULT_BACKOFF,
  ProviderFailure,
  type BackoffPolicy,
  type ProviderError,
} from '@sellrelay/core';
import { runWithContext, redact, type Logger, type Metrics } from '@sellrelay/observability';
import { jobs, LeaseLostError, withTenant, type JobRow } from '@sellrelay/persistence';
import type { AlertSink, HandlerRegistry, JobContext, JobOutcome } from './types.ts';

export type ExecutionResult =
  'succeeded' | 'continued' | 'retry' | 'dead' | 'cancelled' | 'released' | 'lease_lost';

export interface ExecutorDeps {
  readonly pool: pg.Pool;
  readonly workerId: string;
  readonly handlers: HandlerRegistry;
  readonly log: Logger;
  readonly leaseSeconds: number;
  readonly backoff?: BackoffPolicy;
  readonly metrics?: Metrics;
  readonly alerts?: AlertSink;
}

class AbortReason extends Error {
  readonly kind: 'cancelled' | 'lease_lost' | 'shutdown';

  constructor(kind: 'cancelled' | 'lease_lost' | 'shutdown') {
    super(kind);
    this.kind = kind;
  }
}

function toProviderError(e: unknown): { error: ProviderError; retryable: boolean } {
  if (e instanceof ProviderFailure) return { error: e.error, retryable: e.retryable };
  const message = e instanceof Error ? e.message : String(e);
  // Unknown exceptions are treated as transient and bounded by max_attempts.
  return {
    error: { code: 'transient', message: String(redact(message)).slice(0, 500) },
    retryable: true,
  };
}

export class JobExecutor {
  private readonly controllers = new Map<string, AbortController>();

  private readonly deps: ExecutorDeps;

  constructor(deps: ExecutorDeps) {
    this.deps = deps;
  }

  /** Abort every running job (graceful shutdown timeout). Jobs are released back to the queue. */
  abortAll(): void {
    for (const c of this.controllers.values()) c.abort(new AbortReason('shutdown'));
  }

  async execute(job: JobRow): Promise<ExecutionResult> {
    const { deps } = this;
    const started = Date.now();
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    const tenantTx = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
      withTenant(deps.pool, job.tenant_id, fn);

    const heartbeat = setInterval(
      () => {
        tenantTx((tx) => jobs.renewLease(tx, job.id, deps.workerId, deps.leaseSeconds))
          .then((r) => {
            if (!r.held) controller.abort(new AbortReason('lease_lost'));
            else if (r.cancelRequested) controller.abort(new AbortReason('cancelled'));
          })
          .catch((e) => deps.log.warn({ err: e }, 'lease renewal failed'));
      },
      Math.max(500, (deps.leaseSeconds * 1000) / 3),
    );

    const ctx = {
      correlationId: job.correlation_id ?? job.id,
      tenantId: job.tenant_id,
      jobId: job.id,
      jobKind: job.kind,
      ...(job.store_id ? { storeId: job.store_id } : {}),
      ...(job.connection_id ? { connectionId: job.connection_id } : {}),
    };

    return runWithContext(ctx, async () => {
      let result: ExecutionResult;
      try {
        result = await this.run(job, controller, tenantTx);
      } finally {
        clearInterval(heartbeat);
        this.controllers.delete(job.id);
      }
      deps.metrics?.jobDuration.observe(
        { kind: job.kind, outcome: result },
        (Date.now() - started) / 1000,
      );
      return result;
    });
  }

  private async run(
    job: JobRow,
    controller: AbortController,
    tenantTx: <T>(fn: Parameters<typeof withTenant<T>>[2]) => Promise<T>,
  ): Promise<ExecutionResult> {
    const { deps } = this;
    const handler = deps.handlers.get(job.kind);
    try {
      if (job.cancel_requested) {
        await tenantTx((tx) =>
          jobs.cancelRunningJob(tx, job.id, deps.workerId, 'cancel requested'),
        );
        return 'cancelled';
      }
      if (!handler) {
        return await this.deadLetter(
          job,
          { code: 'permanent', message: `No handler registered for ${job.kind}` },
          tenantTx,
        );
      }
      const ctx: JobContext = {
        job,
        tenantId: job.tenant_id,
        workerId: deps.workerId,
        signal: controller.signal,
        log: deps.log.child({ job_id: job.id, job_kind: job.kind }),
        tx: tenantTx,
      };
      const outcome: JobOutcome = await handler(ctx);
      if (controller.signal.aborted) throw controller.signal.reason;
      return await this.applyOutcome(job, outcome, tenantTx);
    } catch (e) {
      const reason = controller.signal.aborted ? controller.signal.reason : e;
      if (reason instanceof AbortReason) {
        if (reason.kind === 'cancelled') {
          await tenantTx((tx) =>
            jobs.cancelRunningJob(tx, job.id, deps.workerId, 'cancelled while running'),
          ).catch(() => undefined);
          return 'cancelled';
        }
        if (reason.kind === 'shutdown') {
          await tenantTx((tx) => jobs.releaseJob(tx, job.id, deps.workerId)).catch(() => undefined);
          return 'released';
        }
        deps.log.warn({ job_id: job.id }, 'lease lost; another worker owns the job');
        return 'lease_lost';
      }
      if (e instanceof LeaseLostError) {
        deps.log.warn({ job_id: job.id }, 'lease lost before completion (fenced)');
        return 'lease_lost';
      }
      const { error, retryable } = toProviderError(e);
      deps.log.warn({ job_id: job.id, code: error.code, msg: error.message }, 'job attempt failed');
      try {
        return retryable
          ? await this.retry(job, error, tenantTx)
          : await this.deadLetter(job, error, tenantTx);
      } catch (inner) {
        if (inner instanceof LeaseLostError) return 'lease_lost';
        throw inner;
      }
    }
  }

  private async applyOutcome(
    job: JobRow,
    outcome: JobOutcome,
    tenantTx: <T>(fn: Parameters<typeof withTenant<T>>[2]) => Promise<T>,
  ): Promise<ExecutionResult> {
    const { deps } = this;
    switch (outcome.type) {
      case 'done':
        await tenantTx(async (tx) => {
          await outcome.finalize?.(tx);
          await jobs.completeJob(tx, job.id, deps.workerId, outcome.result ?? {});
        });
        return 'succeeded';
      case 'continue':
        await tenantTx((tx) =>
          jobs.continueJobLater(tx, job.id, deps.workerId, outcome.runAt, outcome.payload),
        );
        return 'continued';
      case 'retry':
        return this.retry(job, outcome.error, tenantTx);
      case 'fail':
        return this.deadLetter(job, outcome.error, tenantTx);
    }
  }

  private async retry(
    job: JobRow,
    error: ProviderError,
    tenantTx: <T>(fn: Parameters<typeof withTenant<T>>[2]) => Promise<T>,
  ): Promise<ExecutionResult> {
    if (job.attempts >= job.max_attempts) return this.deadLetter(job, error, tenantTx);
    const delay = computeBackoffMs(
      job.attempts,
      this.deps.backoff ?? DEFAULT_BACKOFF,
      error.retryAfterMs,
    );
    await tenantTx((tx) =>
      jobs.retryJob(
        tx,
        job.id,
        this.deps.workerId,
        { ...error, attempt: job.attempts },
        new Date(Date.now() + delay),
      ),
    );
    this.deps.metrics?.jobRetries.inc({ kind: job.kind, code: error.code });
    return 'retry';
  }

  private async deadLetter(
    job: JobRow,
    error: ProviderError,
    tenantTx: <T>(fn: Parameters<typeof withTenant<T>>[2]) => Promise<T>,
  ): Promise<ExecutionResult> {
    await tenantTx(async (tx) => {
      await jobs.deadLetterJob(tx, job.id, this.deps.workerId, { ...error, attempt: job.attempts });
      await tx.query(
        `INSERT INTO activity_log (tenant_id, category, severity, message, details, job_id, store_id, connection_id)
         VALUES (app_current_tenant(), 'jobs', 'error', $1, $2, $3, $4, $5)`,
        [
          `Job ${job.kind} moved to dead-letter after ${job.attempts} attempt(s)`,
          { code: error.code, message: error.message },
          job.id,
          job.store_id,
          job.connection_id,
        ],
      );
    });
    await this.deps.alerts
      ?.notify({
        severity: 'warning',
        title: `Dead-lettered job: ${job.kind}`,
        tenantId: job.tenant_id,
        details: { jobId: job.id, code: error.code },
      })
      .catch((e) => this.deps.log.warn({ err: e }, 'alert delivery failed'));
    return 'dead';
  }
}
