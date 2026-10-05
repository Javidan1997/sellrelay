import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acquireBudget, type BudgetKey } from '../../core/src/index.ts';
import { RedisRateBudget, TenantCache, tenantCacheKey } from '../src/index.ts';
import { REDIS_URL } from '../../../tests/integration/env.ts';

describe('Redis provider budgets', () => {
  let redis: Redis;
  let budget: RedisRateBudget;
  const key = (scope: BudgetKey['scope'], capacity: number, refill: number): BudgetKey => ({
    provider: 'test',
    scope,
    id: randomUUID(),
    capacity,
    refillPerSecond: refill,
  });

  beforeAll(() => {
    redis = new Redis(REDIS_URL);
    budget = new RedisRateBudget(redis);
  });
  afterAll(async () => {
    await redis.quit();
  });

  it('admits up to capacity, then reports a wait time', async () => {
    const k = key('account', 10, 10);
    expect(await budget.tryAcquire([k], 6)).toBe(0);
    expect(await budget.tryAcquire([k], 4)).toBe(0);
    const wait = await budget.tryAcquire([k], 5);
    expect(wait).toBeGreaterThan(300);
    expect(wait).toBeLessThanOrEqual(500);
  });

  it('enforces shared application budgets across accounts atomically', async () => {
    const app = key('application', 5, 1);
    const shopA = key('account', 100, 100);
    const shopB = key('account', 100, 100);
    expect(await budget.tryAcquire([app, shopA], 3)).toBe(0);
    // shop B has plenty, but the shared application budget is exhausted
    expect(await budget.tryAcquire([app, shopB], 3)).toBeGreaterThan(0);
    // nothing was consumed from shop B by the rejected attempt
    expect(await budget.tryAcquire([shopB], 100)).toBe(0);
  });

  it('honours provider-reported remaining capacity and Retry-After blocks', async () => {
    const k = key('account', 1000, 50);
    await budget.observe(k, 0);
    expect(await budget.tryAcquire([k], 100)).toBeGreaterThan(1500);
    const k2 = key('endpoint', 10, 10);
    await budget.block(k2, 2000);
    const w = await budget.tryAcquire([k2], 1);
    expect(w).toBeGreaterThan(1500);
  });

  it('acquireBudget waits and bounds the total wait', async () => {
    const k = key('account', 2, 20);
    await budget.tryAcquire([k], 2);
    const waited = await acquireBudget(budget, [k], 1, { maxWaitMs: 1000 });
    expect(waited).toBeGreaterThan(0);
    const k3 = key('account', 1, 0.1);
    await budget.tryAcquire([k3], 1);
    await expect(acquireBudget(budget, [k3], 1, { maxWaitMs: 100 })).rejects.toThrow(/exceeds/);
  });
});

describe('tenant-aware cache', () => {
  let redis: Redis;
  beforeAll(() => {
    redis = new Redis(REDIS_URL);
  });
  afterAll(async () => {
    await redis.quit();
  });

  it('isolates tenants and purges only one tenant', async () => {
    const cache = new TenantCache(redis);
    const a = randomUUID();
    const b = randomUUID();
    await cache.set(a, 'entitlements', { plan: 'pro' }, 60);
    await cache.set(b, 'entitlements', { plan: 'free' }, 60);
    expect(await cache.get(a, 'entitlements')).toEqual({ plan: 'pro' });
    expect(await cache.get(b, 'entitlements')).toEqual({ plan: 'free' });
    expect(await cache.purgeTenant(a)).toBe(1);
    expect(await cache.get(a, 'entitlements')).toBeNull();
    expect(await cache.get(b, 'entitlements')).toEqual({ plan: 'free' });
  });

  it('refuses keys without a valid tenant or with separator injection', () => {
    expect(() => tenantCacheKey('', 'x')).toThrow();
    expect(() => tenantCacheKey(randomUUID(), 'x', 'a:b')).toThrow();
    expect(() => tenantCacheKey('*', 'x')).toThrow();
  });
});
