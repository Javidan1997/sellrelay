declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type TenantId = Brand<string, 'TenantId'>;
export type UserId = Brand<string, 'UserId'>;
export type StoreId = Brand<string, 'StoreId'>;
export type InstallationId = Brand<string, 'InstallationId'>;
export type ConnectionId = Brand<string, 'ConnectionId'>;
export type ProductId = Brand<string, 'ProductId'>;
export type VariantId = Brand<string, 'VariantId'>;
export type LocationId = Brand<string, 'LocationId'>;
export type OrderId = Brand<string, 'OrderId'>;
export type CustomerId = Brand<string, 'CustomerId'>;
export type CompanyId = Brand<string, 'CompanyId'>;
export type JobId = Brand<string, 'JobId'>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function asTenantId(value: string): TenantId {
  if (!isUuid(value)) throw new Error('Invalid tenant id');
  return value as TenantId;
}
