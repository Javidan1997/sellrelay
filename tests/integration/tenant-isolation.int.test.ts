import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  catalog,
  createPool,
  jobs,
  TenantContextError,
  withSystemTx,
  withTenant,
} from '../../packages/persistence/src/index.ts';
import type { CatalogProductRecord } from '../../packages/core/src/index.ts';
import { createTestPools, expectPgError, provisionTenant, type TestPools } from './helpers.ts';
import { URLS } from './env.ts';

const product = (externalId: string, title: string): CatalogProductRecord => ({
  kind: 'product',
  externalId,
  title: { en: title },
  status: 'active',
  tags: [],
  extensions: {},
  sourceUpdatedAt: '2026-10-01T00:00:00Z',
});

describe('tenant isolation (SQL, RLS, roles, mappings, pooled connections)', () => {
  let pools: TestPools;
  let A: Awaited<ReturnType<typeof provisionTenant>>;
  let B: Awaited<ReturnType<typeof provisionTenant>>;
  let productA: string;
  let productB: string;

  beforeAll(async () => {
    pools = createTestPools();
    A = await provisionTenant(pools.api);
    B = await provisionTenant(pools.api);
    // Same external id in both stores: mappings are scoped per tenant + store.
    productA = (
      await withTenant(pools.api, A.tenantId, (tx) =>
        catalog.upsertProducts(tx, A.storeId, [product('gid://shopify/Product/1', 'A product')]),
      )
    ).ids.get('gid://shopify/Product/1')!;
    productB = (
      await withTenant(pools.api, B.tenantId, (tx) =>
        catalog.upsertProducts(tx, B.storeId, [product('gid://shopify/Product/1', 'B product')]),
      )
    ).ids.get('gid://shopify/Product/1')!;
  });

  afterAll(async () => {
    await pools.end();
  });

  it('runtime roles are not superuser and cannot bypass RLS', async () => {
    for (const pool of [pools.api, pools.worker, pools.ops]) {
      const r = await pool.query(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      );
      expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    }
  });

  it('maps the same external id to distinct canonical ids per tenant', () => {
    expect(productA).toBeTruthy();
    expect(productB).toBeTruthy();
    expect(productA).not.toBe(productB);
  });

  it('reads only the current tenant rows', async () => {
    const rowsA = await withTenant(pools.api, A.tenantId, (tx) =>
      tx.query('SELECT id, tenant_id FROM products'),
    );
    expect(rowsA.rows.map((r) => r['id'])).toEqual([productA]);
    const refs = await withTenant(pools.api, B.tenantId, (tx) =>
      tx.query('SELECT tenant_id FROM external_references'),
    );
    expect(refs.rows.every((r) => r['tenant_id'] === B.tenantId)).toBe(true);
  });

  it('returns nothing without tenant context', async () => {
    const r = await withSystemTx(pools.api, (tx) =>
      tx.query('SELECT count(*)::int AS n FROM products'),
    );
    expect(r.rows[0]).toEqual({ n: 0 });
  });

  it('rejects writes targeting another tenant', async () => {
    await expectPgError(
      withTenant(pools.api, A.tenantId, (tx) =>
        tx.query(
          `INSERT INTO products (tenant_id, id, store_id, title, status, source_updated_at)
           VALUES ($1, gen_random_uuid(), $2, '{"en":"x"}', 'active', now())`,
          [B.tenantId, B.storeId],
        ),
      ),
      '42501',
    );
    const upd = await withTenant(pools.api, A.tenantId, (tx) =>
      tx.query(`UPDATE products SET handle = 'pwned' WHERE id = $1`, [productB]),
    );
    expect(upd.rowCount).toBe(0);
    const del = await withTenant(pools.api, A.tenantId, (tx) =>
      tx.query(`DELETE FROM products WHERE id = $1`, [productB]),
    );
    expect(del.rowCount).toBe(0);
    const still = await withTenant(pools.api, B.tenantId, (tx) =>
      tx.query('SELECT handle FROM products WHERE id = $1', [productB]),
    );
    expect(still.rows[0]).toEqual({ handle: null });
  });

  it('composite foreign keys prevent cross-tenant references', async () => {
    await expectPgError(
      withTenant(pools.api, A.tenantId, (tx) =>
        tx.query(
          `INSERT INTO variants (tenant_id, id, product_id, title, price_minor, currency, source_updated_at)
           VALUES ($1, gen_random_uuid(), $2, 'v', 100, 'EUR', now())`,
          [A.tenantId, productB],
        ),
      ),
      '23503',
    );
  });

  it('tenant context is transaction-local and does not leak through pooled connections', async () => {
    const single = createPool(URLS.api, { applicationName: 'test-single', max: 1 });
    try {
      await withTenant(single, A.tenantId, (tx) => tx.query('SELECT 1'));
      const r = await single.query(
        `SELECT current_setting('app.tenant_id', true) AS t, (SELECT count(*)::int FROM products) AS n`,
      );
      expect(r.rows[0]).toEqual({ t: '', n: 0 });
    } finally {
      await single.end();
    }
  });

  it('rejects malformed tenant ids before touching the database', async () => {
    await expect(withTenant(pools.api, "x' OR 1=1", async () => 1)).rejects.toBeInstanceOf(
      TenantContextError,
    );
  });

  it('jobs are tenant-scoped for API and worker roles', async () => {
    const job = await withTenant(pools.api, A.tenantId, (tx) =>
      jobs.enqueueJob(tx, { tenantId: A.tenantId, kind: 'test.noop' }),
    );
    expect(await withTenant(pools.api, B.tenantId, (tx) => jobs.getJob(tx, job.id))).toBeNull();
    expect(await withTenant(pools.worker, B.tenantId, (tx) => jobs.getJob(tx, job.id))).toBeNull();
    const cancelled = await withTenant(pools.api, B.tenantId, (tx) =>
      tx.query(`UPDATE jobs SET status = 'cancelled' WHERE id = $1`, [job.id]),
    );
    expect(cancelled.rowCount).toBe(0);
    await withTenant(pools.api, A.tenantId, (tx) =>
      tx.query(`UPDATE jobs SET status = 'cancelled' WHERE id = $1`, [job.id]),
    );
  });

  it('API role cannot use system scheduling functions or global identity tables', async () => {
    await expectPgError(pools.api.query(`SELECT * FROM claim_jobs('x', 1, 30)`), '42501');
    await expectPgError(pools.api.query('SELECT * FROM users'), '42501');
    await expectPgError(pools.api.query('SELECT * FROM user_identities'), '42501');
    await expectPgError(pools.api.query('SELECT * FROM worker_heartbeats'), '42501');
    await expectPgError(pools.api.query(`SELECT purge_retention(1, 1, 1, 1)`), '42501');
  });

  it('ops role cannot read credentials or webhook payloads', async () => {
    await expectPgError(pools.ops.query('SELECT * FROM credentials'), '42501');
    await expectPgError(pools.ops.query('SELECT payload FROM webhook_inbox'), '42501');
    await expectPgError(pools.ops.query('SELECT * FROM products'), '42501');
    const meta = await pools.ops.query('SELECT id, topic, status FROM webhook_inbox LIMIT 1');
    expect(meta.rowCount).toBe(0); // RLS still applies without tenant context
  });

  it('webhook routing resolves only by verified shop domain', async () => {
    const { tenancy } = await import('../../packages/persistence/src/index.ts');
    const ref = await tenancy.resolveShopifyInstallation(pools.api, A.shop.toUpperCase());
    expect(ref).toMatchObject({
      tenantId: A.tenantId,
      installationId: A.installationId,
      status: 'active',
    });
    expect(
      await tenancy.resolveShopifyInstallation(pools.api, 'unknown-shop.myshopify.com'),
    ).toBeNull();
  });

  it('provisioning is idempotent and assigns owner then member roles', async () => {
    const { tenancy } = await import('../../packages/persistence/src/index.ts');
    const again = await tenancy.provisionShopifyInstallation(pools.api, {
      shopDomain: A.shop,
      userSubject: '1001',
      apiVersion: '2026-10',
    });
    expect(again).toMatchObject({ tenantId: A.tenantId, role: 'owner', activated: false });
    const other = await tenancy.provisionShopifyInstallation(pools.api, {
      shopDomain: A.shop,
      userSubject: '2002',
      apiVersion: '2026-10',
    });
    expect(other).toMatchObject({ tenantId: A.tenantId, role: 'member' });
    const m = await tenancy.resolveMembership(pools.api, 'shopify', `${A.shop}:2002`, B.tenantId);
    expect(m).toBeNull();
    await expect(
      tenancy.provisionShopifyInstallation(pools.api, {
        shopDomain: 'evil.example.com',
        userSubject: '1',
        apiVersion: '2026-10',
      }),
    ).rejects.toMatchObject({ code: '22023' });
  });
});
