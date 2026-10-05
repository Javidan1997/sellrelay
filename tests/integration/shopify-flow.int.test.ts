import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getShopifyAccessToken,
  JobKinds,
  type AppDeps,
} from '../../packages/application/src/index.ts';
import { createLogger } from '../../packages/observability/src/index.ts';
import { tenancy, withTenant } from '../../packages/persistence/src/index.ts';
import { RedisRateBudget, TenantCache } from '../../packages/ratelimit/src/index.ts';
import { LocalKeyring, SecretBox } from '../../packages/security/src/index.ts';
import { buildApi } from '../../services/api/src/app.ts';
import {
  HandlerRegistry,
  Worker,
  OutboxDispatcher,
  registerHandlers,
  registerSubscribers,
} from '../../services/worker/src/index.ts';
import { ShopifySimulator } from '../support/shopify-simulator.ts';
import { REDIS_URL } from './env.ts';
import { createTestPools, synthShop, type TestPools } from './helpers.ts';

const log = createLogger('e2e', { level: process.env['TEST_LOG_LEVEL'] ?? 'silent' });

describe('Shopify Wave 0 flow (API + worker + Postgres + Redis, against the SIMULATOR)', () => {
  let pools: TestPools;
  let redis: Redis;
  let sim: ShopifySimulator;
  let api: FastifyInstance;
  let apiDeps: AppDeps;
  let workerDeps: AppDeps;
  let worker: Worker;
  let dispatcher: OutboxDispatcher;
  const shopA = synthShop('flow-a');
  const shopB = synthShop('flow-b');

  const kinds = Object.values(JobKinds);
  async function drain(predicate: () => Promise<boolean>, timeoutMs = 20_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await dispatcher.tick();
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('drain timeout');
  }
  const auth = async (shop: string, user = '1001') => ({
    authorization: `Bearer ${await sim.sessionToken(shop, user)}`,
  });
  const call = async (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    shop: string,
    payload?: unknown,
    user?: string,
  ) =>
    api.inject({
      method,
      url,
      headers: await auth(shop, user),
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  const tenantOf = async (shop: string) =>
    (await call('GET', '/v1/me', shop)).json().tenantId as string;
  const q = async <T extends Record<string, unknown>>(
    tenant: string,
    sql: string,
    params: unknown[] = [],
  ) => (await withTenant(pools.api, tenant, (tx) => tx.query<T>(sql, params))).rows;
  const jobsIdle = async (tenant: string) =>
    (
      await q<{ n: number }>(
        tenant,
        `SELECT count(*)::int AS n FROM jobs WHERE status IN ('queued','running') AND run_at <= now() + interval '1 second'`,
      )
    )[0]!.n === 0;

  beforeAll(async () => {
    pools = createTestPools();
    redis = new Redis(REDIS_URL);
    sim = new ShopifySimulator();
    sim.addShop(shopA, { products: 5, variantsPerProduct: 3, locations: 2 });
    sim.addShop(shopB, { products: 2, variantsPerProduct: 1, locations: 1 });
    const secretBox = new SecretBox(
      new LocalKeyring([{ id: 'k1', key: randomBytes(32).toString('base64') }], 'k1'),
    );
    const base = {
      redis,
      secretBox,
      budget: new RedisRateBudget(redis),
      shopify: {
        apiKey: sim.apiKey,
        apiSecret: sim.apiSecret,
        apiVersion: '2026-10',
        scopes: ['read_products', 'read_inventory', 'read_locations'],
        appHandle: 'sellrelay',
      },
      log,
      fetch: sim.fetch,
      privacyHashKey: 'test-privacy-key-0123456789',
    };
    apiDeps = { ...base, pool: pools.api };
    workerDeps = { ...base, pool: pools.worker };
    api = await buildApi(apiDeps, {
      config: { corsOrigins: [], SHELL_PROXY_SECRET: '', RATE_LIMIT_PER_MINUTE: 10_000 },
      logger: log,
    });
    const handlers = registerHandlers(new HandlerRegistry(), workerDeps, undefined, {
      pollMs: 10,
      batchLines: 4,
      timeSliceMs: 50,
    });
    worker = new Worker({
      pool: pools.worker,
      workerId: 'e2e-worker',
      handlers,
      log,
      leaseSeconds: 30,
      concurrency: 4,
      pollIntervalMs: 20,
      backoff: { baseMs: 10, maxMs: 50 },
      kinds,
    });
    dispatcher = new OutboxDispatcher(pools.worker, 'e2e-dispatcher', log);
    registerSubscribers(dispatcher);
    worker.start();
  });

  afterAll(async () => {
    await worker.stop(2000);
    await api.close();
    await redis.quit();
    await pools.end();
  });

  it('rejects unauthenticated and forged session tokens', async () => {
    expect((await api.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(401);
    const forged = await new ShopifySimulator(sim.apiKey, 'wrong-secret-xxxxxxxxxx').sessionToken(
      shopA,
    );
    expect(
      (
        await api.inject({
          method: 'GET',
          url: '/v1/me',
          headers: { authorization: `Bearer ${forged}` },
        })
      ).statusCode,
    ).toBe(401);
    expect((await call('GET', '/v1/me', shopA)).statusCode).toBe(409); // not provisioned yet
  });

  it('managed install: provisions, exchanges an expiring offline token, stores it encrypted', async () => {
    const res = await call('POST', '/v1/shopify/session', shopA);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ shop: shopA, role: 'owner', activated: true });
    expect(sim.calls.tokenExchange).toBe(1);
    const tenant = res.json().tenantId as string;
    const cred = (
      await q<{ envelope: unknown; access_expires_at: Date | null }>(
        tenant,
        'SELECT envelope, access_expires_at FROM credentials',
      )
    )[0]!;
    expect(JSON.stringify(cred.envelope)).not.toContain('shpat_');
    expect(cred.access_expires_at).not.toBeNull();
    // Idempotent: a second load does not re-exchange.
    await call('POST', '/v1/shopify/session', shopA);
    expect(sim.calls.tokenExchange).toBe(1);
    // A second staff member becomes a member, not owner.
    expect(
      (await call('POST', '/v1/shopify/session', shopA, undefined, '2002')).json(),
    ).toMatchObject({ role: 'member' });
    await call('POST', '/v1/shopify/session', shopB);
    await drain(async () => (await jobsIdle(tenant)) && (await jobsIdle(await tenantOf(shopB))));
    const store = (
      await q<{ currency: string; name: string }>(tenant, 'SELECT currency, name FROM stores')
    )[0];
    expect(store).toMatchObject({ currency: 'EUR', name: `Synthetic ${shopA.split('.')[0]}` });
  });

  it('never exposes credentials through the API', async () => {
    for (const url of [
      '/v1/me',
      '/v1/workspace',
      '/v1/billing',
      '/v1/integrations',
      '/v1/jobs',
      '/v1/activity',
    ]) {
      const body = (await call('GET', url, shopA)).body;
      expect(body).not.toMatch(/shpat_|shprt_|envelope|wdek/);
    }
  });

  it('imports the catalog via bulk operations with resumable checkpoints', async () => {
    const res = await call('POST', '/v1/catalog/import', shopA);
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json();
    expect(jobId).toBeTruthy();
    // A concurrent request returns the active import instead of starting another.
    expect((await call('POST', '/v1/catalog/import', shopA)).json()).toMatchObject({
      created: false,
    });
    const tenant = await tenantOf(shopA);
    await drain(
      async () =>
        (await call('GET', '/v1/catalog/import', shopA)).json().import?.status === 'completed',
    );
    const counts = (
      await q<{ p: number; v: number; l: number; loc: number }>(
        tenant,
        `SELECT (SELECT count(*)::int FROM products) p, (SELECT count(*)::int FROM variants) v, (SELECT count(*)::int FROM inventory_levels) l, (SELECT count(*)::int FROM locations) loc`,
      )
    )[0];
    expect(counts).toEqual({ p: 5, v: 15, l: 30, loc: 2 });
    const imp = (await call('GET', '/v1/catalog/import', shopA)).json().import;
    expect(imp.counters).toMatchObject({
      products: 5,
      variants: 15,
      inventoryLevels: 30,
      unmappedLevels: 0,
    });
    expect(imp.counters.batches).toBeGreaterThan(3); // small batches → several committed checkpoints
    const products = (await call('GET', '/v1/products?limit=2', shopA)).json();
    expect(products.items).toHaveLength(2);
    expect(products.nextCursor).toBeTruthy();
    const price = (
      await q<{ price_minor: bigint; currency: string }>(
        tenant,
        `SELECT price_minor, currency FROM variants WHERE sku = 'SKU-1000000-1'`,
      )
    )[0];
    expect(price).toEqual({ price_minor: 1199n, currency: 'EUR' });
    // Isolation through the API: shop B sees none of A's catalog or jobs.
    expect((await call('GET', '/v1/products', shopB)).json().items).toHaveLength(0);
    expect((await call('GET', `/v1/jobs/${jobId}`, shopB)).statusCode).toBe(404);
    expect((await call('GET', `/v1/jobs/${jobId}`, shopA)).json()).toMatchObject({
      status: 'succeeded',
    });
  });

  it('ingests verified inventory webhooks once, rejecting forgeries and stale updates', async () => {
    const tenant = await tenantOf(shopA);
    const item = 100000000 + 7; // first variant's inventory item in the simulator
    const payload = {
      inventory_item_id: item,
      location_id: 5000,
      available: 42,
      updated_at: '2026-10-04T12:00:00Z',
    };
    const wh = sim.webhook(shopA, 'inventory_levels/update', payload, { eventId: 'inv-evt-1' });
    expect(
      (
        await api.inject({
          method: 'POST',
          url: '/webhooks/shopify',
          headers: wh.headers,
          payload: wh.rawBody,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await api.inject({
          method: 'POST',
          url: '/webhooks/shopify',
          headers: wh.headers,
          payload: wh.rawBody,
        })
      ).statusCode,
    ).toBe(200);
    const forged = sim.webhook(
      shopA,
      'inventory_levels/update',
      { ...payload, available: 999 },
      { secret: 'not-the-secret' },
    );
    expect(
      (
        await api.inject({
          method: 'POST',
          url: '/webhooks/shopify',
          headers: forged.headers,
          payload: forged.rawBody,
        })
      ).statusCode,
    ).toBe(401);
    await drain(() => jobsIdle(tenant));
    const level = () =>
      q<{ available: number }>(
        tenant,
        `SELECT il.available FROM inventory_levels il JOIN external_references r ON r.canonical_id = il.variant_id AND r.object_type = 'inventory_item'
         JOIN external_references rl ON rl.canonical_id = il.location_id AND rl.object_type = 'location'
         WHERE r.external_id = $1 AND rl.external_id = 'gid://shopify/Location/5000'`,
        [`gid://shopify/InventoryItem/${item}`],
      );
    expect(await level()).toEqual([{ available: 42 }]);
    const inbox = await q<{ duplicate_count: number; status: string }>(
      tenant,
      `SELECT duplicate_count, status FROM webhook_inbox WHERE dedupe_key = 'inv-evt-1'`,
    );
    expect(inbox).toEqual([{ duplicate_count: 1, status: 'processed' }]);
    const events = await q<{ n: number }>(
      tenant,
      `SELECT count(*)::int n FROM outbox WHERE event_type = 'inventory.level_changed'`,
    );
    expect(events[0]!.n).toBe(1);
    // An older report (out-of-order delivery) does not overwrite newer data.
    const stale = sim.webhook(shopA, 'inventory_levels/update', {
      ...payload,
      available: 1,
      updated_at: '2026-10-04T11:00:00Z',
    });
    await api.inject({
      method: 'POST',
      url: '/webhooks/shopify',
      headers: stale.headers,
      payload: stale.rawBody,
    });
    await drain(() => jobsIdle(tenant));
    expect(await level()).toEqual([{ available: 42 }]);
  });

  it('refreshes products from product webhooks (coalesced) and applies deletions', async () => {
    const tenant = await tenantOf(shopA);
    const p = sim.shops.get(shopA)!.products.get(1000001)!;
    p.title = 'Renamed Synthetic Product';
    p.updatedAt = '2026-10-04T13:00:00Z';
    for (let i = 0; i < 3; i++) {
      const wh = sim.webhook(shopA, 'products/update', {
        id: p.id,
        admin_graphql_api_id: `gid://shopify/Product/${p.id}`,
        updated_at: p.updatedAt,
      });
      await api.inject({
        method: 'POST',
        url: '/webhooks/shopify',
        headers: wh.headers,
        payload: wh.rawBody,
      });
    }
    await drain(() => jobsIdle(tenant));
    const titles = await q<{ title: Record<string, string> }>(
      tenant,
      `SELECT p.title FROM products p JOIN external_references r ON r.canonical_id = p.id AND r.object_type = 'product' WHERE r.external_id = $1`,
      [`gid://shopify/Product/${p.id}`],
    );
    expect(titles[0]!.title).toEqual({ default: 'Renamed Synthetic Product' });
    const refreshJobs = await q<{ n: number }>(
      tenant,
      `SELECT count(*)::int n FROM jobs WHERE kind = $1 AND status = 'succeeded'`,
      [JobKinds.productRefresh],
    );
    expect(refreshJobs[0]!.n).toBeLessThanOrEqual(3);
    const del = sim.webhook(shopA, 'products/delete', { id: 1000004 });
    await api.inject({
      method: 'POST',
      url: '/webhooks/shopify',
      headers: del.headers,
      payload: del.rawBody,
    });
    await drain(() => jobsIdle(tenant));
    expect((await call('GET', '/v1/products?limit=100', shopA)).json().items).toHaveLength(4);
  });

  it('refreshes expiring tokens once under concurrency', async () => {
    const tenant = await tenantOf(shopA);
    const inst = (await q<{ id: string }>(tenant, 'SELECT id FROM installations'))[0]!.id;
    await q(tenant, `UPDATE credentials SET access_expires_at = now() - interval '1 minute'`);
    const before = sim.calls.refresh;
    const tokens = await Promise.all(
      Array.from({ length: 5 }, () =>
        getShopifyAccessToken(workerDeps, { tenantId: tenant, installationId: inst, shop: shopA }),
      ),
    );
    expect(sim.calls.refresh - before).toBe(1);
    expect(new Set(tokens).size).toBe(1);
  });

  it('verifies billing server-side and exposes the hosted plan page', async () => {
    const tenant = await tenantOf(shopA);
    sim.shops.get(shopA)!.subscriptions = [
      {
        id: 'gid://shopify/AppSubscription/9',
        name: 'Growth',
        status: 'ACTIVE',
        test: true,
        planHandle: 'growth',
      },
    ];
    expect((await call('POST', '/v1/billing/refresh', shopA)).statusCode).toBe(202);
    await drain(() => jobsIdle(tenant));
    const billing = (await call('GET', '/v1/billing', shopA)).json();
    expect(billing.entitlements).toMatchObject({ planKey: 'growth', status: 'active', test: true });
    expect(billing.planSelectionUrl).toBe(
      `https://admin.shopify.com/store/${shopA.split('.')[0]}/charges/sellrelay/pricing_plans`,
    );
    expect(billing.usageReporting).toBe('blocked');
  });

  it('lists integrations with explicit availability (nothing planned is usable)', async () => {
    const body = (await call('GET', '/v1/integrations', shopA)).json();
    const metro = body.integrations.find((i: { key: string }) => i.key === 'metro');
    expect(metro.implementation).toBe('planned');
    expect(metro.operations.every((o: { available: boolean }) => !o.available)).toBe(true);
    const shopify = body.integrations.find((i: { key: string }) => i.key === 'shopify');
    expect(shopify.verification).toBe('mock-only');
  });

  it('enforces RBAC for replay and privacy views', async () => {
    expect((await call('GET', '/v1/privacy/requests', shopA, undefined, '2002')).statusCode).toBe(
      403,
    );
    expect((await call('GET', '/v1/privacy/requests', shopA)).statusCode).toBe(200);
  });

  it('handles customer privacy webhooks without persisting raw personal data', async () => {
    const tenant = await tenantOf(shopA);
    for (const topic of ['customers/data_request', 'customers/redact']) {
      const wh = sim.webhook(shopA, topic, {
        shop_id: 1,
        shop_domain: shopA,
        customer: { id: 777, email: 'person@example.com', phone: '+15550000000' },
        orders_requested: [1],
        data_request: { id: 9 },
      });
      expect(
        (
          await api.inject({
            method: 'POST',
            url: '/webhooks/shopify',
            headers: wh.headers,
            payload: wh.rawBody,
          })
        ).statusCode,
      ).toBe(200);
    }
    await drain(() => jobsIdle(tenant));
    const reqs = await q<{ topic: string; status: string }>(
      tenant,
      `SELECT topic, status FROM privacy_requests ORDER BY topic`,
    );
    expect(reqs).toEqual([
      { topic: 'privacy.customer_data_request', status: 'completed' },
      { topic: 'privacy.customer_redact', status: 'completed' },
    ]);
    const leak = await q<{ n: number }>(
      tenant,
      `SELECT count(*)::int n FROM webhook_inbox WHERE payload::text LIKE '%person@example.com%' OR payload::text LIKE '%15550000000%'`,
    );
    expect(leak[0]!.n).toBe(0);
  });

  it('uninstall immediately disables sync, cancels pending work and removes credentials', async () => {
    const tenant = await tenantOf(shopA);
    await new TenantCache(redis).set(tenant, 'entitlements', { x: 1 }, 60, 'probe');
    // queue some future work that must be cancelled
    await call('POST', '/v1/catalog/import', shopA);
    const wh = sim.webhook(shopA, 'app/uninstalled', { id: 1, domain: shopA });
    expect(
      (
        await api.inject({
          method: 'POST',
          url: '/webhooks/shopify',
          headers: wh.headers,
          payload: wh.rawBody,
        })
      ).statusCode,
    ).toBe(200);
    // Immediately (before any worker processing):
    expect(await q(tenant, 'SELECT status FROM installations')).toEqual([
      { status: 'uninstalled' },
    ]);
    expect(await q(tenant, 'SELECT id FROM credentials')).toEqual([]);
    expect(
      await q(tenant, `SELECT id FROM jobs WHERE status = 'queued' AND store_id IS NOT NULL`),
    ).toEqual([]);
    expect(await new TenantCache(redis).get(tenant, 'entitlements', 'probe')).toBeNull();
    expect((await call('GET', '/v1/me', shopA)).statusCode).toBe(403);
    // Non-privacy webhooks after uninstall are acknowledged but not processed.
    const late = sim.webhook(
      shopA,
      'products/update',
      { id: 1000000, updated_at: '2026-10-05T00:00:00Z' },
      { eventId: 'late-after-uninstall' },
    );
    await api.inject({
      method: 'POST',
      url: '/webhooks/shopify',
      headers: late.headers,
      payload: late.rawBody,
    });
    await drain(() => jobsIdle(tenant));
    expect(
      await q(tenant, `SELECT id FROM webhook_inbox WHERE dedupe_key = 'late-after-uninstall'`),
    ).toEqual([]);
    // Data is retained until shop/redact (privacy processing still possible).
    expect(
      (await q<{ n: number }>(tenant, 'SELECT count(*)::int n FROM products'))[0]!.n,
    ).toBeGreaterThan(0);
  });

  it('shop/redact erases store data and keeps a non-personal audit record', async () => {
    // Shop A is uninstalled; its tenant is resolved through the webhook routing function.
    const ref = await tenancy.resolveShopifyInstallation(pools.api, shopA);
    const wh = sim.webhook(shopA, 'shop/redact', { shop_id: 1, shop_domain: shopA });
    expect(
      (
        await api.inject({
          method: 'POST',
          url: '/webhooks/shopify',
          headers: wh.headers,
          payload: wh.rawBody,
        })
      ).statusCode,
    ).toBe(200);
    await drain(() => jobsIdle(ref!.tenantId));
    const counts = (
      await q<{ p: number; v: number; l: number; refs: number }>(
        ref!.tenantId,
        `SELECT (SELECT count(*)::int FROM products) p, (SELECT count(*)::int FROM variants) v, (SELECT count(*)::int FROM inventory_levels) l, (SELECT count(*)::int FROM external_references) refs`,
      )
    )[0];
    expect(counts).toEqual({ p: 0, v: 0, l: 0, refs: 0 });
    expect(
      await q(
        ref!.tenantId,
        `SELECT topic, status FROM privacy_requests WHERE topic = 'privacy.shop_redact'`,
      ),
    ).toEqual([{ topic: 'privacy.shop_redact', status: 'completed' }]);
    expect(await q(ref!.tenantId, `SELECT status FROM stores`)).toEqual([{ status: 'redacted' }]);
    // Shop B is untouched.
    expect((await call('GET', '/v1/products', shopB)).statusCode).toBe(200);
  });

  it('a reinstall re-activates the installation with a fresh token exchange', async () => {
    const before = sim.calls.tokenExchange;
    const res = await call('POST', '/v1/shopify/session', shopA);
    expect(res.json()).toMatchObject({ activated: true });
    expect(sim.calls.tokenExchange).toBe(before + 1);
    expect((await call('GET', '/v1/me', shopA)).statusCode).toBe(200);
  });
});
