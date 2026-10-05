DROP TABLE IF EXISTS worker_heartbeats, feature_flags, privacy_requests, usage_records, billing_entitlements,
  activity_log, sync_checkpoints, entity_sync_state, operation_ledger, job_replays, jobs, outbox,
  webhook_inbox, inventory_levels, locations, variants, products, external_references,
  channel_connections, credentials, installations, stores, memberships, user_identities, users, tenants CASCADE;
DROP FUNCTION IF EXISTS apply_tenant_rls(regclass, text);
DROP FUNCTION IF EXISTS app_current_tenant();
