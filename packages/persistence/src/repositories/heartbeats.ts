import type pg from 'pg';

/** worker_heartbeats is a system table (not tenant-owned); only the worker role writes it. */
export async function upsertHeartbeat(
  pool: pg.Pool,
  hb: {
    workerId: string;
    hostname: string;
    startedAt: Date;
    status: 'running' | 'draining' | 'stopped';
    inFlight: number;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO worker_heartbeats (worker_id, hostname, started_at, last_seen_at, status, in_flight)
     VALUES ($1, $2, $3, now(), $4, $5)
     ON CONFLICT (worker_id) DO UPDATE SET last_seen_at = now(), status = EXCLUDED.status, in_flight = EXCLUDED.in_flight`,
    [hb.workerId, hb.hostname, hb.startedAt, hb.status, hb.inFlight],
  );
}
