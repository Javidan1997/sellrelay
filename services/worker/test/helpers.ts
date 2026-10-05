import { randomUUID } from 'node:crypto';
import { createLogger } from '../../../packages/observability/src/index.ts';
import { HandlerRegistry, type JobHandler } from '../src/runtime/types.ts';
import { Worker } from '../src/runtime/worker.ts';
import type pg from 'pg';

export const silentLog = createLogger('test', { level: process.env['TEST_LOG_LEVEL'] ?? 'silent' });

export function uniqueKind(prefix: string): string {
  return `${prefix}.${randomUUID().slice(0, 8)}`;
}

export function makeWorker(
  pool: pg.Pool,
  handlers: Record<string, JobHandler>,
  opts: Partial<ConstructorParameters<typeof Worker>[0]> = {},
): Worker {
  const reg = new HandlerRegistry();
  for (const [k, h] of Object.entries(handlers)) reg.register(k, h);
  return new Worker({
    pool,
    workerId: `test-${randomUUID().slice(0, 6)}`,
    handlers: reg,
    log: silentLog,
    leaseSeconds: 5,
    concurrency: 4,
    pollIntervalMs: 50,
    backoff: { baseMs: 10, maxMs: 50 },
    kinds: Object.keys(handlers),
    ...opts,
  });
}

export async function waitFor(
  cond: () => Promise<boolean>,
  timeoutMs = 10_000,
  stepMs = 50,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('waitFor timed out');
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
