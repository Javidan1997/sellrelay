import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';

/** Explicit instrumentation list. SQL text is recorded without parameter values (no PII). */
export function getNodeAutoInstrumentations() {
  return [
    new HttpInstrumentation({
      // Never record headers (session tokens, HMACs).
      headersToSpanAttributes: {
        client: { requestHeaders: [], responseHeaders: [] },
        server: { requestHeaders: [], responseHeaders: [] },
      },
      ignoreIncomingRequestHook: (req) =>
        req.url === '/healthz' || req.url === '/readyz' || req.url === '/metrics',
    }),
    new PgInstrumentation({ enhancedDatabaseReporting: false }),
    new IORedisInstrumentation({ dbStatementSerializer: (cmd) => cmd }),
  ];
}
