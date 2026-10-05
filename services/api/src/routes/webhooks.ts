import type { FastifyInstance } from 'fastify';
import { ingestShopifyWebhook, type AppDeps } from '@sellrelay/application';
import type { ShopifyAdapter } from '@sellrelay/platform-shopify';

/**
 * Webhook ingress. The JSON parser is replaced by a raw Buffer parser in this encapsulated
 * scope: HMAC verification must use the exact bytes Shopify signed.
 */
export async function registerWebhookRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  adapter: ShopifyAdapter,
): Promise<void> {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer', bodyLimit: 10 * 1_048_576 },
    (_req, body, done) => done(null, body),
  );

  app.post('/webhooks/shopify', async (req, reply) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers))
      headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    const result = await ingestShopifyWebhook(deps, adapter, { headers, rawBody });
    if (result.status === 401) return reply.status(401).send({ error: 'unauthorized' });
    return reply.status(200).send({ ok: true });
  });
}
