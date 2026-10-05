/**
 * Provider budgets reflect documented quota scopes. A request may consume several budgets
 * at once (e.g. application-wide AND per-account AND per-endpoint). Tenant-only buckets are
 * insufficient for shared provider quotas.
 */
export type BudgetScope = 'application' | 'account' | 'endpoint' | 'region';

export interface BudgetKey {
  readonly provider: string;
  readonly scope: BudgetScope;
  /** e.g. app id, shop domain / seller account, endpoint name, region code */
  readonly id: string;
  readonly capacity: number;
  readonly refillPerSecond: number;
}

export interface RateBudget {
  /** Atomically consume `cost` from all keys. Returns 0 when acquired, else ms to wait (nothing consumed). */
  tryAcquire(keys: readonly BudgetKey[], cost: number): Promise<number>;
  /** Align a bucket with provider-reported remaining capacity (e.g. Shopify throttleStatus). */
  observe(key: BudgetKey, available: number): Promise<void>;
  /** Block a bucket for `ms` (e.g. HTTP 429 Retry-After). */
  block(key: BudgetKey, ms: number): Promise<void>;
}

export class BudgetWaitExceededError extends Error {
  readonly waitMs: number;

  constructor(waitMs: number) {
    super(`Rate budget wait ${waitMs}ms exceeds the allowed maximum`);
    this.waitMs = waitMs;
    this.name = 'BudgetWaitExceededError';
  }
}

/** Wait (bounded) until all budgets admit the request. */
export async function acquireBudget(
  budget: RateBudget,
  keys: readonly BudgetKey[],
  cost: number,
  opts: {
    maxWaitMs?: number;
    signal?: AbortSignal;
    sleep?: (ms: number) => Promise<void>;
    onWait?: (ms: number) => void;
  } = {},
): Promise<number> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxWait = opts.maxWaitMs ?? 30_000;
  let waited = 0;
  for (;;) {
    opts.signal?.throwIfAborted();
    const wait = await budget.tryAcquire(keys, cost);
    if (wait === 0) return waited;
    if (waited + wait > maxWait) throw new BudgetWaitExceededError(waited + wait);
    opts.onWait?.(wait);
    await sleep(wait);
    waited += wait;
  }
}
