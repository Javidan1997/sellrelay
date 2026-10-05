import type {
  CatalogInventoryLevelRecord,
  CatalogProductRecord,
  CatalogVariantRecord,
  LocationRecord,
} from '@sellrelay/core';
import type { Tx } from '../db.ts';

type ObjectType = 'product' | 'variant' | 'inventory_item' | 'location';

/**
 * Resolve (and create when missing) canonical ids for external ids within one store/connection.
 * One round-trip per batch (no N+1).
 */
export async function resolveCanonicalIds(
  tx: Tx,
  systemKind: 'store' | 'channel' | 'crm',
  systemId: string,
  objectType: ObjectType,
  externalIds: readonly string[],
  opts: { create: boolean } = { create: true },
): Promise<Map<string, string>> {
  const unique = [...new Set(externalIds)];
  if (unique.length === 0) return new Map();
  const sql = opts.create
    ? `INSERT INTO external_references (tenant_id, system_kind, system_id, object_type, external_id)
       SELECT app_current_tenant(), $1, $2, $3, x FROM unnest($4::text[]) AS x
       ON CONFLICT (tenant_id, system_id, object_type, external_id)
       DO UPDATE SET external_id = EXCLUDED.external_id
       RETURNING external_id, canonical_id`
    : `SELECT external_id, canonical_id FROM external_references
       WHERE system_kind = $1 AND system_id = $2 AND object_type = $3 AND external_id = ANY ($4::text[])`;
  const r = await tx.query<{ external_id: string; canonical_id: string }>(sql, [
    systemKind,
    systemId,
    objectType,
    unique,
  ]);
  return new Map(r.rows.map((row) => [row.external_id, row.canonical_id]));
}

/** Links a variant's canonical id to its inventory-item external id. */
async function linkInventoryItems(
  tx: Tx,
  storeId: string,
  pairs: { variantId: string; inventoryItemId: string }[],
): Promise<void> {
  if (pairs.length === 0) return;
  await tx.query(
    `INSERT INTO external_references (tenant_id, system_kind, system_id, object_type, canonical_id, external_id)
     SELECT app_current_tenant(), 'store', $1, 'inventory_item', x.variant_id, x.item_id
     FROM jsonb_to_recordset($2::jsonb) AS x(variant_id uuid, item_id text)
     ON CONFLICT (tenant_id, system_id, object_type, external_id)
     DO UPDATE SET canonical_id = EXCLUDED.canonical_id, updated_at = now()`,
    [
      storeId,
      JSON.stringify(pairs.map((p) => ({ variant_id: p.variantId, item_id: p.inventoryItemId }))),
    ],
  );
}

export interface UpsertStats {
  readonly written: number;
  readonly staleSkipped: number;
}

/** Batch upsert with stale rejection: rows with an older source_updated_at never overwrite newer data. */
export async function upsertProducts(
  tx: Tx,
  storeId: string,
  records: readonly CatalogProductRecord[],
): Promise<UpsertStats & { ids: Map<string, string> }> {
  const ids = await resolveCanonicalIds(
    tx,
    'store',
    storeId,
    'product',
    records.map((r) => r.externalId),
  );
  if (records.length === 0) return { written: 0, staleSkipped: 0, ids };
  const rows = records.map((r) => ({
    id: ids.get(r.externalId),
    title: r.title,
    description_html: r.descriptionHtml ?? null,
    handle: r.handle ?? null,
    vendor: r.vendor ?? null,
    product_type: r.productType ?? null,
    status: r.status,
    tags: r.tags,
    extensions: r.extensions,
    source_updated_at: r.sourceUpdatedAt,
  }));
  const res = await tx.query(
    `INSERT INTO products (tenant_id, id, store_id, title, description_html, handle, vendor, product_type, status,
                           tags, extensions, source_updated_at, deleted_at)
     SELECT app_current_tenant(), x.id, $1, x.title, x.description_html, x.handle, x.vendor, x.product_type, x.status,
            ARRAY(SELECT jsonb_array_elements_text(x.tags)), x.extensions, x.source_updated_at, NULL
     FROM jsonb_to_recordset($2::jsonb) AS x(id uuid, title jsonb, description_html jsonb, handle text, vendor text,
          product_type text, status text, tags jsonb, extensions jsonb, source_updated_at timestamptz)
     ON CONFLICT (tenant_id, id) DO UPDATE SET
       title = EXCLUDED.title, description_html = EXCLUDED.description_html, handle = EXCLUDED.handle,
       vendor = EXCLUDED.vendor, product_type = EXCLUDED.product_type, status = EXCLUDED.status,
       tags = EXCLUDED.tags, extensions = EXCLUDED.extensions, source_updated_at = EXCLUDED.source_updated_at,
       deleted_at = NULL, updated_at = now()
     WHERE products.source_updated_at <= EXCLUDED.source_updated_at`,
    [storeId, JSON.stringify(rows)],
  );
  const written = res.rowCount ?? 0;
  return { written, staleSkipped: records.length - written, ids };
}

export async function upsertVariants(
  tx: Tx,
  storeId: string,
  records: readonly CatalogVariantRecord[],
): Promise<UpsertStats & { missingProduct: number; ids: Map<string, string> }> {
  if (records.length === 0)
    return { written: 0, staleSkipped: 0, missingProduct: 0, ids: new Map() };
  const productIds = await resolveCanonicalIds(
    tx,
    'store',
    storeId,
    'product',
    records.map((r) => r.productExternalId),
    { create: false },
  );
  const usable = records.filter((r) => productIds.has(r.productExternalId));
  const ids = await resolveCanonicalIds(
    tx,
    'store',
    storeId,
    'variant',
    usable.map((r) => r.externalId),
  );
  const rows = usable.map((r) => ({
    id: ids.get(r.externalId),
    product_id: productIds.get(r.productExternalId),
    sku: r.sku ?? null,
    barcode: r.barcode ?? null,
    title: r.title,
    price_minor: r.price.amountMinor.toString(),
    currency: r.price.currency,
    compare_at_minor: r.compareAtPrice ? r.compareAtPrice.amountMinor.toString() : null,
    option_values: r.optionValues,
    inventory_tracked: r.inventoryTracked,
    extensions: r.extensions,
    source_updated_at: r.sourceUpdatedAt,
  }));
  let written = 0;
  if (rows.length > 0) {
    const res = await tx.query(
      `INSERT INTO variants (tenant_id, id, product_id, sku, barcode, title, price_minor, currency, compare_at_minor,
                             option_values, inventory_tracked, extensions, source_updated_at, deleted_at)
       SELECT app_current_tenant(), x.id, x.product_id, x.sku, x.barcode, x.title, x.price_minor, x.currency,
              x.compare_at_minor, x.option_values, x.inventory_tracked, x.extensions, x.source_updated_at, NULL
       FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, product_id uuid, sku text, barcode text, title text,
            price_minor bigint, currency text, compare_at_minor bigint, option_values jsonb, inventory_tracked boolean,
            extensions jsonb, source_updated_at timestamptz)
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         product_id = EXCLUDED.product_id, sku = EXCLUDED.sku, barcode = EXCLUDED.barcode, title = EXCLUDED.title,
         price_minor = EXCLUDED.price_minor, currency = EXCLUDED.currency, compare_at_minor = EXCLUDED.compare_at_minor,
         option_values = EXCLUDED.option_values, inventory_tracked = EXCLUDED.inventory_tracked,
         extensions = EXCLUDED.extensions, source_updated_at = EXCLUDED.source_updated_at, deleted_at = NULL, updated_at = now()
       WHERE variants.source_updated_at <= EXCLUDED.source_updated_at`,
      [JSON.stringify(rows)],
    );
    written = res.rowCount ?? 0;
  }
  await linkInventoryItems(
    tx,
    storeId,
    usable.flatMap((r) =>
      r.inventoryItemExternalId
        ? [{ variantId: ids.get(r.externalId)!, inventoryItemId: r.inventoryItemExternalId }]
        : [],
    ),
  );
  return {
    written,
    staleSkipped: rows.length - written,
    missingProduct: records.length - usable.length,
    ids,
  };
}

/** Soft-deletes variants of a product that are no longer present at the source. */
export async function pruneMissingVariants(
  tx: Tx,
  productId: string,
  keepVariantIds: readonly string[],
): Promise<number> {
  const r = await tx.query(
    `UPDATE variants SET deleted_at = now(), updated_at = now()
     WHERE product_id = $1 AND deleted_at IS NULL AND NOT (id = ANY ($2::uuid[]))`,
    [productId, keepVariantIds],
  );
  return r.rowCount ?? 0;
}

export async function markProductDeleted(
  tx: Tx,
  storeId: string,
  productExternalId: string,
): Promise<string | null> {
  const ids = await resolveCanonicalIds(tx, 'store', storeId, 'product', [productExternalId], {
    create: false,
  });
  const id = ids.get(productExternalId);
  if (!id) return null;
  await tx.query(`UPDATE products SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id]);
  await tx.query(
    `UPDATE variants SET deleted_at = now(), updated_at = now() WHERE product_id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return id;
}

export async function upsertLocations(
  tx: Tx,
  storeId: string,
  records: readonly LocationRecord[],
): Promise<Map<string, string>> {
  const ids = await resolveCanonicalIds(
    tx,
    'store',
    storeId,
    'location',
    records.map((r) => r.externalId),
  );
  if (records.length === 0) return ids;
  await tx.query(
    `INSERT INTO locations (tenant_id, id, store_id, name, active, country_code)
     SELECT app_current_tenant(), x.id, $1, x.name, x.active, x.country_code
     FROM jsonb_to_recordset($2::jsonb) AS x(id uuid, name text, active boolean, country_code text)
     ON CONFLICT (tenant_id, id) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active,
       country_code = EXCLUDED.country_code, updated_at = now()`,
    [
      storeId,
      JSON.stringify(
        records.map((r) => ({
          id: ids.get(r.externalId),
          name: r.name,
          active: r.active,
          country_code: r.countryCode ?? null,
        })),
      ),
    ],
  );
  return ids;
}

export interface InventoryChange {
  readonly variantId: string;
  readonly locationId: string;
  readonly available: number;
  readonly previous: number | null;
  readonly sourceUpdatedAt: string;
}

/**
 * Upserts inventory levels, rejecting stale reports (older source_updated_at) and returning the
 * rows whose quantity actually changed (for outbox events). Unmapped items/locations are counted.
 */
export async function upsertInventoryLevels(
  tx: Tx,
  storeId: string,
  records: readonly CatalogInventoryLevelRecord[],
): Promise<{
  changes: InventoryChange[];
  written: number;
  unmapped: number;
  staleSkipped: number;
}> {
  if (records.length === 0) return { changes: [], written: 0, unmapped: 0, staleSkipped: 0 };
  const items = await resolveCanonicalIds(
    tx,
    'store',
    storeId,
    'inventory_item',
    records.map((r) => r.inventoryItemExternalId),
    { create: false },
  );
  const locs = await resolveCanonicalIds(
    tx,
    'store',
    storeId,
    'location',
    records.map((r) => r.locationExternalId),
    { create: false },
  );
  // Collapse duplicates within the batch: newest report per (item, location) wins.
  const latest = new Map<
    string,
    { variant_id: string; location_id: string; available: number; source_updated_at: string }
  >();
  let unmapped = 0;
  for (const r of records) {
    const variantId = items.get(r.inventoryItemExternalId);
    const locationId = locs.get(r.locationExternalId);
    if (!variantId || !locationId) {
      unmapped++;
      continue;
    }
    const key = `${variantId}:${locationId}`;
    const prev = latest.get(key);
    if (!prev || Date.parse(prev.source_updated_at) <= Date.parse(r.sourceUpdatedAt)) {
      latest.set(key, {
        variant_id: variantId,
        location_id: locationId,
        available: r.available,
        source_updated_at: r.sourceUpdatedAt,
      });
    }
  }
  const rows = [...latest.values()];
  if (rows.length === 0) return { changes: [], written: 0, unmapped, staleSkipped: 0 };
  const res = await tx.query<{
    variant_id: string;
    location_id: string;
    available: number;
    previous: number | null;
    source_updated_at: Date;
  }>(
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(variant_id uuid, location_id uuid, available integer, source_updated_at timestamptz)
     ), prev AS (
       SELECT il.variant_id, il.location_id, il.available FROM inventory_levels il
       JOIN input i ON i.variant_id = il.variant_id AND i.location_id = il.location_id
     ), up AS (
       INSERT INTO inventory_levels (tenant_id, variant_id, location_id, available, source_updated_at)
       SELECT app_current_tenant(), i.variant_id, i.location_id, i.available, i.source_updated_at FROM input i
       ON CONFLICT (tenant_id, variant_id, location_id) DO UPDATE SET
         available = EXCLUDED.available, source_updated_at = EXCLUDED.source_updated_at, updated_at = now()
       WHERE inventory_levels.source_updated_at <= EXCLUDED.source_updated_at
       RETURNING variant_id, location_id, available, source_updated_at
     )
     SELECT up.variant_id, up.location_id, up.available, prev.available AS previous, up.source_updated_at
     FROM up LEFT JOIN prev ON prev.variant_id = up.variant_id AND prev.location_id = up.location_id`,
    [JSON.stringify(rows)],
  );
  const changes = res.rows
    .filter((r) => r.previous === null || r.previous !== r.available)
    .map((r) => ({
      variantId: r.variant_id,
      locationId: r.location_id,
      available: r.available,
      previous: r.previous,
      sourceUpdatedAt: r.source_updated_at.toISOString(),
    }));
  return {
    changes,
    written: res.rowCount ?? 0,
    unmapped,
    staleSkipped: rows.length - (res.rowCount ?? 0),
  };
}

export interface ProductListItem {
  readonly id: string;
  readonly title: Record<string, string>;
  readonly status: string;
  readonly vendor: string | null;
  readonly variant_count: number;
  readonly total_available: number;
  readonly source_updated_at: Date;
}

export async function listProducts(
  tx: Tx,
  opts: { limit: number; after?: string },
): Promise<ProductListItem[]> {
  return (
    await tx.query<ProductListItem>(
      `SELECT p.id, p.title, p.status, p.vendor, p.source_updated_at,
              (SELECT count(*)::int FROM variants v WHERE v.product_id = p.id AND v.deleted_at IS NULL) AS variant_count,
              (SELECT COALESCE(sum(il.available), 0)::int FROM inventory_levels il JOIN variants v
                 ON v.id = il.variant_id AND v.tenant_id = il.tenant_id
               WHERE v.product_id = p.id AND v.deleted_at IS NULL) AS total_available
       FROM products p
       WHERE p.deleted_at IS NULL AND ($2::uuid IS NULL OR p.id > $2)
       ORDER BY p.id LIMIT $1`,
      [opts.limit, opts.after ?? null],
    )
  ).rows;
}
