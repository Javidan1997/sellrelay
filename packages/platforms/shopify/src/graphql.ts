import { ProviderFailure, acquireBudget, type BudgetKey, type RateBudget } from '@sellrelay/core';
import { classifyHttpError, shopifyFetch, type FetchLike } from './http.ts';
import { requireShopDomain } from './shop-domain.ts';

/**
 * Conservative fallback bucket used until Shopify reports throttleStatus for the shop.
 * Actual limits vary by plan and are read from every response's extensions.cost.
 */
export const DEFAULT_GRAPHQL_BUCKET = { capacity: 1000, refillPerSecond: 50 } as const;

interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[];
  extensions?: {
    cost?: {
      requestedQueryCost?: number;
      actualQueryCost?: number;
      throttleStatus?: ThrottleStatus;
    };
  };
}

export interface ShopifyGraphqlClientOptions {
  readonly shop: string;
  readonly apiVersion: string;
  readonly accessToken: () => Promise<string>;
  readonly budget?: RateBudget;
  readonly fetch?: FetchLike;
  readonly maxBudgetWaitMs?: number;
  readonly onRateLimitWait?: (ms: number) => void;
}

export class ShopifyGraphqlClient {
  private readonly endpoint: string;
  private bucket: BudgetKey;

  private readonly opts: ShopifyGraphqlClientOptions;

  constructor(opts: ShopifyGraphqlClientOptions) {
    this.opts = opts;
    const shop = requireShopDomain(opts.shop);
    this.endpoint = `https://${shop}/admin/api/${opts.apiVersion}/graphql.json`;
    // Budget scope: per app per shop ("account"), which is how Admin GraphQL limits apply.
    this.bucket = {
      provider: 'shopify-admin-graphql',
      scope: 'account',
      id: shop,
      ...DEFAULT_GRAPHQL_BUCKET,
    };
  }

  async request<T>(
    query: string,
    variables: Record<string, unknown> = {},
    opts: { signal?: AbortSignal; estimatedCost?: number } = {},
  ): Promise<T> {
    const cost = opts.estimatedCost ?? 10;
    if (this.opts.budget) {
      await acquireBudget(this.opts.budget, [this.bucket], Math.min(cost, this.bucket.capacity), {
        maxWaitMs: this.opts.maxBudgetWaitMs ?? 60_000,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(this.opts.onRateLimitWait ? { onWait: this.opts.onRateLimitWait } : {}),
      });
    }
    const res = await shopifyFetch(
      this.endpoint,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-shopify-access-token': await this.opts.accessToken(),
        },
        body: JSON.stringify({ query, variables }),
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      this.opts.fetch ? { fetch: this.opts.fetch } : {},
    );
    if (!res.ok) {
      const failure = classifyHttpError(res, 'Admin GraphQL');
      if (failure.error.code === 'rate_limited' && this.opts.budget)
        await this.opts.budget.block(this.bucket, failure.error.retryAfterMs ?? 2000);
      throw failure;
    }
    const body = (await res.json()) as GraphqlResponse<T>;
    const throttle = body.extensions?.cost?.throttleStatus;
    if (throttle && this.opts.budget) {
      this.bucket = {
        ...this.bucket,
        capacity: throttle.maximumAvailable,
        refillPerSecond: throttle.restoreRate,
      };
      await this.opts.budget.observe(this.bucket, throttle.currentlyAvailable);
    }
    if (body.errors?.length) {
      if (body.errors.some((e) => e.extensions?.code === 'THROTTLED')) {
        const needed = body.extensions?.cost?.requestedQueryCost ?? cost;
        const waitMs = throttle
          ? Math.ceil(
              ((needed - throttle.currentlyAvailable) / Math.max(throttle.restoreRate, 1)) * 1000,
            )
          : 2000;
        throw new ProviderFailure({
          code: 'rate_limited',
          message: 'Admin GraphQL throttled',
          retryAfterMs: Math.max(waitMs, 500),
        });
      }
      if (body.errors.some((e) => e.extensions?.code === 'ACCESS_DENIED')) {
        throw new ProviderFailure({
          code: 'forbidden',
          message: 'Admin GraphQL access denied (missing scope?)',
        });
      }
      const code = body.errors.some((e) => e.extensions?.code === 'INTERNAL_SERVER_ERROR')
        ? 'transient'
        : 'permanent';
      throw new ProviderFailure({
        code,
        message: `Admin GraphQL error: ${body.errors
          .map((e) => e.message)
          .join('; ')
          .slice(0, 300)}`,
      });
    }
    if (!body.data)
      throw new ProviderFailure({ code: 'transient', message: 'Admin GraphQL returned no data' });
    return body.data;
  }
}
