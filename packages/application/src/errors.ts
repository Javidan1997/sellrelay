export type AppErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'installation_inactive'
  | 'not_provisioned'
  | 'not_entitled'
  | 'not_found'
  | 'conflict'
  | 'validation'
  | 'unavailable';

/** Application error with a safe, user-facing message (no secrets/PII). */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  constructor(code: AppErrorCode, message: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = {
      unauthenticated: 401,
      forbidden: 403,
      installation_inactive: 403,
      not_provisioned: 409,
      not_entitled: 402,
      not_found: 404,
      conflict: 409,
      validation: 400,
      unavailable: 503,
    }[code];
  }
}
