import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

export class OutboundUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboundUrlError';
  }
}

/** Address ranges that outbound requests to merchant-configurable URLs must never reach. */
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['64:ff9b::', 96],
  ['2001:db8::', 32],
] as const)
  blocked.addSubnet(net, prefix, 'ipv6');

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped?.[1]) return blocked.check(mapped[1], 'ipv4');
    return blocked.check(address, 'ipv6');
  }
  return blocked.check(address, 'ipv4');
}

export interface OutboundPolicy {
  /** Exact hosts or `.suffix` entries. When set, the host must match one. */
  readonly allowedHosts?: readonly string[];
  readonly allowedPorts?: readonly number[];
}

/** Static validation: HTTPS, no credentials, no IP literals, allowed host/port. */
export function validateOutboundUrl(raw: string, policy: OutboundPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundUrlError('Invalid URL');
  }
  if (url.protocol !== 'https:') throw new OutboundUrlError('Only https URLs are allowed');
  if (url.username || url.password)
    throw new OutboundUrlError('Credentials in URL are not allowed');
  const host = url.hostname.toLowerCase();
  if (isIP(host.replace(/^\[|\]$/g, '')) !== 0)
    throw new OutboundUrlError('IP address hosts are not allowed');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    !host.includes('.')
  ) {
    throw new OutboundUrlError('Internal hostnames are not allowed');
  }
  const port = url.port ? Number(url.port) : 443;
  if (!(policy.allowedPorts ?? [443]).includes(port))
    throw new OutboundUrlError('Port not allowed');
  if (
    policy.allowedHosts &&
    !policy.allowedHosts.some((h) => (h.startsWith('.') ? host.endsWith(h) : host === h))
  ) {
    throw new OutboundUrlError('Host not allowed');
  }
  return url;
}

export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;
const defaultResolver: Resolver = (h) => lookup(h, { all: true, verbatim: true });

/** Resolve and require every address to be public. Returns the address to pin. */
export async function resolvePublicAddress(
  hostname: string,
  resolver: Resolver = defaultResolver,
): Promise<{ address: string; family: number }> {
  const addrs = await resolver(hostname);
  if (addrs.length === 0) throw new OutboundUrlError('Host did not resolve');
  for (const a of addrs) {
    if (isBlockedAddress(a.address))
      throw new OutboundUrlError('Host resolves to a private or reserved address');
  }
  return addrs[0]!;
}

export interface SafeResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

export interface SafeRequestOptions extends OutboundPolicy {
  readonly method?: 'GET' | 'POST';
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly maxResponseBytes?: number;
  readonly resolver?: Resolver;
}

/**
 * HTTPS request to a merchant-configurable URL with SSRF defenses: static validation, DNS
 * resolution with private/metadata blocking, connection pinned to the validated address
 * (prevents DNS rebinding), manual redirects re-validated hop by hop, timeout and size limits.
 */
export async function safeRequest(
  rawUrl: string,
  opts: SafeRequestOptions = {},
): Promise<SafeResponse> {
  let current = rawUrl;
  for (let hop = 0; hop <= (opts.maxRedirects ?? 3); hop++) {
    const url = validateOutboundUrl(current, opts);
    const pinned = await resolvePublicAddress(url.hostname, opts.resolver);
    const res = await new Promise<SafeResponse>((resolve, reject) => {
      const req = httpsRequest(
        {
          protocol: 'https:',
          hostname: url.hostname,
          servername: url.hostname,
          port: url.port ? Number(url.port) : 443,
          path: `${url.pathname}${url.search}`,
          method: opts.method ?? 'GET',
          headers: {
            ...(opts.headers ?? {}),
            ...(opts.body ? { 'content-length': Buffer.byteLength(opts.body).toString() } : {}),
          },
          timeout: opts.timeoutMs ?? 10_000,
          lookup: (_h, _o, cb) => cb(null, pinned.address, pinned.family),
        },
        (resp) => {
          const chunks: Buffer[] = [];
          let size = 0;
          resp.on('data', (c: Buffer) => {
            size += c.length;
            if (size > (opts.maxResponseBytes ?? 1_000_000)) {
              req.destroy(new OutboundUrlError('Response too large'));
              return;
            }
            chunks.push(c);
          });
          resp.on('end', () =>
            resolve({
              status: resp.statusCode ?? 0,
              headers: resp.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
          resp.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new OutboundUrlError('Request timed out')));
      req.on('error', reject);
      if (opts.body) req.write(opts.body);
      req.end();
    });
    if (res.status >= 300 && res.status < 400 && typeof res.headers['location'] === 'string') {
      current = new URL(res.headers['location'], url).toString();
      continue;
    }
    return res;
  }
  throw new OutboundUrlError('Too many redirects');
}
