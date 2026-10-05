-- SellRelay foundation schema (Wave 0).
-- Executed by sellrelay_migrator with search_path = sellrelay.
-- Requires PostgreSQL >= 18 (uuidv7()).

------------------------------------------------------------------------------
-- Tenant context helpers
------------------------------------------------------------------------------
CREATE FUNCTION app_current_tenant() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

-- Applies ENABLE + FORCE RLS and separate read/write policies on a tenant-owned table.
CREATE FUNCTION apply_tenant_rls(p_table regclass, p_column text DEFAULT 'tenant_id') RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format('CREATE POLICY tenant_read ON %s FOR SELECT USING (%I = app_current_tenant())', p_table, p_column);
  EXECUTE format('CREATE POLICY tenant_insert ON %s FOR INSERT WITH CHECK (%I = app_current_tenant())', p_table, p_column);
  EXECUTE format('CREATE POLICY tenant_update ON %s FOR UPDATE USING (%I = app_current_tenant()) WITH CHECK (%I = app_current_tenant())', p_table, p_column, p_column);
  EXECUTE format('CREATE POLICY tenant_delete ON %s FOR DELETE USING (%I = app_current_tenant())', p_table, p_column);
END $$;

------------------------------------------------------------------------------
-- Identity and tenancy
------------------------------------------------------------------------------
CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Global identities (not tenant-owned). Accessed only through SECURITY DEFINER functions.
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_identities (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider text NOT NULL,
  subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);

CREATE TABLE memberships (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE stores (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT uuidv7(),
  platform text NOT NULL,
  domain text NOT NULL,
  external_store_id text,
  name text,
  currency text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'uninstalled', 'redacted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
-- A given external store belongs to exactly one tenant.
CREATE UNIQUE INDEX stores_platform_domain_uq ON stores (platform, lower(domain));

CREATE TABLE installations (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT uuidv7(),
  store_id uuid NOT NULL,
  host text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'uninstalled')),
  scopes text[] NOT NULL DEFAULT '{}',
  api_version text,
  installed_at timestamptz,
  uninstalled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, store_id, host),
  FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id)
);

-- Encrypted secrets (envelope encryption, see packages/security). Never returned to browsers.
CREATE TABLE credentials (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT uuidv7(),
  owner_kind text NOT NULL CHECK (owner_kind IN ('installation', 'connection')),
  owner_id uuid NOT NULL,
  kind text NOT NULL,
  envelope jsonb NOT NULL,
  key_id text NOT NULL,
  access_expires_at timestamptz,
  refresh_expires_at timestamptz,
  refresh_lock_owner text,
  refresh_lock_until timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, owner_kind, owner_id, kind)
);
CREATE INDEX credentials_expiry_idx ON credentials (access_expires_at) WHERE access_expires_at IS NOT NULL;

CREATE TABLE channel_connections (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT uuidv7(),
  channel_key text NOT NULL,
  account_label text,
  region text,
  state text NOT NULL DEFAULT 'disconnected' CHECK (state IN ('disconnected', 'connected', 'expired', 'error')),
  sync_enabled boolean NOT NULL DEFAULT false,
  initial_preview_completed_at timestamptz,
  activated_at timestamptz,
  settings jsonb NOT NULL DEFAULT '{}',
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

------------------------------------------------------------------------------
-- Catalog and inventory (canonical)
------------------------------------------------------------------------------
CREATE TABLE external_references (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT uuidv7(),
  system_kind text NOT NULL CHECK (system_kind IN ('store', 'channel', 'crm')),
  system_id uuid NOT NULL,
  object_type text NOT NULL,
  canonical_id uuid NOT NULL DEFAULT uuidv7(),
  external_id text NOT NULL,
  external_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, system_id, object_type, external_id),
  UNIQUE (tenant_id, system_id, object_type, canonical_id)
);

CREATE TABLE products (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL,
  store_id uuid NOT NULL,
  title jsonb NOT NULL,
  description_html jsonb,
  handle text,
  vendor text,
  product_type text,
  status text NOT NULL CHECK (status IN ('active', 'draft', 'archived', 'unlisted')),
  tags text[] NOT NULL DEFAULT '{}',
  options jsonb NOT NULL DEFAULT '[]',
  extensions jsonb NOT NULL DEFAULT '{}',
  source_updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id)
);
CREATE INDEX products_store_idx ON products (tenant_id, store_id);

CREATE TABLE variants (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL,
  product_id uuid NOT NULL,
  sku text,
  barcode text,
  title text NOT NULL,
  price_minor bigint NOT NULL,
  currency text NOT NULL,
  compare_at_minor bigint,
  weight jsonb,
  option_values jsonb NOT NULL DEFAULT '{}',
  inventory_tracked boolean NOT NULL DEFAULT true,
  extensions jsonb NOT NULL DEFAULT '{}',
  source_updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX variants_product_idx ON variants (tenant_id, product_id);
CREATE INDEX variants_sku_idx ON variants (tenant_id, sku) WHERE sku IS NOT NULL;

CREATE TABLE locations (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL,
  store_id uuid NOT NULL,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  country_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id)
);

CREATE TABLE inventory_levels (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  variant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  available integer NOT NULL,
  source_updated_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, variant_id, location_id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES variants (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id) ON DELETE CASCADE
);

------------------------------------------------------------------------------
-- Durable messaging: webhook inbox, transactional outbox, jobs
------------------------------------------------------------------------------
CREATE TABLE webhook_inbox (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT uuidv7(),
  source text NOT NULL,
  installation_id uuid NOT NULL,
  topic text NOT NULL,
  dedupe_key text NOT NULL,
  provider_event_id text,
  provider_delivery_id text,
  api_version text,
  triggered_at timestamptz,
  payload jsonb,
  payload_purged_at timestamptz,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'failed', 'ignored')),
  duplicate_count integer NOT NULL DEFAULT 0,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  last_error text,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, source, installation_id, topic, dedupe_key),
  FOREIGN KEY (tenant_id, installation_id) REFERENCES installations (tenant_id, id)
);
CREATE INDEX webhook_inbox_retention_idx ON webhook_inbox (received_at) WHERE payload IS NOT NULL;

CREATE TABLE outbox (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT uuidv7(),
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  aggregate_version text NOT NULL,
  payload jsonb NOT NULL,
  correlation_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  claimed_by text,
  claim_expires_at timestamptz,
  dispatched_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX outbox_pending_idx ON outbox (occurred_at) WHERE dispatched_at IS NULL;

CREATE TABLE jobs (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT uuidv7(),
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled')),
  priority smallint NOT NULL DEFAULT 0,
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 10,
  store_id uuid,
  connection_id uuid,
  concurrency_key text,
  entity_key text,
  entity_version text,
  coalesce_key text,
  lease_owner text,
  lease_expires_at timestamptz,
  cancel_requested boolean NOT NULL DEFAULT false,
  last_error jsonb,
  result jsonb,
  correlation_id text,
  replay_of uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX jobs_queued_tenant_idx ON jobs (tenant_id, priority DESC, run_at, id) WHERE status = 'queued';
CREATE INDEX jobs_queued_tenant_scan_idx ON jobs (tenant_id) WHERE status = 'queued';
CREATE UNIQUE INDEX jobs_coalesce_uq ON jobs (tenant_id, coalesce_key) WHERE status = 'queued' AND coalesce_key IS NOT NULL;
CREATE INDEX jobs_running_idx ON jobs (tenant_id, entity_key, concurrency_key) WHERE status = 'running';
CREATE INDEX jobs_lease_idx ON jobs (lease_expires_at) WHERE status = 'running';
CREATE INDEX jobs_dead_idx ON jobs (tenant_id, finished_at DESC) WHERE status = 'dead';
CREATE INDEX jobs_scope_idx ON jobs (tenant_id, store_id, connection_id) WHERE status IN ('queued', 'running');

CREATE TABLE job_replays (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT uuidv7(),
  job_id uuid NOT NULL,
  new_job_id uuid NOT NULL,
  actor text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs (tenant_id, id) ON DELETE CASCADE
);

------------------------------------------------------------------------------
-- External write safety
------------------------------------------------------------------------------
CREATE TABLE operation_ledger (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT uuidv7(),
  target_kind text NOT NULL CHECK (target_kind IN ('store', 'channel', 'crm')),
  target_id uuid NOT NULL,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'sent', 'succeeded', 'failed', 'unknown')),
  external_ref text,
  attempts integer NOT NULL DEFAULT 0,
  last_error jsonb,
  job_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, target_id, operation, idempotency_key)
);

CREATE TABLE entity_sync_state (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  target_id uuid NOT NULL,
  entity_key text NOT NULL,
  last_applied_version text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, target_id, entity_key)
);

------------------------------------------------------------------------------
-- Sync progress, activity, billing, privacy, flags
------------------------------------------------------------------------------
CREATE TABLE sync_checkpoints (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT uuidv7(),
  store_id uuid NOT NULL,
  kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  state jsonb NOT NULL DEFAULT '{}',
  counters jsonb NOT NULL DEFAULT '{}',
  job_id uuid,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id)
);
CREATE UNIQUE INDEX sync_checkpoints_active_uq ON sync_checkpoints (tenant_id, store_id, kind)
  WHERE status IN ('pending', 'running');

CREATE TABLE activity_log (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT uuidv7(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  category text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  message text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  job_id uuid,
  store_id uuid,
  connection_id uuid,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX activity_log_recent_idx ON activity_log (tenant_id, occurred_at DESC);

CREATE TABLE billing_entitlements (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  installation_id uuid NOT NULL,
  provider text NOT NULL,
  plan_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'trial', 'none', 'frozen', 'unknown')),
  features text[] NOT NULL DEFAULT '{}',
  limits jsonb NOT NULL DEFAULT '{}',
  test boolean NOT NULL DEFAULT false,
  provider_subscription_id text,
  verified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, installation_id),
  FOREIGN KEY (tenant_id, installation_id) REFERENCES installations (tenant_id, id)
);

CREATE TABLE usage_records (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT uuidv7(),
  installation_id uuid NOT NULL,
  meter text NOT NULL,
  quantity numeric NOT NULL,
  occurred_at timestamptz NOT NULL,
  idempotency_key text NOT NULL,
  report_status text NOT NULL DEFAULT 'pending' CHECK (report_status IN ('pending', 'reported', 'blocked', 'failed')),
  reported_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, installation_id) REFERENCES installations (tenant_id, id)
);

-- Privacy requests are an audit trail; they hold no raw personal data (subject refs are hashed).
CREATE TABLE privacy_requests (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT uuidv7(),
  source text NOT NULL,
  topic text NOT NULL,
  subject_ref_hash text,
  status text NOT NULL CHECK (status IN ('received', 'completed', 'needs_review')),
  received_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL,
  completed_at timestamptz,
  outcome jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, id)
);

-- Kill switches / feature flags. tenant_id NULL = global (shared reference data exception).
CREATE TABLE feature_flags (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid REFERENCES tenants (id),
  scope_key text,
  flag text NOT NULL,
  enabled boolean NOT NULL,
  reason text,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (tenant_id, scope_key, flag)
);

-- System table (not tenant-owned): worker liveness for operations dashboards.
CREATE TABLE worker_heartbeats (
  worker_id text PRIMARY KEY,
  hostname text NOT NULL,
  started_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'draining', 'stopped')),
  in_flight integer NOT NULL DEFAULT 0
);

------------------------------------------------------------------------------
-- Row-level security
------------------------------------------------------------------------------
SELECT apply_tenant_rls('tenants', 'id');
SELECT apply_tenant_rls(t)
FROM unnest(ARRAY[
  'memberships', 'stores', 'installations', 'credentials', 'channel_connections',
  'external_references', 'products', 'variants', 'locations', 'inventory_levels',
  'webhook_inbox', 'outbox', 'jobs', 'job_replays', 'operation_ledger', 'entity_sync_state',
  'sync_checkpoints', 'activity_log', 'billing_entitlements', 'usage_records', 'privacy_requests'
]::regclass[]) AS t;

ALTER TABLE feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_flags FORCE ROW LEVEL SECURITY;
CREATE POLICY flags_read ON feature_flags FOR SELECT
  USING (tenant_id IS NULL OR tenant_id = app_current_tenant());
CREATE POLICY flags_ops_write ON feature_flags FOR ALL TO sellrelay_ops USING (true) WITH CHECK (true);

-- Global identity tables: no direct access for runtime roles (no grants); RLS denies by default.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE user_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_identities FORCE ROW LEVEL SECURITY;
ALTER TABLE worker_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_heartbeats FORCE ROW LEVEL SECURITY;
CREATE POLICY heartbeat_worker ON worker_heartbeats FOR ALL TO sellrelay_worker USING (true) WITH CHECK (true);
CREATE POLICY heartbeat_ops ON worker_heartbeats FOR SELECT TO sellrelay_ops USING (true);
