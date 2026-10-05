import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jobs, withTenant } from '../../../packages/persistence/src/index.ts';
import { outcomeOk } from '../../../packages/core/src/index.ts';
import {
  createTestPools,
  provisionTenant,
  type TestPools,
} from '../../../tests/integration/helpers.ts';
import { executeExternalWrite, type ExternalWriteSpec } from '../src/runtime/external-write.ts';
import { makeWorker, uniqueKind, waitFor } from './helpers.ts';
import type { JobContext } from '../src/runtime/types.ts';

/** Fake remote system with a documented "find by external reference" lookup. */
class FakeRemote {
  orders = new Map<string, string>();
  creates = 0;
  async create(ref: string): Promise<string> {
    this.creates++;
    const id = `remote-${this.orders.size + 1}`;
    this.orders.set(ref, id);
    return id;
  }
  find(ref: string): string | undefined {
    return this.orders.get(ref);
  }
}

describe('external writes: ledger, outcome-unknown and crash-after-remote-success', () => {
  let pools: TestPools;
  let T: Awaited<ReturnType<typeof provisionTenant>>;
  beforeAll(async () => {
    pools = createTestPools();
    T = await provisionTenant(pools.api);
  });
  afterAll(async () => {
    await pools.end();
  });

  const spec = (
    remote: FakeRemote,
    ref: string,
    behaviour: { crashAfterSend?: () => boolean; timeoutOnce?: () => boolean },
  ): ExternalWriteSpec => ({
    targetKind: 'store',
    targetId: T.storeId,
    operation: 'order.create',
    idempotencyKey: `order:${ref}`,
    request: { ref },
    send: async () => {
      if (behaviour.timeoutOnce?.())
        throw new Error('socket timeout (request may have been processed)');
      const id = await remote.create(ref);
      if (behaviour.crashAfterSend?.()) throw new Error('process crashed after remote success');
      return outcomeOk({ externalRef: id });
    },
    checkRemote: async () => {
      const id = remote.find(ref);
      return id ? { found: true, externalRef: id } : { found: false };
    },
  });

  async function run(remote: FakeRemote, ref: string, behaviour: Parameters<typeof spec>[2]) {
    const kind = uniqueKind('ext');
    const { id } = await withTenant(pools.api, T.tenantId, (tx) =>
      jobs.enqueueJob(tx, { tenantId: T.tenantId, kind, maxAttempts: 5 }),
    );
    const w = makeWorker(pools.worker, {
      [kind]: async (ctx: JobContext) => {
        const r = await executeExternalWrite(ctx, spec(remote, ref, behaviour));
        return { type: 'done', result: r };
      },
    });
    w.start();
    await waitFor(
      async () =>
        (await withTenant(pools.api, T.tenantId, (tx) => jobs.getJob(tx, id)))?.status ===
        'succeeded',
    );
    await w.stop(1000);
    return withTenant(pools.api, T.tenantId, (tx) => jobs.getJob(tx, id));
  }

  it('does not duplicate a remote create when the worker crashes after remote success', async () => {
    const remote = new FakeRemote();
    let crashed = false;
    const job = await run(remote, 'A-1', {
      crashAfterSend: () => (crashed ? false : (crashed = true)),
    });
    expect(remote.creates).toBe(1);
    expect(job?.result).toMatchObject({
      status: 'succeeded',
      via: 'reconciled',
      externalRef: 'remote-1',
    });
    expect(job?.attempts).toBe(2);
  });

  it('re-sends after a timeout only when remote state shows the write did not happen', async () => {
    const remote = new FakeRemote();
    let timedOut = false;
    const job = await run(remote, 'B-1', {
      timeoutOnce: () => (timedOut ? false : (timedOut = true)),
    });
    expect(remote.creates).toBe(1);
    expect(job?.result).toMatchObject({ status: 'succeeded', via: 'send' });
  });

  it('replaying an already-succeeded operation is answered from the ledger', async () => {
    const remote = new FakeRemote();
    await run(remote, 'C-1', {});
    const second = await run(remote, 'C-1', {});
    expect(remote.creates).toBe(1);
    expect(second?.result).toMatchObject({ status: 'succeeded', via: 'ledger' });
  });
});
