import { SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';

const tracer = trace.getTracer('sellrelay');

/** Runs fn inside an active span. A no-op tracer is used unless the SDK was started. */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (e) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: e instanceof Error ? e.name : 'error',
      });
      throw e;
    } finally {
      span.end();
    }
  });
}
