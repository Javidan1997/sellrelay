import { getNodeAutoInstrumentations } from './instrumentations.ts';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | null = null;

/**
 * Start OpenTelemetry tracing. Exports via OTLP/HTTP when OTEL_EXPORTER_OTLP_ENDPOINT is set;
 * otherwise tracing stays disabled (no-op tracer). Must run before instrumented modules load.
 */
export function startTracing(serviceName: string): boolean {
  if (sdk || !process.env['OTEL_EXPORTER_OTLP_ENDPOINT']) return false;
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: process.env['APP_VERSION'] ?? 'dev',
    }),
    traceExporter: new OTLPTraceExporter(),
    instrumentations: getNodeAutoInstrumentations(),
  });
  sdk.start();
  return true;
}

export async function stopTracing(): Promise<void> {
  await sdk?.shutdown();
  sdk = null;
}
