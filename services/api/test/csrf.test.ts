import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../packages/application/src/index.ts';
import { assertCsrfSafe } from '../src/auth.ts';

describe('CSRF guard for cookie-authenticated mutations', () => {
  const app = Fastify();
  app.addHook('preHandler', async (req) => assertCsrfSafe(req));
  app.setErrorHandler((err, _req, reply) =>
    reply
      .status(err instanceof AppError ? err.status : 500)
      .send({ error: (err as Error).message }),
  );
  app.post('/mutate', async () => ({ ok: true }));
  app.get('/read', async () => ({ ok: true }));

  it('blocks cookie mutations without a matching double-submit token', async () => {
    expect(
      (await app.inject({ method: 'POST', url: '/mutate', headers: { cookie: 'sid=abc' } }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/mutate',
          headers: { cookie: 'sid=abc; sr_csrf=t1', 'x-csrf-token': 't2' },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('allows matching tokens, bearer-authenticated calls and safe methods', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/mutate',
          headers: { cookie: 'sid=abc; sr_csrf=t1', 'x-csrf-token': 't1' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/mutate',
          headers: { cookie: 'sid=abc', authorization: 'Bearer x' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/read', headers: { cookie: 'sid=abc' } }))
        .statusCode,
    ).toBe(200);
  });
});
