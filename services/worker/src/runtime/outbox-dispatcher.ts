import type pg from 'pg';
import type { Logger } from '@sellrelay/observability';
import { outbox, withTenant, type Tx } from '@sellrelay/persistence';
import type { OutboxRow } from '@sellrelay/persistence';

/**
 * Subscribers run inside the tenant transaction that marks the event dispatched. They may only
 * write local state (typically enqueue jobs with coalesce keys); never call remote APIs.
 * Delivery is at-least-once: a crash before commit re-delivers after the claim expires.
 */
export type OutboxSubscriber = (tx: Tx, event: OutboxRow) => Promise<void>;

export class OutboxDispatcher {
  private readonly subscribers = new Map<string, OutboxSubscriber[]>();

  private readonly pool: pg.Pool;
  private readonly workerId: string;
  private readonly log: Logger;
  private readonly claimSeconds: number;

  constructor(pool: pg.Pool, workerId: string, log: Logger, claimSeconds = 30) {
    this.pool = pool;
    this.workerId = workerId;
    this.log = log;
    this.claimSeconds = claimSeconds;
  }

  subscribe(eventType: string, sub: OutboxSubscriber): this {
    this.subscribers.set(eventType, [...(this.subscribers.get(eventType) ?? []), sub]);
    return this;
  }

  /** Dispatch one batch. Returns the number of events dispatched. */
  async tick(limit = 100): Promise<number> {
    const batch = await outbox.claimOutbox(this.pool, this.workerId, limit, this.claimSeconds);
    let dispatched = 0;
    for (const event of batch) {
      try {
        await withTenant(this.pool, event.tenant_id, async (tx) => {
          for (const sub of this.subscribers.get(event.event_type) ?? []) await sub(tx, event);
          if (await outbox.markOutboxDispatched(tx, event.id, this.workerId)) dispatched++;
        });
      } catch (e) {
        this.log.error(
          { err: e, event_type: event.event_type, outbox_id: event.id },
          'outbox dispatch failed; will retry after claim expiry',
        );
      }
    }
    return dispatched;
  }
}
