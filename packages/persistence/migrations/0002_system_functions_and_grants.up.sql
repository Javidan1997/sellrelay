-- System functions (documented RLS exceptions) and least-privilege grants.
-- SECURITY DEFINER functions are owned by sellrelay_definer (NOLOGIN, BYPASSRLS), pin
-- search_path, and expose only the narrow operation they implement.

------------------------------------------------------------------------------
-- Installation routing and provisioning (exceptions 1-3, ADR 0005)
------------------------------------------------------------------------------
CREATE FUNCTION resolve_shopify_installation(p_shop_domain text)
RETURNS TABLE (tenant_id uuid, store_id uuid, installation_id uuid, installation_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = sellrelay, pg_temp AS $$
  SELECT i.tenant_id, i.store_id, i.id, i.status
  FROM stores s
  JOIN installations i ON i.tenant_id = s.tenant_id AND i.store_id = s.id AND i.host = 'shopify'
  WHERE s.platform = 'shopify' AND lower(s.domain) = lower(p_shop_domain)
$$;

CREATE FUNCTION provision_shopify_installation(
  p_shop_domain text, p_shop_name text, p_user_subject text, p_api_version text
) RETURNS TABLE (tenant_id uuid, store_id uuid, installation_id uuid, user_id uuid, role text, activated boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = sellrelay, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_domain text := lower(p_shop_domain);
  v_tenant uuid; v_store uuid; v_inst uuid; v_inst_status text; v_user uuid; v_role text;
  v_activated boolean := false;
  v_subject text;
BEGIN
  IF v_domain !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' THEN
    RAISE EXCEPTION 'invalid shop domain' USING ERRCODE = '22023';
  END IF;
  IF p_user_subject IS NULL OR p_user_subject = '' THEN
    RAISE EXCEPTION 'user subject required' USING ERRCODE = '22023';
  END IF;
  v_subject := v_domain || ':' || p_user_subject;
  PERFORM pg_advisory_xact_lock(hashtextextended('shopify:' || v_domain, 0));

  SELECT s.tenant_id, s.id INTO v_tenant, v_store
  FROM stores s WHERE s.platform = 'shopify' AND lower(s.domain) = v_domain;

  IF v_tenant IS NULL THEN
    INSERT INTO tenants (name) VALUES (COALESCE(NULLIF(p_shop_name, ''), v_domain)) RETURNING id INTO v_tenant;
    INSERT INTO stores (tenant_id, platform, domain, name)
      VALUES (v_tenant, 'shopify', v_domain, NULLIF(p_shop_name, '')) RETURNING id INTO v_store;
  ELSE
    UPDATE tenants SET status = 'active', updated_at = now() WHERE id = v_tenant AND status <> 'active';
    UPDATE stores SET status = 'active', updated_at = now()
      WHERE tenant_id = v_tenant AND id = v_store AND status <> 'active';
  END IF;

  SELECT i.id, i.status INTO v_inst, v_inst_status
  FROM installations i WHERE i.tenant_id = v_tenant AND i.store_id = v_store AND i.host = 'shopify';

  IF v_inst IS NULL THEN
    INSERT INTO installations (tenant_id, store_id, host, status, api_version, installed_at)
      VALUES (v_tenant, v_store, 'shopify', 'active', p_api_version, now()) RETURNING id INTO v_inst;
    v_activated := true;
  ELSIF v_inst_status <> 'active' THEN
    UPDATE installations
      SET status = 'active', api_version = p_api_version, installed_at = now(), uninstalled_at = NULL, updated_at = now()
      WHERE tenant_id = v_tenant AND id = v_inst;
    v_activated := true;
  END IF;

  SELECT ui.user_id INTO v_user FROM user_identities ui WHERE ui.provider = 'shopify' AND ui.subject = v_subject;
  IF v_user IS NULL THEN
    INSERT INTO users DEFAULT VALUES RETURNING id INTO v_user;
    INSERT INTO user_identities (user_id, provider, subject) VALUES (v_user, 'shopify', v_subject);
  END IF;

  SELECT m.role INTO v_role FROM memberships m WHERE m.tenant_id = v_tenant AND m.user_id = v_user;
  IF v_role IS NULL THEN
    v_role := CASE
      WHEN EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id = v_tenant AND m.role = 'owner') THEN 'member'
      ELSE 'owner' END;
    INSERT INTO memberships (tenant_id, user_id, role) VALUES (v_tenant, v_user, v_role);
  END IF;

  RETURN QUERY SELECT v_tenant, v_store, v_inst, v_user, v_role, v_activated;
END $$;

CREATE FUNCTION resolve_membership(p_provider text, p_subject text, p_tenant uuid)
RETURNS TABLE (user_id uuid, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = sellrelay, pg_temp AS $$
  SELECT m.user_id, m.role
  FROM user_identities ui
  JOIN memberships m ON m.user_id = ui.user_id AND m.tenant_id = p_tenant
  WHERE ui.provider = p_provider AND ui.subject = p_subject
$$;

------------------------------------------------------------------------------
-- System scheduling (exception 4)
------------------------------------------------------------------------------
-- Fair claim: enumerate tenants with queued work (loose index scan), take at most
-- p_per_tenant heads per tenant, respect per-tenant and per-concurrency-key caps
-- (backpressure), serialize per entity_key, and lock with SKIP LOCKED.
CREATE FUNCTION claim_jobs(
  p_worker text,
  p_limit integer,
  p_lease_seconds integer,
  p_per_tenant integer DEFAULT 2,
  p_max_running_per_tenant integer DEFAULT 8,
  p_max_running_per_key integer DEFAULT 4,
  p_kinds text[] DEFAULT NULL
) RETURNS SETOF jobs
LANGUAGE sql SECURITY DEFINER SET search_path = sellrelay, pg_temp AS $$
WITH RECURSIVE queued_tenants AS (
  (SELECT j.tenant_id FROM jobs j WHERE j.status = 'queued' ORDER BY j.tenant_id LIMIT 1)
  UNION ALL
  SELECT (SELECT j.tenant_id FROM jobs j
          WHERE j.status = 'queued' AND j.tenant_id > qt.tenant_id ORDER BY j.tenant_id LIMIT 1)
  FROM queued_tenants qt WHERE qt.tenant_id IS NOT NULL
),
running_tenant AS (
  SELECT r.tenant_id, count(*) AS n FROM jobs r WHERE r.status = 'running' GROUP BY r.tenant_id
),
running_key AS (
  SELECT r.concurrency_key, count(*) AS n FROM jobs r
  WHERE r.status = 'running' AND r.concurrency_key IS NOT NULL GROUP BY r.concurrency_key
),
heads AS (
  SELECT h.* FROM queued_tenants qt
  CROSS JOIN LATERAL (
    SELECT j.tenant_id, j.id, j.priority, j.run_at, j.concurrency_key, j.entity_key
    FROM jobs j
    WHERE j.tenant_id = qt.tenant_id AND j.status = 'queued' AND j.run_at <= now()
      AND (p_kinds IS NULL OR j.kind = ANY (p_kinds))
    ORDER BY j.priority DESC, j.run_at, j.id
    LIMIT GREATEST(p_per_tenant, 1) * 4
  ) h
  WHERE qt.tenant_id IS NOT NULL
),
ranked AS (
  SELECT h.*,
    row_number() OVER (PARTITION BY h.tenant_id ORDER BY h.priority DESC, h.run_at, h.id) AS rn_tenant,
    row_number() OVER (PARTITION BY h.concurrency_key ORDER BY h.priority DESC, h.run_at, h.id) AS rn_key,
    row_number() OVER (PARTITION BY h.tenant_id, h.entity_key ORDER BY h.run_at, h.id) AS rn_entity
  FROM heads h
  WHERE h.entity_key IS NULL OR NOT EXISTS (
    SELECT 1 FROM jobs r WHERE r.status = 'running' AND r.tenant_id = h.tenant_id AND r.entity_key = h.entity_key)
),
eligible AS (
  SELECT r.tenant_id, r.id FROM ranked r
  LEFT JOIN running_tenant rt ON rt.tenant_id = r.tenant_id
  LEFT JOIN running_key rk ON rk.concurrency_key = r.concurrency_key
  WHERE r.rn_tenant <= LEAST(p_per_tenant, p_max_running_per_tenant - COALESCE(rt.n, 0))
    AND (r.concurrency_key IS NULL OR r.rn_key <= p_max_running_per_key - COALESCE(rk.n, 0))
    AND (r.entity_key IS NULL OR r.rn_entity = 1)
  ORDER BY r.rn_tenant, r.run_at, r.priority DESC
  LIMIT p_limit
),
locked AS (
  SELECT j.tenant_id, j.id FROM jobs j
  JOIN eligible e ON e.tenant_id = j.tenant_id AND e.id = j.id
  WHERE j.status = 'queued'
  FOR UPDATE OF j SKIP LOCKED
)
UPDATE jobs j
SET status = 'running', attempts = j.attempts + 1, lease_owner = p_worker,
    lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    started_at = now(), updated_at = now()
FROM locked l
WHERE j.tenant_id = l.tenant_id AND j.id = l.id
RETURNING j.*
$$;

-- Crash recovery: expired leases go back to the queue (or dead-letter when attempts are exhausted).
CREATE FUNCTION reclaim_expired_leases(p_limit integer DEFAULT 500) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = sellrelay, pg_temp AS $$
WITH expired AS (
  SELECT j.tenant_id, j.id FROM jobs j
  WHERE j.status = 'running' AND j.lease_expires_at < now()
  ORDER BY j.lease_expires_at LIMIT p_limit
  FOR UPDATE SKIP LOCKED
), upd AS (
  UPDATE jobs j SET
    status = CASE WHEN j.cancel_requested THEN 'cancelled'
                  WHEN j.attempts >= j.max_attempts THEN 'dead' ELSE 'queued' END,
    run_at = now() + make_interval(secs => LEAST(300, 5 * power(2, LEAST(j.attempts, 6)))),
    lease_owner = NULL, lease_expires_at = NULL,
    last_error = jsonb_build_object('code', 'lease_expired',
      'message', 'Worker lease expired (crash, stall or forced shutdown); job recovered.', 'at', now()),
    finished_at = CASE WHEN j.cancel_requested OR j.attempts >= j.max_attempts THEN now() END,
    updated_at = now()
  FROM expired e WHERE j.tenant_id = e.tenant_id AND j.id = e.id
  RETURNING 1
)
SELECT count(*)::integer FROM upd
$$;

CREATE FUNCTION claim_outbox(p_worker text, p_limit integer, p_lease_seconds integer) RETURNS SETOF outbox
LANGUAGE sql SECURITY DEFINER SET search_path = sellrelay, pg_temp AS $$
WITH c AS (
  SELECT o.tenant_id, o.id FROM outbox o
  WHERE o.dispatched_at IS NULL AND (o.claim_expires_at IS NULL OR o.claim_expires_at < now())
  ORDER BY o.occurred_at LIMIT p_limit
  FOR UPDATE SKIP LOCKED
)
UPDATE outbox o SET claimed_by = p_worker,
  claim_expires_at = now() + make_interval(secs => p_lease_seconds), attempts = o.attempts + 1
FROM c WHERE o.tenant_id = c.tenant_id AND o.id = c.id
RETURNING o.*
$$;

-- Aggregate queue metrics without tenant labels (bounded cardinality).
CREATE FUNCTION queue_stats()
RETURNS TABLE (kind text, status text, jobs bigint, oldest_age_seconds double precision)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = sellrelay, pg_temp AS $$
  SELECT j.kind, j.status, count(*),
    COALESCE(max(CASE
      WHEN j.status = 'queued' AND j.run_at <= now() THEN EXTRACT(EPOCH FROM now() - j.run_at)
      WHEN j.status = 'running' THEN EXTRACT(EPOCH FROM now() - j.started_at)
      ELSE 0 END), 0)::double precision
  FROM jobs j WHERE j.status IN ('queued', 'running', 'dead')
  GROUP BY j.kind, j.status
$$;

CREATE FUNCTION outbox_stats() RETURNS TABLE (pending bigint, oldest_age_seconds double precision)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = sellrelay, pg_temp AS $$
  SELECT count(*), COALESCE(EXTRACT(EPOCH FROM now() - min(o.occurred_at)), 0)::double precision
  FROM outbox o WHERE o.dispatched_at IS NULL
$$;

CREATE FUNCTION credentials_needing_refresh(p_horizon interval, p_limit integer)
RETURNS TABLE (tenant_id uuid, credential_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = sellrelay, pg_temp AS $$
  SELECT c.tenant_id, c.id FROM credentials c
  WHERE c.refresh_expires_at IS NOT NULL AND c.refresh_expires_at < now() + p_horizon
  ORDER BY c.refresh_expires_at LIMIT p_limit
$$;

CREATE FUNCTION active_installations(p_after_tenant uuid, p_limit integer)
RETURNS TABLE (tenant_id uuid, store_id uuid, installation_id uuid, host text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = sellrelay, pg_temp AS $$
  SELECT i.tenant_id, i.store_id, i.id, i.host FROM installations i
  WHERE i.status = 'active' AND (p_after_tenant IS NULL OR i.tenant_id > p_after_tenant)
  ORDER BY i.tenant_id, i.id LIMIT p_limit
$$;

CREATE FUNCTION purge_retention(
  p_inbox_payload_days integer, p_inbox_failed_days integer, p_activity_days integer, p_finished_jobs_days integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = sellrelay, pg_temp AS $$
DECLARE a integer; a2 integer; b integer; c integer; d integer;
BEGIN
  UPDATE webhook_inbox SET payload = NULL, payload_purged_at = now()
    WHERE payload IS NOT NULL AND status IN ('processed', 'ignored')
      AND received_at < now() - make_interval(days => p_inbox_payload_days);
  GET DIAGNOSTICS a = ROW_COUNT;
  UPDATE webhook_inbox SET payload = NULL, payload_purged_at = now()
    WHERE payload IS NOT NULL AND received_at < now() - make_interval(days => p_inbox_failed_days);
  GET DIAGNOSTICS a2 = ROW_COUNT;
  DELETE FROM activity_log WHERE occurred_at < now() - make_interval(days => p_activity_days);
  GET DIAGNOSTICS b = ROW_COUNT;
  DELETE FROM jobs WHERE status IN ('succeeded', 'cancelled')
    AND finished_at < now() - make_interval(days => p_finished_jobs_days)
    AND NOT EXISTS (SELECT 1 FROM job_replays r WHERE r.tenant_id = jobs.tenant_id AND r.job_id = jobs.id);
  GET DIAGNOSTICS c = ROW_COUNT;
  DELETE FROM outbox WHERE dispatched_at < now() - make_interval(days => p_finished_jobs_days);
  GET DIAGNOSTICS d = ROW_COUNT;
  RETURN jsonb_build_object('inbox_payloads_purged', a + a2, 'activity_deleted', b, 'jobs_deleted', c, 'outbox_deleted', d);
END $$;

-- Audited replay. INVOKER: runs under the caller's RLS (tenant admins via API).
CREATE FUNCTION replay_job(p_tenant uuid, p_job uuid, p_actor text, p_reason text) RETURNS uuid
LANGUAGE plpgsql SET search_path = sellrelay, pg_temp AS $$
DECLARE v_new uuid;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'replay reason required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO jobs (tenant_id, kind, payload, priority, max_attempts, store_id, connection_id,
                    concurrency_key, entity_key, entity_version, correlation_id, replay_of)
  SELECT j.tenant_id, j.kind, j.payload, j.priority, j.max_attempts, j.store_id, j.connection_id,
         j.concurrency_key, j.entity_key, j.entity_version, j.correlation_id, j.id
  FROM jobs j WHERE j.tenant_id = p_tenant AND j.id = p_job AND j.status IN ('dead', 'failed')
  RETURNING id INTO v_new;
  IF v_new IS NULL THEN
    RAISE EXCEPTION 'job not found or not replayable' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO job_replays (tenant_id, job_id, new_job_id, actor, reason) VALUES (p_tenant, p_job, v_new, p_actor, p_reason);
  INSERT INTO activity_log (tenant_id, category, severity, message, details, job_id)
    VALUES (p_tenant, 'jobs', 'info', 'Dead-letter job replayed',
            jsonb_build_object('actor', p_actor, 'reason', p_reason, 'new_job_id', v_new), p_job);
  RETURN v_new;
END $$;

-- Operations path for support staff (cross-tenant), audited identically.
CREATE FUNCTION ops_replay_dead_job(p_tenant uuid, p_job uuid, p_actor text, p_reason text) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = sellrelay, pg_temp AS $$
  SELECT replay_job(p_tenant, p_job, 'ops:' || p_actor, p_reason)
$$;

------------------------------------------------------------------------------
-- Ownership and privileges
------------------------------------------------------------------------------
-- Revoke PUBLIC execute while the migrator still owns the functions (a non-owner revoke is a no-op).
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA sellrelay FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA sellrelay FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE sellrelay_migrator IN SCHEMA sellrelay REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- The NOLOGIN definer role may own functions in the schema (required to transfer ownership).
GRANT USAGE, CREATE ON SCHEMA sellrelay TO sellrelay_definer;

GRANT USAGE ON SCHEMA sellrelay TO sellrelay_api, sellrelay_worker, sellrelay_ops, sellrelay_definer;
GRANT EXECUTE ON FUNCTION app_current_tenant() TO sellrelay_api, sellrelay_worker, sellrelay_ops, sellrelay_definer;

-- Definer role: table privileges it needs inside the functions above.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA sellrelay TO sellrelay_definer;
GRANT EXECUTE ON FUNCTION replay_job(uuid, uuid, text, text) TO sellrelay_definer;

-- Tenant-scoped data for runtime roles (RLS applies to every statement).
GRANT SELECT, UPDATE ON tenants TO sellrelay_api, sellrelay_worker;
GRANT SELECT ON memberships TO sellrelay_api, sellrelay_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  stores, installations, credentials, channel_connections, external_references, products, variants,
  locations, inventory_levels, webhook_inbox, outbox, jobs, job_replays, operation_ledger,
  entity_sync_state, sync_checkpoints, activity_log, billing_entitlements, usage_records, privacy_requests
TO sellrelay_api, sellrelay_worker;
GRANT SELECT ON feature_flags TO sellrelay_api, sellrelay_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON worker_heartbeats TO sellrelay_worker;

GRANT EXECUTE ON FUNCTION resolve_shopify_installation(text) TO sellrelay_api;
GRANT EXECUTE ON FUNCTION provision_shopify_installation(text, text, text, text) TO sellrelay_api;
GRANT EXECUTE ON FUNCTION resolve_membership(text, text, uuid) TO sellrelay_api;
GRANT EXECUTE ON FUNCTION replay_job(uuid, uuid, text, text) TO sellrelay_api;
GRANT EXECUTE ON FUNCTION
  claim_jobs(text, integer, integer, integer, integer, integer, text[]),
  reclaim_expired_leases(integer), claim_outbox(text, integer, integer),
  queue_stats(), outbox_stats(), credentials_needing_refresh(interval, integer),
  active_installations(uuid, integer), purge_retention(integer, integer, integer, integer)
TO sellrelay_worker;

-- Operations role: metadata reads (no credentials, no webhook payloads), flags, audited replay.
GRANT SELECT ON tenants, stores, installations, channel_connections, jobs, job_replays, activity_log,
  sync_checkpoints, privacy_requests, billing_entitlements TO sellrelay_ops;
GRANT SELECT (tenant_id, id, source, installation_id, topic, status, received_at, processed_at, last_error, duplicate_count)
  ON webhook_inbox TO sellrelay_ops;
GRANT SELECT, INSERT, UPDATE, DELETE ON feature_flags TO sellrelay_ops;
GRANT SELECT ON worker_heartbeats TO sellrelay_ops;
GRANT EXECUTE ON FUNCTION queue_stats(), outbox_stats(), ops_replay_dead_job(uuid, uuid, text, text) TO sellrelay_ops;

-- Transfer ownership last: ACL entries granted above are preserved by the ownership change.
ALTER FUNCTION resolve_shopify_installation(text) OWNER TO sellrelay_definer;
ALTER FUNCTION provision_shopify_installation(text, text, text, text) OWNER TO sellrelay_definer;
ALTER FUNCTION resolve_membership(text, text, uuid) OWNER TO sellrelay_definer;
ALTER FUNCTION claim_jobs(text, integer, integer, integer, integer, integer, text[]) OWNER TO sellrelay_definer;
ALTER FUNCTION reclaim_expired_leases(integer) OWNER TO sellrelay_definer;
ALTER FUNCTION claim_outbox(text, integer, integer) OWNER TO sellrelay_definer;
ALTER FUNCTION queue_stats() OWNER TO sellrelay_definer;
ALTER FUNCTION outbox_stats() OWNER TO sellrelay_definer;
ALTER FUNCTION credentials_needing_refresh(interval, integer) OWNER TO sellrelay_definer;
ALTER FUNCTION active_installations(uuid, integer) OWNER TO sellrelay_definer;
ALTER FUNCTION purge_retention(integer, integer, integer, integer) OWNER TO sellrelay_definer;
ALTER FUNCTION ops_replay_dead_job(uuid, uuid, text, text) OWNER TO sellrelay_definer;
