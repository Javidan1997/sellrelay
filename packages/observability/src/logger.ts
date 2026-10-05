import { pino, type Logger, type LoggerOptions } from 'pino';
import { currentContext } from './context.ts';
import { redact, redactText } from './redact.ts';

export type { Logger } from 'pino';

/** Structured JSON logger: correlation/tenant/connection/job IDs injected; secrets and PII redacted. */
export function createLogger(service: string, options: LoggerOptions = {}): Logger {
  return pino({
    level: process.env['LOG_LEVEL'] ?? 'info',
    base: { service },
    messageKey: 'msg',
    timestamp: pino.stdTimeFunctions.isoTime,
    mixin() {
      const ctx = currentContext();
      if (!ctx) return {};
      return {
        correlation_id: ctx.correlationId,
        ...(ctx.tenantId ? { tenant_id: ctx.tenantId } : {}),
        ...(ctx.connectionId ? { connection_id: ctx.connectionId } : {}),
        ...(ctx.storeId ? { store_id: ctx.storeId } : {}),
        ...(ctx.jobId ? { job_id: ctx.jobId } : {}),
        ...(ctx.jobKind ? { job_kind: ctx.jobKind } : {}),
      };
    },
    hooks: {
      logMethod(args, method) {
        const scrubbed = args.map((a) => (typeof a === 'string' ? redactText(a) : redact(a)));
        method.apply(this, scrubbed as Parameters<typeof method>);
      },
    },
    serializers: {
      err: (e: unknown) => {
        if (e instanceof Error)
          return {
            type: e.name,
            message: redactText(e.message),
            stack: e.stack ? redactText(e.stack) : undefined,
          };
        return redact(e);
      },
    },
    ...options,
  });
}
