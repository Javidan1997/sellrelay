import type { FastifyRequest } from 'fastify';
import {
  AppError,
  authenticateShopifyRequest,
  type AppDeps,
  type Principal,
} from '@sellrelay/application';
import { currentContext, enterContext } from '@sellrelay/observability';
import { timingSafeEqualString } from '@sellrelay/security';

export type Role = Principal['role'];
const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export function bearerToken(req: FastifyRequest): string {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer '))
    throw new AppError('unauthenticated', 'Missing bearer session token');
  const token = h.slice('Bearer '.length).trim();
  if (token.length < 20 || token.length > 4096)
    throw new AppError('unauthenticated', 'Malformed session token');
  return token;
}

/** Resolve the principal from verified identity + membership only (never from request params). */
export async function requirePrincipal(
  deps: AppDeps,
  req: FastifyRequest,
  minRole: Role = 'viewer',
): Promise<Principal> {
  const principal = await authenticateShopifyRequest(deps, bearerToken(req));
  if (RANK[principal.role] < RANK[minRole])
    throw new AppError('forbidden', `Requires ${minRole} role`);
  enterContext({
    correlationId: currentContext()?.correlationId ?? req.id,
    tenantId: principal.tenantId,
    storeId: principal.storeId,
  });
  req.log = req.log.child({ tenant_id: principal.tenantId });
  return principal;
}

/**
 * CSRF guard for cookie-authenticated mutations (used by future cookie-based UIs).
 * Bearer-authenticated requests are not CSRF-prone. A mutation that carries cookies without
 * a bearer token must present a double-submit token matching the `sr_csrf` cookie.
 */
export function assertCsrfSafe(req: FastifyRequest): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  if (req.headers.authorization?.startsWith('Bearer ')) return;
  const cookie = req.headers.cookie;
  if (!cookie) return;
  const match = /(?:^|;\s*)sr_csrf=([^;]+)/.exec(cookie);
  const header = req.headers['x-csrf-token'];
  if (!match?.[1] || typeof header !== 'string' || !timingSafeEqualString(match[1], header)) {
    throw new AppError('forbidden', 'CSRF token missing or invalid');
  }
}
