import type { Redis } from 'ioredis';
import type { TenantId } from '@sellrelay/core';
import { isUuid } from '@sellrelay/core';

/** Every cache key is namespaced by tenant; callers cannot build a key without one. */
export function tenantCacheKey(
  tenantId: TenantId | string,
  namespace: string,
  ...parts: string[]
): string {
  if (!isUuid(tenantId)) throw new Error('tenant cache keys require a tenant id');
  for (const p of [namespace, ...parts]) {
    if (p.includes(':') || p.length === 0)
      throw new Error('cache key parts must be non-empty and contain no ":"');
  }
  return ['t', tenantId, namespace, ...parts].join(':');
}

export class TenantCache {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async get<T>(tenantId: string, namespace: string, ...parts: string[]): Promise<T | null> {
    const raw = await this.redis.get(tenantCacheKey(tenantId, namespace, ...parts));
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  async set(
    tenantId: string,
    namespace: string,
    value: unknown,
    ttlSeconds: number,
    ...parts: string[]
  ): Promise<void> {
    await this.redis.set(
      tenantCacheKey(tenantId, namespace, ...parts),
      JSON.stringify(value),
      'EX',
      ttlSeconds,
    );
  }

  async del(tenantId: string, namespace: string, ...parts: string[]): Promise<void> {
    await this.redis.del(tenantCacheKey(tenantId, namespace, ...parts));
  }

  /** Remove every cached entry of a tenant (e.g. on uninstall/redaction). */
  async purgeTenant(tenantId: string): Promise<number> {
    if (!isUuid(tenantId)) throw new Error('invalid tenant id');
    let cursor = '0';
    let removed = 0;
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `t:${tenantId}:*`, 'COUNT', 500);
      cursor = next;
      if (keys.length) removed += await this.redis.del(...keys);
    } while (cursor !== '0');
    return removed;
  }
}
