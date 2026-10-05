import { startTracing, stopTracing } from '@sellrelay/observability/tracing';

startTracing('sellrelay-api');

const { default: Fastify } = await import('fastify');
const { createAppDepsFromEnv } = await import('@sellrelay/application');
const { assertConfigured } = await import('@sellrelay/platform-shopify');
const { buildApi } = await import('./app.ts');
const { loadApiConfig } = await import('./config.ts');

const config = loadApiConfig();
const deps = createAppDepsFromEnv({ service: 'api', databaseUrl: config.DATABASE_URL_API });
assertConfigured(deps.shopify);
const app = await buildApi(deps, { config, logger: deps.log });

// Metrics are served on an internal port only (never exposed through the public listener).
const internal = Fastify({ logger: false });
internal.get('/metrics', async (_req, reply) =>
  reply.type(deps.metrics!.registry.contentType).send(await deps.metrics!.registry.metrics()),
);
internal.get('/healthz', async () => ({ status: 'ok' }));

await app.listen({ port: config.API_PORT, host: config.API_HOST });
await internal.listen({ port: config.INTERNAL_METRICS_PORT, host: config.API_HOST });

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  deps.log.info({ signal }, 'shutting down api');
  // Stop accepting connections, finish in-flight requests, then release resources.
  await app.close();
  await internal.close();
  await deps.close();
  await stopTracing();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
