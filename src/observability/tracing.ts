/**
 * OpenTelemetry SDK bootstrap.
 *
 * MUST be imported as the very first thing in `main.ts`, before any module
 * that we want auto-instrumented (HTTP, pg, ioredis, express, ...).
 *
 * Configuration follows the standard OTel env vars so this file stays
 * deployment-agnostic:
 *   - OTEL_SERVICE_NAME           (default: pos-transactions-api)
 *   - OTEL_EXPORTER_OTLP_ENDPOINT (default: http://jaeger:4318)
 *   - OTEL_TRACES_SAMPLER         (default: parentbased_always_on)
 *   - OTEL_SDK_DISABLED=true      to short-circuit in environments without a collector
 */
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';

let started = false;

export function startTracing(): NodeSDK | null {
  if (started) return null;
  if (process.env.OTEL_SDK_DISABLED === 'true') return null;

  if (process.env.OTEL_LOG_LEVEL === 'debug') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  const serviceName =
    process.env.OTEL_SERVICE_NAME ?? 'pos-transactions-api';
  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://jaeger:4318';

  const sdk = new NodeSDK({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
      [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]:
        process.env.NODE_ENV ?? 'development',
    }),
    traceExporter: new OTLPTraceExporter({
      url: `${endpoint.replace(/\/$/, '')}/v1/traces`,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Health endpoint is high-volume and uninteresting in traces.
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (req) => req.url === '/health',
        },
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();
  started = true;

  process.on('SIGTERM', () => {
    sdk
      .shutdown()
      .catch((err) => console.error('OTel shutdown error', err))
      .finally(() => process.exit(0));
  });

  return sdk;
}
