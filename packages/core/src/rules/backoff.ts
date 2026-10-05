export interface BackoffPolicy {
  readonly baseMs: number;
  readonly maxMs: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 1_000, maxMs: 15 * 60_000 };

/**
 * Exponential backoff with full jitter. `attempt` is 1-based (first retry = 1).
 * A provider Retry-After is a lower bound: we never retry earlier than the provider asks.
 */
export function computeBackoffMs(
  attempt: number,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  const exp = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.floor(random() * exp);
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    // Honour Retry-After exactly as a floor, plus small jitter to avoid synchronized retries.
    return retryAfterMs + Math.floor(random() * Math.min(policy.baseMs, 1_000));
  }
  return Math.max(jittered, Math.floor(policy.baseMs / 2));
}

/** Parse an HTTP Retry-After header (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(
  value: string | null | undefined,
  now: Date = new Date(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.ceil(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now.getTime());
}
