import { Redis } from 'ioredis';
import { createLogger, createMetrics, type Logger, type Metrics } from '@sellrelay/observability';
import { createPool } from '@sellrelay/persistence';
import { shopifyConfigFromEnv } from '@sellrelay/platform-shopify';
import { RedisRateBudget } from '@sellrelay/ratelimit';
import { secretBoxFromEnv } from '@sellrelay/security';
import type { AppDeps } from './deps.ts';

/** Builds process dependencies from environment variables for a given runtime role. */
export function createAppDepsFromEnv(opts: {
  service: 'api' | 'worker';
  databaseUrl: string;
  poolMax?: number;
  logger?: Logger;
  metrics?: Metrics;
}): AppDeps & { close(): Promise<void> } {
  const env = process.env;
  const log = opts.logger ?? createLogger(`sellrelay-${opts.service}`);
  const pool = createPool(opts.databaseUrl, {
    applicationName: `sellrelay-${opts.service}`,
    max: opts.poolMax ?? 10,
  });
  pool.on('error', (e) => log.error({ err: e }, 'idle pg client error'));
  const redisUrl = env['REDIS_URL'];
  if (!redisUrl) throw new Error('REDIS_URL is required');
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 3, enableAutoPipelining: true });
  redis.on('error', (e) => log.warn({ err: e }, 'redis error'));
  const privacyHashKey = env['PRIVACY_HASH_KEY'] ?? env['SHOPIFY_API_SECRET'] ?? '';
  if (env['DEPLOY_ENV'] === 'production' && !env['PRIVACY_HASH_KEY'])
    throw new Error('PRIVACY_HASH_KEY is required in production');
  return {
    pool,
    redis,
    budget: new RedisRateBudget(redis),
    secretBox: secretBoxFromEnv(env),
    shopify: shopifyConfigFromEnv(env),
    log,
    metrics: opts.metrics ?? createMetrics(`sellrelay-${opts.service}`),
    privacyHashKey: privacyHashKey || 'local-dev-privacy-key',
    async close() {
      await pool.end();
      redis.disconnect();
    },
  };
}
