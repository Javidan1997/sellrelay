import type { CompanyId, CustomerId, TenantId } from '../ids.ts';
import type { Extensions } from './extensions.ts';

/** Personal data. Must be redacted in logs, traces, exports and fixtures. */
export interface Customer {
  readonly id: CustomerId;
  readonly tenantId: TenantId;
  readonly email?: string;
  readonly phone?: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly companyId?: CompanyId;
  readonly marketingConsent?: boolean;
  readonly extensions: Extensions;
}

export interface Company {
  readonly id: CompanyId;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly vatId?: string;
  readonly extensions: Extensions;
}
