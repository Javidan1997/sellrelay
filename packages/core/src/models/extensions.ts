import type { JsonValue } from '../json.ts';

/**
 * Namespaced extension data. Channel- or host-specific attributes live here
 * (e.g. `{ "shopify": { "metafields.custom.material": "cotton" }, "metro": { ... } }`)
 * instead of being hard-coded into canonical fields.
 */
export type Extensions = Readonly<Record<string, Readonly<Record<string, JsonValue>>>>;

/** Text authored in one or more locales. Keys are BCP 47 language tags. */
export type LocalizedText = Readonly<Record<string, string>>;

export interface Weight {
  readonly value: string; // decimal string, never float
  readonly unit: 'g' | 'kg' | 'lb' | 'oz';
}
