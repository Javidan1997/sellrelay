/**
 * Admin GraphQL documents (API version pinned in config). Validated against the 2026-10 schema
 * by test/contract.test.ts when the schema file is available (see RESEARCH.md).
 */
const PRODUCT_FIELDS = `
  id title handle vendor productType status tags descriptionHtml updatedAt
  options { name optionValues { name } }`;

const VARIANT_FIELDS = `
  id title sku barcode price compareAtPrice updatedAt
  selectedOptions { name value }
  inventoryItem { id tracked }`;

/** Bulk export #1: products → variants (2 connection levels). */
export const BULK_PRODUCTS_QUERY = `{
  products {
    edges { node {${PRODUCT_FIELDS}
      variants { edges { node {${VARIANT_FIELDS}
      } } }
    } }
  }
}`;

/** Bulk export #2: inventory items → inventory levels with "available" quantities. */
export const BULK_INVENTORY_QUERY = `{
  inventoryItems {
    edges { node {
      id updatedAt
      inventoryLevels { edges { node {
        id updatedAt
        location { id }
        quantities(names: ["available"]) { name quantity }
      } } }
    } }
  }
}`;

export const RUN_BULK_QUERY = `mutation RunBulk($query: String!) {
  bulkOperationRunQuery(query: $query) {
    bulkOperation { id status }
    userErrors { field message code }
  }
}`;

export const BULK_STATUS_QUERY = `query BulkStatus($id: ID!) {
  node(id: $id) {
    ... on BulkOperation { id status errorCode objectCount url partialDataUrl }
  }
}`;

export const PRODUCT_QUERY = `query Product($id: ID!, $after: String) {
  product(id: $id) {${PRODUCT_FIELDS}
    variants(first: 250, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {${VARIANT_FIELDS}
      }
    }
  }
}`;

export const LOCATIONS_QUERY = `query Locations($after: String) {
  locations(first: 250, after: $after, includeInactive: true) {
    pageInfo { hasNextPage endCursor }
    nodes { id name isActive address { countryCode } }
  }
}`;

export const SHOP_QUERY = `query Shop { shop { id name currencyCode myshopifyDomain } }`;

export const INVENTORY_ITEMS_QUERY = `query InventoryItems($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on InventoryItem {
      id
      inventoryLevels(first: 50) {
        nodes { updatedAt location { id } quantities(names: ["available"]) { name quantity } }
      }
    }
  }
}`;

export const ACTIVE_SUBSCRIPTIONS_QUERY = `query ActiveSubscriptions {
  currentAppInstallation {
    activeSubscriptions {
      id name status test currentPeriodEnd
      lineItems {
        plan {
          pricingDetails {
            __typename
            ... on AppRecurringPricing { planHandle interval price { amount currencyCode } }
          }
        }
      }
    }
  }
}`;

export const ALL_DOCUMENTS: Record<string, string> = {
  BULK_PRODUCTS_QUERY,
  BULK_INVENTORY_QUERY,
  RUN_BULK_QUERY,
  BULK_STATUS_QUERY,
  PRODUCT_QUERY,
  LOCATIONS_QUERY,
  SHOP_QUERY,
  INVENTORY_ITEMS_QUERY,
  ACTIVE_SUBSCRIPTIONS_QUERY,
};
