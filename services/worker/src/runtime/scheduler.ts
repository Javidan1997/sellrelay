import pg from 'pg';
import type { Logger } from '@sellrelay/observability';

export interface ScheduledTask {
  readonly name: string;
  readonly intervalMs: number;
  /** Leader-only tasks run on exactly one worker at a time (PostgreSQL advisory lock). */
  readonly leaderOnly: boolean;
  run(): Promise<void>;
}

const LEADER_LOCK_KEY = 727_274_100;

/**
 * Periodic tasks. Leadership is a session-level advisory lock held on a dedicated connection;
 * if the connection drops, the lock is released and another worker takes over.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private leaderClient: pg.Client | null = null;
  private isLeader = false;
  private readonly lastRun = new Map<string, number>();
  private running = new Set<string>();

  private readonly connectionString: string;
  private readonly tasks: readonly ScheduledTask[];
  private readonly log: Logger;
  private readonly tickMs: number;

  constructor(
    connectionString: string,
    tasks: readonly ScheduledTask[],
    log: Logger,
    tickMs = 1000,
  ) {
    this.connectionString = connectionString;
    this.tasks = tasks;
    this.log = log;
    this.tickMs = tickMs;
  }

  get leader(): boolean {
    return this.isLeader;
  }

  private async ensureLeadership(): Promise<void> {
    try {
      if (!this.leaderClient) {
        const c = new pg.Client({
          connectionString: this.connectionString,
          application_name: 'sellrelay-scheduler',
        });
        c.on('error', () => {
          this.isLeader = false;
          this.leaderClient = null;
        });
        await c.connect();
        this.leaderClient = c;
      }
      if (!this.isLeader) {
        const r = await this.leaderClient.query<{ ok: boolean }>(
          'SELECT pg_try_advisory_lock($1) AS ok',
          [LEADER_LOCK_KEY],
        );
        this.isLeader = r.rows[0]?.ok ?? false;
        if (this.isLeader) this.log.info('scheduler leadership acquired');
      }
    } catch (e) {
      this.isLeader = false;
      this.log.warn({ err: e }, 'leader election failed');
    }
  }

  start(): void {
    const tick = async () => {
      await this.ensureLeadership();
      const now = Date.now();
      for (const task of this.tasks) {
        if (task.leaderOnly && !this.isLeader) continue;
        if (this.running.has(task.name)) continue;
        if (now - (this.lastRun.get(task.name) ?? 0) < task.intervalMs) continue;
        this.lastRun.set(task.name, now);
        this.running.add(task.name);
        task
          .run()
          .catch((e) => this.log.error({ err: e, task: task.name }, 'scheduled task failed'))
          .finally(() => this.running.delete(task.name));
      }
      this.timer = setTimeout(() => void tick(), this.tickMs);
    };
    void tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.leaderClient) {
      await this.leaderClient.end().catch(() => undefined);
      this.leaderClient = null;
    }
    this.isLeader = false;
  }
}
