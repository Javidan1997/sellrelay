import { createHmac, timingSafeEqual } from 'node:crypto';

/** Pseudonymous, keyed reference for personal identifiers kept in audit trails. */
export function pseudonymize(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
