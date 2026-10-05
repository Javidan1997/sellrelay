import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { AppError, createShopifyAdapter, type AppDeps } from '@sellrelay/application';
import { ProviderFailure } from '@sellrelay/core';
import { enterContext, redactText, type Logger } from '@sellrelay/observability';
import { timingSafeEqualString } from '@sellrelay/security';
import { assertCsrfSafe } from './auth.ts';
import type { ApiConfig } from './config.ts';
import { registerV1Routes } from './routes/v1.ts';
import { registerWebhookRoutes } from './routes/webhooks.ts';

export interface ApiOptions {
  readonly config: Pick<ApiConfig, 'corsOrigins' | 'SHELL_PROXY_SECRET' | 'RATE_LIMIT_PER_MINUTE'>;
  readonly logger: Logger;
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

export async function buildApi(deps: AppDeps, opts: ApiOptions): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: opts.logger as unknown as FastifyBaseLogger,
    bodyLimit: 1_048_576,
    connectionTimeout: 30_000,
    requestTimeout: 30_000,
    trustProxy: true,
    genReqId: (req) => {
      const h = req.headers['x-request-id'];
      return typeof h === 'string' && REQUEST_ID_RE.test(h) ? h : randomUUID();
    },
  });

  app.addHook('onRequest', async (req, reply) => {
    enterContext({ correlationId: req.id });
    reply.header('x-request-id', req.id);
  });

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  });
  await app.register(cors, {
    origin: opts.config.corsOrigins.length ? opts.config.corsOrigins : false,
    credentials: false,
  });
  await app.register(rateLimit, {
    global: true,
    max: opts.config.RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    redis: deps.redis,
    nameSpace: 'rl:api:',
    allowList: (req) =>
      req.url.startsWith('/webhooks/') || req.url === '/healthz' || req.url === '/readyz',
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError)
      return reply
        .status(err.status)
        .send({ error: err.code, message: err.message, requestId: req.id });
    if (err instanceof ZodError) {
      return reply
        .status(400)
        .send({
          error: 'validation',
          issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          requestId: req.id,
        });
    }
    if (err instanceof ProviderFailure) {
      req.log.warn({ code: err.error.code }, 'provider failure on request path');
      return reply
        .status(err.error.code === 'rate_limited' ? 503 : 502)
        .send({ error: 'upstream_unavailable', requestId: req.id });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500)
      return reply
        .status(status)
        .send({
          error: 'bad_request',
          message: redactText((err as Error).message).slice(0, 200),
          requestId: req.id,
        });
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'internal_error', requestId: req.id });
  });

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await deps.pool.query('SELECT 1');
      await deps.redis.ping();
      return { status: 'ready' };
    } catch {
      return reply.status(503).send({ status: 'not_ready' });
    }
  });

  const adapter = createShopifyAdapter(deps);
  await app.register(async (scope) => registerWebhookRoutes(scope, deps, adapter));
  await app.register(
    async (scope) => {
      scope.addHook('preHandler', async (req) => {
        assertCsrfSafe(req);
        const secret = opts.config.SHELL_PROXY_SECRET;
        if (secret) {
          const given = req.headers['x-sellrelay-shell'];
          if (typeof given !== 'string' || !timingSafeEqualString(given, secret))
            throw new AppError('forbidden', 'Requests must come through a SellRelay shell');
        }
      });
      await registerV1Routes(scope, deps);
    },
    { prefix: '/v1' },
  );

  return app;
}
