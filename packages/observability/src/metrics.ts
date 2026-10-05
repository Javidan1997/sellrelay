import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Metrics with bounded label cardinality: provider, kind, status, error class, scope.
 * Never label by tenant, job, store or connection ID.
 */
export function createMetrics(service: string) {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry });

  return {
    registry,
    httpRequests: new Counter({
      name: 'sellrelay_http_requests_total',
      help: 'HTTP requests by route template and status class',
      labelNames: ['method', 'route', 'status_class'] as const,
      registers: [registry],
    }),
    queueDepth: new Gauge({
      name: 'sellrelay_queue_jobs',
      help: 'Jobs by kind and status',
      labelNames: ['kind', 'status'] as const,
      registers: [registry],
    }),
    queueOldestAge: new Gauge({
      name: 'sellrelay_queue_oldest_age_seconds',
      help: 'Age of the oldest due job by kind and status',
      labelNames: ['kind', 'status'] as const,
      registers: [registry],
    }),
    outboxPending: new Gauge({
      name: 'sellrelay_outbox_pending',
      help: 'Undispatched outbox events',
      registers: [registry],
    }),
    outboxOldestAge: new Gauge({
      name: 'sellrelay_outbox_oldest_age_seconds',
      help: 'Age of the oldest undispatched outbox event',
      registers: [registry],
    }),
    jobDuration: new Histogram({
      name: 'sellrelay_job_duration_seconds',
      help: 'Job execution time by kind and outcome',
      labelNames: ['kind', 'outcome'] as const,
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
      registers: [registry],
    }),
    syncLatency: new Histogram({
      name: 'sellrelay_sync_latency_seconds',
      help: 'Ingestion-to-completion latency including queue wait, by provider and kind',
      labelNames: ['provider', 'kind'] as const,
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 90, 120, 180, 300, 600],
      registers: [registry],
    }),
    jobRetries: new Counter({
      name: 'sellrelay_job_retries_total',
      help: 'Job retries by kind and error code',
      labelNames: ['kind', 'code'] as const,
      registers: [registry],
    }),
    connectorErrors: new Counter({
      name: 'sellrelay_connector_errors_total',
      help: 'Provider errors by provider and error code',
      labelNames: ['provider', 'code'] as const,
      registers: [registry],
    }),
    rateLimitWaits: new Counter({
      name: 'sellrelay_rate_limit_wait_seconds_total',
      help: 'Time spent waiting for provider budgets, by provider and scope',
      labelNames: ['provider', 'scope'] as const,
      registers: [registry],
    }),
    webhooks: new Counter({
      name: 'sellrelay_webhooks_total',
      help: 'Inbound webhooks by source, topic and result',
      labelNames: ['source', 'topic', 'result'] as const,
      registers: [registry],
    }),
    workerInFlight: new Gauge({
      name: 'sellrelay_worker_in_flight',
      help: 'Jobs currently executing',
      registers: [registry],
    }),
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
