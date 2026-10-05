import { startTracing, stopTracing } from '@sellrelay/observability/tracing';

startTracing('sellrelay-worker');

const { createServer } = await import('node:http');
const { hostname } = await import('node:os');
const { randomUUID } = await import('node:crypto');
const { createAppDepsFromEnv, JobKinds } = await import('@sellrelay/application');
const { assertConfigured } = await import('@sellrelay/platform-shopify');
const { jobs, withSystemTx, withTenant } = await import('@sellrelay/persistence');
const { HandlerRegistry } = await import('./runtime/types.ts');
const { Worker } = await import('./runtime/worker.ts');
const { OutboxDispatcher } = await import('./runtime/outbox-dispatcher.ts');
const { Scheduler } = await import('./runtime/scheduler.ts');
const { SlackAlertSink, LogAlertSink } = await import('./runtime/alerts.ts');
const { registerHandlers, registerSubscribers } = await import('./handlers.ts');

const env = process.env;
const databaseUrl = env['DATABASE_URL_WORKER'];
if (!databaseUrl) throw new Error('DATABASE_URL_WORKER is required');
const concurrency = Number(env['WORKER_CONCURRENCY'] ?? 8);
const deps = createAppDepsFromEnv({ service: 'worker', databaseUrl, poolMax: concurrency + 4 });
assertConfigured(deps.shopify);
const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const alerts = env['ALERT_SLACK_WEBHOOK_URL']
  ? new SlackAlertSink(env['ALERT_SLACK_WEBHOOK_URL'], deps.log)
  : new LogAlertSink(deps.log);

const handlers = registerHandlers(new HandlerRegistry(), deps);
const worker = new Worker({
  pool: deps.pool,
  workerId,
  handlers,
  log: deps.log,
  metrics: deps.metrics!,
  alerts,
  leaseSeconds: 60,
  concurrency,
  pollIntervalMs: 500,
  perTenant: 2,
  maxRunningPerTenant: Math.max(2, Math.ceil(concurrency / 2)),
  maxRunningPerKey: 2,
  kinds: handlers.kinds(),
});
const dispatcher = new OutboxDispatcher(deps.pool, workerId, deps.log);
registerSubscribers(dispatcher, alerts);

const metrics = deps.metrics!;
const scheduler = new Scheduler(
  databaseUrl,
  [
    {
      name: 'outbox-dispatch',
      intervalMs: 500,
      leaderOnly: false,
      run: async () => void (await dispatcher.tick(200)),
    },
    {
      name: 'heartbeat',
      intervalMs: 10_000,
      leaderOnly: false,
      run: () => worker.writeHeartbeat(),
    },
    {
      name: 'reclaim-leases',
      intervalMs: 15_000,
      leaderOnly: true,
      run: async () => void (await jobs.reclaimExpiredLeases(deps.pool)),
    },
    {
      name: 'queue-metrics',
      intervalMs: 15_000,
      leaderOnly: true,
      run: async () => {
        const s = await jobs.queueStats(deps.pool);
        metrics.queueDepth.reset();
        metrics.queueOldestAge.reset();
        for (const r of s.jobs) {
          metrics.queueDepth.set({ kind: r.kind, status: r.status }, Number(r.jobs));
          metrics.queueOldestAge.set({ kind: r.kind, status: r.status }, r.oldest_age_seconds);
        }
        metrics.outboxPending.set(s.outboxPending);
        metrics.outboxOldestAge.set(s.outboxOldestAgeSeconds);
      },
    },
    {
      name: 'credential-refresh-scan',
      intervalMs: 30 * 60_000,
      leaderOnly: true,
      run: async () => {
        const due = await withSystemTx(
          deps.pool,
          async (tx) =>
            (
              await tx.query<{ tenant_id: string; credential_id: string }>(
                `SELECT * FROM credentials_needing_refresh(interval '7 days', 500)`,
              )
            ).rows,
        );
        for (const d of due) {
          await withTenant(deps.pool, d.tenant_id, async (tx) => {
            const inst = (
              await tx.query<{ store_id: string; id: string }>(
                `SELECT i.store_id, i.id FROM credentials c JOIN installations i ON i.id = c.owner_id AND i.tenant_id = c.tenant_id WHERE c.id = $1 AND i.status = 'active'`,
                [d.credential_id],
              )
            ).rows[0];
            if (inst)
              await jobs.enqueueJob(tx, {
                tenantId: d.tenant_id,
                kind: JobKinds.credentialsRefresh,
                storeId: inst.store_id,
                coalesceKey: `cred-refresh:${inst.id}`,
              });
          });
        }
      },
    },
    {
      name: 'periodic-store-jobs',
      intervalMs: 6 * 60 * 60_000,
      leaderOnly: true,
      run: async () => {
        let after: string | null = null;
        for (;;) {
          const page: { tenant_id: string; store_id: string; installation_id: string }[] =
            await withSystemTx(
              deps.pool,
              async (tx) =>
                (
                  await tx.query<{ tenant_id: string; store_id: string; installation_id: string }>(
                    'SELECT * FROM active_installations($1, 500)',
                    [after],
                  )
                ).rows,
            );
          if (page.length === 0) break;
          for (const i of page) {
            await withTenant(deps.pool, i.tenant_id, async (tx) => {
              const jitter = new Date(Date.now() + Math.floor(Math.random() * 30 * 60_000));
              await jobs.enqueueJob(tx, {
                tenantId: i.tenant_id,
                kind: JobKinds.inventoryReconcile,
                storeId: i.store_id,
                coalesceKey: `reconcile:${i.store_id}`,
                runAt: jitter,
              });
              await jobs.enqueueJob(tx, {
                tenantId: i.tenant_id,
                kind: JobKinds.billingVerify,
                storeId: i.store_id,
                coalesceKey: `billing:${i.installation_id}`,
                payload: { installationId: i.installation_id },
                runAt: jitter,
              });
            });
          }
          after = page[page.length - 1]!.tenant_id;
        }
      },
    },
    {
      name: 'retention-purge',
      intervalMs: 24 * 60 * 60_000,
      leaderOnly: true,
      run: async () => {
        const r = await withSystemTx(
          deps.pool,
          async (tx) => (await tx.query('SELECT purge_retention(7, 30, 90, 14) AS r')).rows[0],
        );
        deps.log.info({ retention: r?.['r'] }, 'retention purge');
      },
    },
  ],
  deps.log,
);

const health = createServer(async (req, res) => {
  if (req.url === '/metrics') {
    res.setHeader('content-type', metrics.registry.contentType);
    res.end(await metrics.registry.metrics());
    return;
  }
  if (req.url === '/healthz') {
    res.statusCode = worker.state === 'stopped' ? 503 : 200;
    res.end(JSON.stringify({ status: worker.state }));
    return;
  }
  if (req.url === '/readyz') {
    try {
      await deps.pool.query('SELECT 1');
      res.statusCode = worker.state === 'running' ? 200 : 503;
      res.end(
        JSON.stringify({
          status: worker.state,
          inFlight: worker.inFlightCount,
          leader: scheduler.leader,
        }),
      );
    } catch {
      res.statusCode = 503;
      res.end(JSON.stringify({ status: 'db_unavailable' }));
    }
    return;
  }
  res.statusCode = 404;
  res.end();
});

health.listen(Number(env['WORKER_HEALTH_PORT'] ?? 9465));
worker.start();
scheduler.start();
deps.log.info({ worker_id: workerId, kinds: handlers.kinds() }, 'worker started');

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  deps.log.info({ signal }, 'draining worker');
  await scheduler.stop();
  const r = await worker.stop(Number(env['WORKER_DRAIN_TIMEOUT_MS'] ?? 30_000));
  await worker.writeHeartbeat().catch(() => undefined);
  deps.log.info(r, 'worker drained');
  health.close();
  await deps.close();
  await stopTracing();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
