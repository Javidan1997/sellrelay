import { hostname } from 'node:os';
import type { Logger } from '@sellrelay/observability';
import { heartbeats, jobs } from '@sellrelay/persistence';
import { JobExecutor, type ExecutorDeps } from './executor.ts';

export interface WorkerOptions extends ExecutorDeps {
  readonly concurrency: number;
  readonly pollIntervalMs?: number;
  readonly perTenant?: number;
  readonly maxRunningPerTenant?: number;
  readonly maxRunningPerKey?: number;
  readonly kinds?: readonly string[];
}

/**
 * Claims jobs fairly from PostgreSQL with bounded concurrency. `stop()` drains in-flight jobs;
 * jobs still running at the drain deadline are aborted and released back to the queue.
 */
export class Worker {
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly executor: JobExecutor;
  private wake: (() => void) | null = null;
  private readonly startedAt = new Date();
  private status: 'running' | 'draining' | 'stopped' = 'stopped';

  private readonly opts: WorkerOptions;

  constructor(opts: WorkerOptions) {
    this.opts = opts;
    this.executor = new JobExecutor(opts);
  }

  get log(): Logger {
    return this.opts.log;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  get state(): 'running' | 'draining' | 'stopped' {
    return this.status;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.status = 'running';
    this.loopPromise = this.loop();
  }

  /** Poke the loop (e.g. after enqueueing locally) instead of waiting for the next poll. */
  nudge(): void {
    this.wake?.();
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
    this.wake = null;
  }

  private async loop(): Promise<void> {
    const { opts } = this;
    while (this.running) {
      const free = opts.concurrency - this.inFlight.size;
      if (free <= 0) {
        await Promise.race(this.inFlight);
        continue;
      }
      let claimed: Awaited<ReturnType<typeof jobs.claimJobs>>;
      try {
        claimed = await jobs.claimJobs(opts.pool, opts.workerId, {
          limit: free,
          leaseSeconds: opts.leaseSeconds,
          ...(opts.perTenant !== undefined ? { perTenant: opts.perTenant } : {}),
          ...(opts.maxRunningPerTenant !== undefined
            ? { maxRunningPerTenant: opts.maxRunningPerTenant }
            : {}),
          ...(opts.maxRunningPerKey !== undefined
            ? { maxRunningPerKey: opts.maxRunningPerKey }
            : {}),
          ...(opts.kinds ? { kinds: opts.kinds } : {}),
        });
      } catch (e) {
        opts.log.error({ err: e }, 'claim failed');
        await this.sleep(opts.pollIntervalMs ?? 1000);
        continue;
      }
      for (const job of claimed) {
        const p: Promise<unknown> = this.executor
          .execute(job)
          .catch((e) => opts.log.error({ err: e, job_id: job.id }, 'executor crashed'))
          .finally(() => {
            this.inFlight.delete(p);
            opts.metrics?.workerInFlight.set(this.inFlight.size);
          });
        this.inFlight.add(p);
      }
      opts.metrics?.workerInFlight.set(this.inFlight.size);
      if (claimed.length === 0) await this.sleep(opts.pollIntervalMs ?? 1000);
    }
  }

  async stop(drainTimeoutMs: number): Promise<{ drained: boolean }> {
    this.running = false;
    this.status = 'draining';
    this.wake?.();
    await this.loopPromise;
    const all = Promise.allSettled([...this.inFlight]);
    const timedOut = await Promise.race([
      all.then(() => false),
      new Promise<boolean>((r) => setTimeout(() => r(true), drainTimeoutMs)),
    ]);
    if (timedOut) {
      this.opts.log.warn(
        { in_flight: this.inFlight.size },
        'drain timeout; aborting and releasing remaining jobs',
      );
      this.executor.abortAll();
      await Promise.allSettled([...this.inFlight]);
    }
    this.status = 'stopped';
    return { drained: !timedOut };
  }

  async writeHeartbeat(): Promise<void> {
    await heartbeats.upsertHeartbeat(this.opts.pool, {
      workerId: this.opts.workerId,
      hostname: hostname(),
      startedAt: this.startedAt,
      status: this.status,
      inFlight: this.inFlight.size,
    });
  }
}
