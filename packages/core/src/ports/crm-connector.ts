import type { CrmOperation } from '../capabilities/types.ts';
import type { Company, Customer } from '../models/customer.ts';
import type { Order } from '../models/order.ts';
import type { IntegrationContext, OperationOutcome } from './common.ts';

/**
 * CRM connector port. One-way store → CRM. Identity uses stable external references;
 * email matching is only a fallback.
 */
export interface CrmConnector {
  readonly crm: string;
  supports(op: CrmOperation): boolean;
  testConnection(ctx: IntegrationContext): Promise<OperationOutcome<{ accountName?: string }>>;
  upsertContact(
    ctx: IntegrationContext,
    customer: Customer,
    externalRef?: string,
  ): Promise<OperationOutcome<{ externalId: string }>>;
  upsertCompany(
    ctx: IntegrationContext,
    company: Company,
    externalRef?: string,
  ): Promise<OperationOutcome<{ externalId: string }>>;
  upsertDealOrSalesOrder(
    ctx: IntegrationContext,
    order: Order,
    externalRef?: string,
  ): Promise<OperationOutcome<{ externalId: string }>>;
  listPipelines(
    ctx: IntegrationContext,
  ): Promise<
    OperationOutcome<readonly { externalId: string; name: string; stages: readonly string[] }[]>
  >;
}
