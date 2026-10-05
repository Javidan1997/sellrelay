import type { OrderId, TenantId, VariantId } from '../ids.ts';
import type { Money } from '../money.ts';
import type { Extensions } from './extensions.ts';

export interface PostalAddress {
  readonly name?: string;
  readonly company?: string;
  readonly line1: string;
  readonly line2?: string;
  readonly city: string;
  readonly region?: string;
  readonly postalCode?: string;
  readonly countryCode: string;
  readonly phone?: string;
}

export interface OrderLine {
  readonly externalLineId: string;
  readonly variantId?: VariantId;
  readonly sku?: string;
  readonly title: string;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly taxAmount?: Money;
  readonly taxRate?: string; // decimal string, e.g. "0.19"
}

export type PaymentStatus =
  'pending' | 'authorized' | 'paid' | 'partially_refunded' | 'refunded' | 'voided';

export interface Order {
  readonly id: OrderId;
  readonly tenantId: TenantId;
  /** Origin system (channel connection or store) and its order id; unique per tenant+source. */
  readonly sourceSystemId: string;
  readonly sourceOrderId: string;
  readonly placedAt: string;
  readonly currency: string;
  readonly lines: readonly OrderLine[];
  readonly shippingTotal: Money;
  readonly taxesIncluded: boolean;
  readonly total: Money;
  /** Payment state as reported by the channel. Never implies capture by SellRelay. */
  readonly paymentStatus: PaymentStatus;
  readonly shippingAddress?: PostalAddress;
  readonly billingAddress?: PostalAddress;
  readonly customerRef?: string;
  readonly extensions: Extensions;
}

export interface Fulfillment {
  readonly tenantId: TenantId;
  readonly orderId: OrderId;
  readonly externalFulfillmentId?: string;
  readonly lines: readonly { readonly externalLineId: string; readonly quantity: number }[];
  readonly carrier?: string;
  readonly trackingNumbers: readonly string[];
  readonly trackingUrls: readonly string[];
  readonly shippedAt?: string;
}
