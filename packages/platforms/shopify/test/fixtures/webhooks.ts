/** Synthetic webhook payloads (shape per Shopify webhook topics). No real data. */
export const SHOP = 'synthetic-demo.myshopify.com';
export const webhookPayloads: Record<string, unknown> = {
  'products/update': {
    id: 1001,
    admin_graphql_api_id: 'gid://shopify/Product/1001',
    title: 'Synthetic Tee',
    updated_at: '2026-10-04T12:00:00-00:00',
  },
  'products/create': {
    id: 1003,
    admin_graphql_api_id: 'gid://shopify/Product/1003',
    updated_at: '2026-10-04T12:00:00-00:00',
  },
  'products/delete': { id: 1002 },
  'inventory_levels/update': {
    inventory_item_id: 3001,
    location_id: 5001,
    available: 7,
    updated_at: '2026-10-04T12:01:00-00:00',
    admin_graphql_api_id: 'gid://shopify/InventoryLevel/4001?inventory_item_id=3001',
  },
  'locations/update': {
    id: 5001,
    name: 'Synthetic Warehouse',
    admin_graphql_api_id: 'gid://shopify/Location/5001',
  },
  'app/uninstalled': { id: 1, name: 'Synthetic Demo', domain: SHOP, myshopify_domain: SHOP },
  'app/scopes_update': {
    id: 1,
    previous: ['read_products'],
    current: ['read_products', 'read_inventory'],
    updated_at: '2026-10-04T12:00:00Z',
  },
  'bulk_operations/finish': {
    admin_graphql_api_id: 'gid://shopify/BulkOperation/9001',
    completed_at: '2026-10-04T12:00:00Z',
    status: 'completed',
    type: 'query',
    error_code: null,
  },
  'app_subscriptions/update': {
    app_subscription: {
      admin_graphql_api_id: 'gid://shopify/AppSubscription/1',
      name: 'Growth',
      status: 'ACTIVE',
      plan_handle: 'growth',
    },
  },
  'customers/data_request': {
    shop_id: 1,
    shop_domain: SHOP,
    orders_requested: [],
    customer: { id: 777, email: 'person@example.com', phone: '+10000000000' },
    data_request: { id: 42 },
  },
  'customers/redact': {
    shop_id: 1,
    shop_domain: SHOP,
    customer: { id: 777, email: 'person@example.com', phone: '+10000000000' },
    orders_to_redact: [],
  },
  'shop/redact': { shop_id: 1, shop_domain: SHOP },
};
