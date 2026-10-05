import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createPool, tenancy } from '../../packages/persistence/src/index.ts';
import { URLS } from './env.ts';

export interface TestPools {
  api: pg.Pool;
  worker: pg.Pool;
  ops: pg.Pool;
  end(): Promise<void>;
}

export function createTestPools(): TestPools {
  const api = createPool(URLS.api, { applicationName: 'test-api', max: 5 });
  const worker = createPool(URLS.worker, { applicationName: 'test-worker', max: 5 });
  const ops = createPool(URLS.ops, { applicationName: 'test-ops', max: 2 });
  return {
    api,
    worker,
    ops,
    async end() {
      await Promise.all([api.end(), worker.end(), ops.end()]);
    },
  };
}

/** Synthetic shop domains only (never real stores). */
export function synthShop(prefix = 'test'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}.myshopify.com`;
}

export async function provisionTenant(api: pg.Pool, shop = synthShop()) {
  const r = await tenancy.provisionShopifyInstallation(api, {
    shopDomain: shop,
    shopName: 'Synthetic Test Shop',
    userSubject: '1001',
    apiVersion: '2026-10',
  });
  return { ...r, shop };
}

export async function expectPgError(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    const actual = (e as { code?: string }).code;
    if (actual !== code) {
      throw new Error(`Expected PG error ${code}, got ${actual}: ${(e as Error).message}`, {
        cause: e,
      });
    }
    return;
  }
  throw new Error(`Expected PG error ${code}, but the statement succeeded`);
}
