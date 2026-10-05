import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProviderFailure } from '../../../packages/core/src/index.ts';
import {
  inbox,
  jobs,
  LeaseLostError,
  outbox,
  repo,
  withTenant,
} from '../../../packages/persistence/src/index.ts';
import {
  createTestPools,
  provisionTenant,
  type TestPools,
} from '../../../tests/integration/helpers.ts';
import { URLS } from '../../../tests/integration/env.ts';
import { OutboxDispatcher } from '../src/runtime/outbox-dispatcher.ts';
import { makeWorker, silentLog, sleep, uniqueKind, waitFor } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));

describe('durable queue, inbox and outbox', () => {
  let pools: TestPools;
  let T: Awaited<ReturnType<typeof provisionTenant>>;
  let U: Awaited<ReturnType<typeof provisionTenant>>;

  beforeAll(async () => {
    pools = createTestPools();
    T = await provisionTenant(pools.api);
    U = await provisionTenant(pools.api);
  });
  afterAll(async () => {
    await pools.end();
  });

  const job = (id: string) => withTenant(pools.worker, T.tenantId, (tx) => jobs.getJob(tx, id));

  it('deduplicates webhook deliveries, including concurrent duplicates, and enqueues once', async () => {
    const kind = uniqueKind('inbox');
    const receive = () =>
      withTenant(pools.api, T.tenantId, async (tx) => {
        const r = await inbox.insertInboxEvent(tx, {
          tenantId: T.tenantId,
          source: 'shopify',
          installationId: T.installationId,
          topic: 'products/update',
          dedupeKey: 'event-123',
          providerEventId: 'event-123',
          payload: { id: 1 },
        });
        if (!r.duplicate)
          await jobs.enqueueJob(tx, { tenantId: T.tenantId, kind, payload: { inboxId: r.id } });
        return r;
      });
    const results = await Promise.allSettled([receive(), receive(), receive()]);
    // Concurrent inserts serialize on the unique constraint; every delivery is acknowledged.
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    await receive();
    const rows = await withTenant(pools.api, T.tenantId, (tx) =>
      tx.query(`SELECT duplicate_count FROM webhook_inbox WHERE dedupe_key = 'event-123'`),
    );
    expect(rows.rows).toEqual([{ duplicate_count: 3 }]);
    const queued = await withTenant(pools.api, T.tenantId, (tx) =>
      tx.query('SELECT count(*)::int AS n FROM jobs WHERE kind = $1', [kind]),
    );
    expect(queued.rows[0]).toEqual({ n: 1 });
  });

  it('recovers a job after a worker process is SIGKILLed mid-execution', async () => {
    const kind = uniqueKind('crash');
    const { id } = await withTenant(pools.api, T.tenantId, (tx) =>
      jobs.enqueueJob(tx, { tenantId: T.tenantId, kind }),
    );
    const child = spawnSync(
      process.execPath,
      [join(here, 'fixtures', 'crash-worker.ts'), URLS.worker, kind],
      { encoding: 'utf8' },
    );
    expect(child.signal).toBe('SIGKILL');
    expect(child.stdout).toContain('claimed:1');
    expect(await job(id)).toMatchObject({
      status: 'running',
      lease_owner: 'crash-worker',
      attempts: 1,
    });

    await sleep(2200); // lease (2s) expires
    expect(await jobs.reclaimExpiredLeases(pools.worker)).toBeGreaterThanOrEqual(1);
    const reclaimed = await job(id);
    expect(reclaimed).toMatchObject({ status: 'queued', lease_owner: null });
    expect(reclaimed?.last_error).toMatchObject({ code: 'lease_expired' });

    await withTenant(pools.api, T.tenantId, (tx) =>
      tx.query('UPDATE jobs SET run_at = now() WHERE id = $1', [id]),
    );
    let runs = 0;
    const w = makeWorker(pools.worker, { [kind]: async () => (runs++, { type: 'done' }) });
    w.start();
    await waitFor(async () => (await job(id))?.status === 'succeeded');
    await w.stop(1000);
    expect(runs).toBe(1);
    expect(await job(id)).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('fences stale workers: a completion after lease loss is rejected', async () => {
    const kind = uniqueKind('fence');
    const { id } = await withTenant(pools.api, T.tenantId, (tx) =>
      jobs.enqueueJob(tx, { tenantId: T.tenantId, kind }),
    );
    const [claimed] = await jobs.claimJobs(pools.worker, 'old-worker', {
      limit: 1,
      leaseSeconds: 1,
      kinds: [kind],
    });
    expect(claimed?.id).toBe(id);
    await sleep(1200);
    await jobs.reclaimExpiredLeases(pools.worker);
    await withTenant(pools.api, T.tenantId, (tx) =>
      tx.query('UPDATE jobs SET run_at = now() WHERE id = $1', [id]),
    );
    const [again] = await jobs.claimJobs(pools.worker, 'new-worker', {
      limit: 1,
      leaseSeconds: 30,
      kinds: [kind],
    });
    expect(again?.id).toBe(id);
    await expect(
      withTenant(pools.worker, T.tenantId, (tx) => jobs.completeJob(tx, id, 'old-worker')),
    ).rejects.toBeInstanceOf(LeaseLostError);
    await withTenant(pools.worker, T.tenantId, (tx) => jobs.completeJob(tx, id, 'new-worker'));
    expect(await job(id)).toMatchObject({ status: 'succeeded' });
  });

  it('retries with backoff, dead-letters after max attempts, and supports audited replay', async () => {
    const kind = uniqueKind('flaky');
    const { id } = await withTenant(pools.api, T.tenantId, (tx) =>
      jobs.enqueueJob(tx, { tenantId: T.tenantId, kind, maxAttempts: 3 }),
    );
    let calls = 0;
    const w = makeWorker(pools.worker, {
      [kind]: async () => {
        calls++;
        throw new ProviderFailure({ code: 'transient', message: 'upstream 503' });
      },
    });
    w.start();
    await waitFor(async () => (await job(id))?.status === 'dead');
    await w.stop(1000);
    expect(calls).toBe(3);
    const dead = await job(id);
    expect(dead?.last_error).toMatchObject({ code: 'transient', attempt: 3 });

    await expect(
      withTenant(pools.api, T.tenantId, (tx) => jobs.replayJob(tx, T.tenantId, id, 'user:1', '')),
    ).rejects.toThrow(/reason/);
    const newId = await withTenant(pools.api, T.tenantId, (tx) =>
      jobs.replayJob(tx, T.tenantId, id, 'user:1', 'upstream fixed'),
    );
    const replayed = await job(newId);
    expect(replayed).toMatchObject({ status: 'queued', replay_of: id, attempts: 0 });
    const audit = await withTenant(pools.api, T.tenantId, (tx) =>
      tx.query('SELECT actor, reason FROM job_replays WHERE job_id = $1', [id]),
    );
    expect(audit.rows).toEqual([{ actor: 'user:1', reason: 'upstream fixed' }]);
    // A tenant cannot replay another tenant's job.
    await expect(
      withTenant(pools.api, U.tenantId, (tx) =>
        jobs.replayJob(tx, U.tenantId, id, 'user:2', 'steal'),
      ),
    ).rejects.toThrow(/not replayable/);
    await withTenant(pools.api, T.tenantId, (tx) =>
      tx.query(`UPDATE jobs SET status = 'cancelled' WHERE id = $1`, [newId]),
    );
  });

  it('permanent failures go straight to dead-letter', async () => {
    const kind = uniqueKind('perm');
    const { id } = await withTenant(pools.api, T.tenantId, (tx) =>
      jobs.enqueueJob(tx, { tenantId: T.tenantId, kind }),
    );
    const w = makeWorker(pools.worker, {
      [kind]: async () => {
        throw new ProviderFailure({ code: 'validation', message: 'bad payload' });
      },
    });
    w.start();
    await waitFor(async () => (await job(id))?.status === 'dead');
    await w.stop(1000);
    expect((await job(id))?.attempts).toBe(1);
  });

  it('claims fairly across tenants', async () => {
    const kind = uniqueKind('fair');
    await withTenant(pools.api, T.tenantId, async (tx) => {
      for (let i = 0; i < 30; i++)
        await jobs.enqueueJob(tx, {
          tenantId: T.tenantId,
          kind,
          runAt: new Date(Date.now() - 60_000),
        });
    });
    await withTenant(pools.api, U.tenantId, async (tx) => {
      for (let i = 0; i < 2; i++) await jobs.enqueueJob(tx, { tenantId: U.tenantId, kind });
    });
    const claimed = await jobs.claimJobs(pools.worker, 'fair-worker', {
      limit: 4,
      leaseSeconds: 30,
      perTenant: 2,
      kinds: [kind],
    });
    const byTenant = claimed.reduce<Record<string, number>>(
      (m, j) => ({ ...m, [j.tenant_id]: (m[j.tenant_id] ?? 0) + 1 }),
      {},
    );
    expect(byTenant[T.tenantId]).toBe(2);
    expect(byTenant[U.tenantId]).toBe(2);
    await cleanup(kind);
  });

  it('bounds concurrency per connection key and per tenant (backpressure)', async () => {
    const kind = uniqueKind('conc');
    await withTenant(pools.api, T.tenantId, async (tx) => {
      for (let i = 0; i < 10; i++)
        await jobs.enqueueJob(tx, { tenantId: T.tenantId, kind, concurrencyKey: 'conn:metro-1' });
    });
    const first = await jobs.claimJobs(pools.worker, 'w', {
      limit: 10,
      leaseSeconds: 30,
      perTenant: 10,
      maxRunningPerTenant: 10,
      maxRunningPerKey: 2,
      kinds: [kind],
    });
    expect(first).toHaveLength(2);
    const second = await jobs.claimJobs(pools.worker, 'w', {
      limit: 10,
      leaseSeconds: 30,
      perTenant: 10,
      maxRunningPerTenant: 10,
      maxRunningPerKey: 2,
      kinds: [kind],
    });
    expect(second).toHaveLength(0);
    await withTenant(pools.worker, T.tenantId, (tx) => jobs.completeJob(tx, first[0]!.id, 'w'));
    const third = await jobs.claimJobs(pools.worker, 'w', {
      limit: 10,
      leaseSeconds: 30,
      perTenant: 10,
      maxRunningPerTenant: 10,
      maxRunningPerKey: 2,
      kinds: [kind],
    });
    expect(third).toHaveLength(1);
    await cleanup(kind);
  });

  it('serializes jobs for the same entity', async () => {
    const kind = uniqueKind('entity');
    await withTenant(pools.api, T.tenantId, async (tx) => {
      await jobs.enqueueJob(tx, {
        tenantId: T.tenantId,
        kind,
        entityKey: 'variant:1@conn:1',
        entityVersion: '1',
      });
      await jobs.enqueueJob(tx, {
        tenantId: T.tenantId,
        kind,
        entityKey: 'variant:1@conn:1',
        entityVersion: '2',
      });
      await jobs.enqueueJob(tx, {
        tenantId: T.tenantId,
        kind,
        entityKey: 'variant:2@conn:1',
        entityVersion: '1',
      });
    });
    const claimed = await jobs.claimJobs(pools.worker, 'w', {
      limit: 10,
      leaseSeconds: 30,
      perTenant: 10,
      kinds: [kind],
    });
    expect(claimed.map((j) => j.entity_key).sort()).toEqual([
      'variant:1@conn:1',
      'variant:2@conn:1',
    ]);
    expect(claimed.find((j) => j.entity_key === 'variant:1@conn:1')?.entity_version).toBe('1');
    const none = await jobs.claimJobs(pools.worker, 'w', {
      limit: 10,
      leaseSeconds: 30,
      perTenant: 10,
      kinds: [kind],
    });
    expect(none).toHaveLength(0);
    await cleanup(kind);
  });

  it('coalesces obsolete updates and rejects stale versions', async () => {
    const kind = uniqueKind('stock');
    const ids = await withTenant(pools.api, T.tenantId, async (tx) => {
      const out = [];
      for (const [v, qty] of [
        ['3', 7],
        ['1', 99],
        ['2', 50],
      ] as const) {
        out.push(
          await jobs.enqueueJob(tx, {
            tenantId: T.tenantId,
            kind,
            coalesceKey: 'stock:variant:1@conn:1',
            entityVersion: v,
            payload: { qty },
          }),
        );
      }
      return out;
    });
    expect(new Set(ids.map((i) => i.id)).size).toBe(1);
    expect(ids.map((i) => i.coalesced)).toEqual([false, true, true]);
    const row = await job(ids[0]!.id);
    expect(row).toMatchObject({ entity_version: '3', payload: { qty: 7 } });

    const store = T.storeId;
    expect(
      await withTenant(pools.worker, T.tenantId, (tx) =>
        repo.acceptEntityVersion(tx, store, 'variant:1', '5'),
      ),
    ).toBe(true);
    expect(
      await withTenant(pools.worker, T.tenantId, (tx) =>
        repo.acceptEntityVersion(tx, store, 'variant:1', '4'),
      ),
    ).toBe(false);
    expect(
      await withTenant(pools.worker, T.tenantId, (tx) =>
        repo.acceptEntityVersion(tx, store, 'variant:1', '5'),
      ),
    ).toBe(false);
    expect(
      await withTenant(pools.worker, T.tenantId, (tx) =>
        repo.acceptEntityVersion(tx, store, 'variant:1', '6'),
      ),
    ).toBe(true);
    await cleanup(kind);
  });

  it('cancels queued work and aborts running work for a disabled scope', async () => {
    const kind = uniqueKind('cancel');
    const [queuedId, runningId] = await withTenant(pools.api, T.tenantId, async (tx) => [
      (
        await jobs.enqueueJob(tx, {
          tenantId: T.tenantId,
          kind,
          storeId: T.storeId,
          runAt: new Date(Date.now() + 60_000),
        })
      ).id,
      (await jobs.enqueueJob(tx, { tenantId: T.tenantId, kind, storeId: T.storeId })).id,
    ]);
    let aborted = false;
    const w = makeWorker(
      pools.worker,
      {
        [kind]: (ctx) =>
          new Promise((_, reject) => {
            ctx.signal.addEventListener('abort', () => {
              aborted = true;
              reject(ctx.signal.reason);
            });
          }),
      },
      { leaseSeconds: 2 },
    );
    w.start();
    await waitFor(async () => (await job(runningId!))?.status === 'running');
    const r = await withTenant(pools.api, T.tenantId, (tx) =>
      jobs.cancelJobsForScope(tx, { storeId: T.storeId }, 'store disconnected'),
    );
    expect(r).toEqual({ cancelled: 1, cancelRequested: 1 });
    await waitFor(async () => (await job(runningId!))?.status === 'cancelled');
    await w.stop(1000);
    expect(aborted).toBe(true);
    expect(await job(queuedId!)).toMatchObject({ status: 'cancelled' });
  });

  it('drains gracefully: unfinished jobs are released without consuming an attempt', async () => {
    const kind = uniqueKind('drain');
    const { id } = await withTenant(pools.api, T.tenantId, (tx) =>
      jobs.enqueueJob(tx, { tenantId: T.tenantId, kind }),
    );
    const w = makeWorker(pools.worker, {
      [kind]: (ctx) =>
        new Promise((_, reject) =>
          ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)),
        ),
    });
    w.start();
    await waitFor(async () => (await job(id))?.status === 'running');
    const result = await w.stop(200);
    expect(result.drained).toBe(false);
    expect(await job(id)).toMatchObject({ status: 'queued', attempts: 0, lease_owner: null });
    await cleanup(kind);
  });

  it('commits outbox events atomically with domain changes and dispatches at-least-once', async () => {
    const kind = uniqueKind('fanout');
    const event = {
      tenantId: T.tenantId,
      type: 'inventory.level_changed',
      aggregateType: 'variant',
      aggregateId: 'v-1',
      aggregateVersion: '10',
      payload: { available: 3 },
    } as const;
    // Rolled-back transaction leaves no outbox entry.
    await expect(
      withTenant(pools.api, T.tenantId, async (tx) => {
        await outbox.appendOutbox(tx, [{ ...event, aggregateId: 'rolled-back' }]);
        throw new Error('domain write failed');
      }),
    ).rejects.toThrow('domain write failed');
    await withTenant(pools.api, T.tenantId, (tx) => outbox.appendOutbox(tx, [event]));

    let failOnce = true;
    const dispatcher = new OutboxDispatcher(pools.worker, 'disp-1', silentLog, 1).subscribe(
      'inventory.level_changed',
      async (tx, e) => {
        if (e.aggregate_id === 'rolled-back') throw new Error('must not exist');
        await jobs.enqueueJob(tx, {
          tenantId: e.tenant_id,
          kind,
          coalesceKey: `stock:${e.aggregate_id}`,
          entityVersion: e.aggregate_version,
        });
        if (failOnce) {
          failOnce = false;
          throw new Error('crash before commit');
        }
      },
    );
    await dispatcher.tick(); // fails, rolled back
    await sleep(1100); // claim expires
    await waitFor(async () => (await dispatcher.tick()) >= 1 || false, 5000);
    const queued = await withTenant(pools.api, T.tenantId, (tx) =>
      tx.query('SELECT count(*)::int AS n FROM jobs WHERE kind = $1', [kind]),
    );
    expect(queued.rows[0]).toEqual({ n: 1 });
    const pending = await withTenant(pools.api, T.tenantId, (tx) =>
      tx.query(
        `SELECT count(*)::int AS n FROM outbox WHERE dispatched_at IS NULL AND event_type = 'inventory.level_changed'`,
      ),
    );
    expect(pending.rows[0]).toEqual({ n: 0 });
    await cleanup(kind);
  });

  async function cleanup(kind: string) {
    for (const t of [T, U]) {
      await withTenant(pools.api, t.tenantId, (tx) =>
        tx.query(
          `UPDATE jobs SET status = 'cancelled' WHERE kind = $1 AND status IN ('queued', 'running')`,
          [kind],
        ),
      );
    }
  }
});
