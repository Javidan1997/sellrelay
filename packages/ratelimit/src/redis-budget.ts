import type { Redis } from 'ioredis';
import type { BudgetKey, RateBudget } from '@sellrelay/core';

/**
 * Multi-key token bucket evaluated atomically in Redis using server time.
 * Nothing is consumed unless every bucket can pay. Blocked buckets (Retry-After) return their
 * remaining block time.
 */
const ACQUIRE_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local cost = tonumber(ARGV[1])
local n = #KEYS
local wait = 0
local tokens = {}
for i = 1, n do
  local cap = tonumber(ARGV[2 + (i - 1) * 2])
  local rate = tonumber(ARGV[3 + (i - 1) * 2])
  local h = redis.call('HMGET', KEYS[i], 'tokens', 'ts', 'blocked_until')
  local tk = tonumber(h[1])
  local ts = tonumber(h[2])
  local blocked = tonumber(h[3]) or 0
  if tk == nil then tk = cap; ts = now end
  tk = math.min(cap, tk + (now - ts) * rate / 1000)
  tokens[i] = tk
  if blocked > now then
    wait = math.max(wait, blocked - now)
  elseif tk < cost then
    if rate <= 0 then return -1 end
    wait = math.max(wait, math.ceil((cost - tk) * 1000 / rate))
  end
end
for i = 1, n do
  local cap = tonumber(ARGV[2 + (i - 1) * 2])
  local rate = tonumber(ARGV[3 + (i - 1) * 2])
  local remaining = tokens[i]
  if wait == 0 then remaining = remaining - cost end
  redis.call('HSET', KEYS[i], 'tokens', remaining, 'ts', now)
  local ttl = 3600000
  if rate > 0 then ttl = math.ceil(cap * 1000 / rate) + 60000 end
  redis.call('PEXPIRE', KEYS[i], ttl)
end
return wait
`;

const OBSERVE_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('HSET', KEYS[1], 'tokens', ARGV[1], 'ts', now)
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`;

const BLOCK_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local until_ts = now + tonumber(ARGV[1])
local cur = tonumber(redis.call('HGET', KEYS[1], 'blocked_until')) or 0
if until_ts > cur then redis.call('HSET', KEYS[1], 'blocked_until', until_ts) end
redis.call('PEXPIRE', KEYS[1], math.max(tonumber(ARGV[1]) + 60000, 3600000))
return until_ts
`;

export function budgetRedisKey(k: BudgetKey): string {
  return `rl:${k.provider}:${k.scope}:${k.id}`;
}

export class RedisRateBudget implements RateBudget {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async tryAcquire(keys: readonly BudgetKey[], cost: number): Promise<number> {
    if (keys.length === 0) return 0;
    const args = [
      String(cost),
      ...keys.flatMap((k) => [String(k.capacity), String(k.refillPerSecond)]),
    ];
    const wait = (await this.redis.eval(
      ACQUIRE_LUA,
      keys.length,
      ...keys.map(budgetRedisKey),
      ...args,
    )) as number;
    if (wait < 0) throw new Error('Budget with zero refill rate cannot satisfy request');
    return wait;
  }

  async observe(key: BudgetKey, available: number): Promise<void> {
    const ttl =
      key.refillPerSecond > 0
        ? Math.ceil((key.capacity * 1000) / key.refillPerSecond) + 60_000
        : 3_600_000;
    await this.redis.eval(
      OBSERVE_LUA,
      1,
      budgetRedisKey(key),
      String(Math.max(0, available)),
      String(ttl),
    );
  }

  async block(key: BudgetKey, ms: number): Promise<void> {
    await this.redis.eval(BLOCK_LUA, 1, budgetRedisKey(key), String(Math.max(0, Math.ceil(ms))));
  }
}
