import type { Unsupported } from '../capabilities/types.ts';

export type ProviderErrorCode =
  | 'rate_limited'
  | 'auth_expired'
  | 'auth_revoked'
  | 'forbidden'
  | 'not_found'
  | 'validation'
  | 'conflict'
  | 'transient'
  | 'timeout'
  | 'permanent';

/** Sanitized provider error. Never contains credentials or raw personal data. */
export interface ProviderError {
  readonly code: ProviderErrorCode;
  readonly message: string;
  readonly retryAfterMs?: number;
  readonly providerCode?: string;
  readonly httpStatus?: number;
}

export const RETRYABLE_ERROR_CODES: ReadonlySet<ProviderErrorCode> = new Set([
  'rate_limited',
  'transient',
  'timeout',
  'auth_expired',
]);

/**
 * Outcome of an external operation.
 * - `unknown` means the request may have reached the provider (e.g. timeout after send);
 *   callers MUST check remote state before retrying writes that could duplicate.
 */
export type OperationOutcome<T> =
  | { readonly status: 'ok'; readonly value: T }
  | { readonly status: 'failed'; readonly error: ProviderError }
  | { readonly status: 'unknown'; readonly reason: string }
  | Unsupported;

export const outcomeOk = <T>(value: T): OperationOutcome<T> => ({ status: 'ok', value });
export const outcomeFailed = <T = never>(error: ProviderError): OperationOutcome<T> => ({
  status: 'failed',
  error,
});

/** Execution context passed to every adapter/connector call. Tenant derives from trusted job/session data. */
export interface IntegrationContext {
  readonly tenantId: string;
  /** storeId for platforms, connectionId for connectors */
  readonly systemId: string;
  readonly correlationId: string;
  readonly signal?: AbortSignal;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

/** Thrown by adapters/handlers to signal a classified provider failure. */
export class ProviderFailure extends Error {
  readonly error: ProviderError;
  constructor(error: ProviderError) {
    super(`${error.code}: ${error.message}`);
    this.name = 'ProviderFailure';
    this.error = error;
  }
  get retryable(): boolean {
    return RETRYABLE_ERROR_CODES.has(this.error.code);
  }
}
