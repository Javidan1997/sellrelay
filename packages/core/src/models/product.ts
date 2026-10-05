import type { ProductId, StoreId, TenantId, VariantId } from '../ids.ts';
import type { Money } from '../money.ts';
import type { Extensions, LocalizedText, Weight } from './extensions.ts';

export type ProductStatus = 'active' | 'draft' | 'archived' | 'unlisted';

export interface ProductMedia {
  readonly url: string;
  readonly altText?: string;
  readonly position: number;
}

export interface Product {
  readonly id: ProductId;
  readonly tenantId: TenantId;
  readonly storeId: StoreId;
  readonly title: LocalizedText;
  readonly descriptionHtml?: LocalizedText;
  readonly handle?: string;
  readonly vendor?: string;
  readonly productType?: string;
  readonly status: ProductStatus;
  readonly tags: readonly string[];
  readonly media: readonly ProductMedia[];
  readonly options: readonly { readonly name: string; readonly values: readonly string[] }[];
  readonly extensions: Extensions;
  /** Source-system modification time; used for stale-update rejection. */
  readonly sourceUpdatedAt: string;
}

export interface Variant {
  readonly id: VariantId;
  readonly tenantId: TenantId;
  readonly productId: ProductId;
  readonly sku?: string;
  readonly barcode?: string;
  readonly title: string;
  readonly price: Money;
  readonly compareAtPrice?: Money;
  readonly weight?: Weight;
  readonly optionValues: Readonly<Record<string, string>>;
  readonly inventoryTracked: boolean;
  readonly extensions: Extensions;
  readonly sourceUpdatedAt: string;
}

/**
 * A channel-specific sellable offer derived from a variant (price/stock/condition per channel).
 * Persisted and synchronized from Wave 1 onwards.
 */
export interface Offer {
  readonly tenantId: TenantId;
  readonly variantId: VariantId;
  readonly connectionId: string;
  readonly price: Money;
  readonly quantity: number;
  readonly condition: 'new' | 'used' | 'refurbished';
  readonly extensions: Extensions;
}
