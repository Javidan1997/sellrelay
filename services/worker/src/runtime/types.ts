import type { ProviderError } from '@sellrelay/core';
import type { Logger } from '@sellrelay/observability';
import type { JobRow, Tx } from '@sellrelay/persistence';

export interface JobContext {
  readonly job: JobRow;
  readonly tenantId: string;
  readonly workerId: string;
  /** Aborted on cancellation, lease loss or shutdown. Pass to every remote call. */
  readonly signal: AbortSignal;
  readonly log: Logger;
  /** Short tenant-scoped transaction. Never hold one open across a remote call. */
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export type JobOutcome =
  | {
      readonly type: 'done';
      readonly result?: Record<string, unknown>;
      readonly finalize?: (tx: Tx) => Promise<void>;
    }
  /** Multi-step job: re-queue at runAt with persisted progress, without consuming an attempt. */
  | { readonly type: 'continue'; readonly runAt: Date; readonly payload: Record<string, unknown> }
  | { readonly type: 'retry'; readonly error: ProviderError }
  | { readonly type: 'fail'; readonly error: ProviderError };

export type JobHandler = (ctx: JobContext) => Promise<JobOutcome>;

export class HandlerRegistry {
  private readonly handlers = new Map<string, JobHandler>();
  register(kind: string, handler: JobHandler): this {
    if (this.handlers.has(kind)) throw new Error(`Handler already registered for ${kind}`);
    this.handlers.set(kind, handler);
    return this;
  }
  get(kind: string): JobHandler | undefined {
    return this.handlers.get(kind);
  }
  kinds(): string[] {
    return [...this.handlers.keys()];
  }
}

export interface Alert {
  readonly severity: 'warning' | 'critical';
  readonly title: string;
  readonly tenantId?: string;
  readonly details?: Record<string, unknown>;
}

export interface AlertSink {
  notify(alert: Alert): Promise<void>;
}
