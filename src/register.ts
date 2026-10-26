// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { Resource } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  BatchSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { logs } from "@opentelemetry/api-logs";
import {
  LoggerProvider,
  BatchLogRecordProcessor,
  SimpleLogRecordProcessor,
  type LogRecordExporter,
  type LoggerProviderConfig,
} from "@opentelemetry/sdk-logs";
import { AWSSigV4OTLPExporter, AWSSigV4OTLPLogExporter } from "./exporters.js";
import { hasGlobalLoggerProvider, getSdkLoggerProvider, setSdkLoggerProvider } from "./logs.js";

export const DEFAULT_ENDPOINT =
  "http://localhost:21890/opentelemetry/v1/traces";

/** Default OTLP/HTTP logs endpoint, derived from DEFAULT_ENDPOINT. */
export const DEFAULT_LOGS_ENDPOINT =
  "http://localhost:21890/opentelemetry/v1/logs";

export interface RegisterOptions {
  endpoint?: string;
  protocol?: "http" | "grpc";
  projectName?: string;
  serviceName?: string;
  serviceVersion?: string;
  batch?: boolean;
  autoInstrument?: boolean;
  exporter?: SpanExporter;
  setGlobal?: boolean;
  headers?: Record<string, string>;
  /**
   * Set up a LoggerProvider for `gen_ai.evaluation.result` events emitted by
   * score(). Default true. Skipped when a global LoggerProvider is already
   * registered (it is never replaced; score() then uses it).
   */
  logs?: boolean;
  /**
   * OTLP/HTTP logs endpoint. Default: OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, else
   * the traces endpoint with `/v1/traces` replaced by `/v1/logs`.
   */
  logsEndpoint?: string;
  /**
   * Custom log exporter. When `exporter` is an AWSSigV4OTLPExporter and this
   * is not set, an AWSSigV4OTLPLogExporter with the same service and region
   * is created for the logs endpoint.
   */
  logExporter?: LogRecordExporter;
}

const INSTRUMENTOR_PACKAGES = [
  "@opentelemetry/instrumentation-openai",
];

function resolveEndpoint(options: RegisterOptions): string {
  if (options.endpoint) return options.endpoint;

  const tracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (tracesEndpoint) return tracesEndpoint;

  const baseEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (baseEndpoint) {
    const base = baseEndpoint.replace(/\/+$/, "");
    return `${base}/v1/traces`;
  }

  return DEFAULT_ENDPOINT;
}

function resolveProtocol(
  options: RegisterOptions,
  endpoint: string,
): "http" | "grpc" {
  if (options.protocol) return options.protocol;

  const tracesProtocol = process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL;
  if (tracesProtocol === "grpc") return "grpc";
  if (tracesProtocol) return "http";

  const protocol = process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
  if (protocol === "grpc") return "grpc";
  if (protocol) return "http";

  // Infer from URL scheme
  try {
    const url = new URL(endpoint);
    if (url.protocol === "grpc:" || url.protocol === "grpcs:") return "grpc";
  } catch {
    // ignore
  }

  return "http";
}

async function createExporter(
  protocol: "http" | "grpc",
  endpoint: string,
  headers?: Record<string, string>,
): Promise<SpanExporter> {
  if (protocol === "grpc") {
    const { OTLPTraceExporter } = await import(
      "@opentelemetry/exporter-trace-otlp-grpc"
    );
    return new OTLPTraceExporter({ url: endpoint, headers });
  }
  const { OTLPTraceExporter } = await import(
    "@opentelemetry/exporter-trace-otlp-http"
  );
  return new OTLPTraceExporter({ url: endpoint, headers });
}

const LOGS_SUFFIX_RE = /\/v1\/traces\/?$/;

/** Swap a trailing /v1/traces for /v1/logs. Returns null if there is no such suffix. */
function tracesToLogsUrl(url: string): string | null {
  return LOGS_SUFFIX_RE.test(url) ? url.replace(LOGS_SUFFIX_RE, "/v1/logs") : null;
}

export function resolveLogsEndpoint(
  options: RegisterOptions,
  tracesEndpoint: string,
  protocol: "http" | "grpc",
): string | null {
  if (options.logsEndpoint) return options.logsEndpoint;

  const logsEnv = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  if (logsEnv) return logsEnv;

  // gRPC traces endpoints cannot be reused for the OTLP/HTTP logs exporter.
  if (protocol === "grpc") return null;

  if (
    !options.endpoint &&
    !process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT &&
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  ) {
    return `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/+$/, "")}/v1/logs`;
  }

  return tracesToLogsUrl(tracesEndpoint);
}

type LogsResource = NonNullable<LoggerProviderConfig["resource"]>;

/**
 * Minimal Resource for the logs SDK. The logs SDK is on the OTel JS 2.x line
 * while traces use @opentelemetry/resources 1.x, so a 1.x Resource cannot be
 * passed directly. Same attributes as the trace resource.
 */
function logsResource(attributes: Record<string, string>): LogsResource {
  const resource: LogsResource = {
    attributes,
    getRawAttributes: () => Object.entries(attributes),
    merge: (other) =>
      other ? logsResource({ ...attributes, ...(other.attributes as Record<string, string>) }) : resource,
  };
  return resource;
}

export async function createLogExporter(
  options: RegisterOptions,
  tracesEndpoint: string,
  protocol: "http" | "grpc",
): Promise<LogRecordExporter | null> {
  if (options.logExporter) return options.logExporter;
  if (options.exporter instanceof AWSSigV4OTLPExporter) {
    // Same auth as traces: sign log exports with the same service and region.
    const endpoint =
      options.logsEndpoint ??
      process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ??
      tracesToLogsUrl(options.exporter.endpoint);
    if (!endpoint) return null;
    return new AWSSigV4OTLPLogExporter({
      endpoint,
      service: options.exporter.service,
      region: options.exporter.region,
    });
  }
  const logsEndpoint = resolveLogsEndpoint(options, tracesEndpoint, protocol);
  if (!logsEndpoint) return null;
  const { OTLPLogExporter } = await import("@opentelemetry/exporter-logs-otlp-http");
  return new OTLPLogExporter({ url: logsEndpoint, headers: options.headers });
}

async function setupLogs(
  options: RegisterOptions,
  tracesEndpoint: string,
  protocol: "http" | "grpc",
  resourceAttrs: Record<string, string>,
  setGlobal: boolean,
): Promise<LoggerProvider | null> {
  if (options.logs === false) return null;
  const previous = getSdkLoggerProvider();
  const globalIsOurs = previous !== undefined && logs.getLoggerProvider() === previous;
  if (setGlobal && hasGlobalLoggerProvider() && !globalIsOurs) {
    // Respect a user-configured global LoggerProvider; score() emits through it.
    return null;
  }

  const exporter = await createLogExporter(options, tracesEndpoint, protocol);
  if (!exporter) {
    console.warn(
      "[opensearch-genai-observability-sdk-ts] register(): could not derive an OTLP/HTTP logs " +
        "endpoint, so score() evaluation events will not be exported. Pass logsEndpoint " +
        "or set OTEL_EXPORTER_OTLP_LOGS_ENDPOINT.",
    );
    return null;
  }

  const processor =
    options.batch === false
      ? new SimpleLogRecordProcessor({ exporter })
      : new BatchLogRecordProcessor({ exporter });
  const loggerProvider = new LoggerProvider({
    resource: logsResource(resourceAttrs),
    processors: [processor],
  });

  // Replace a provider left over from a previous register() call.
  if (previous instanceof LoggerProvider) {
    await previous.shutdown().catch(() => {});
  }
  if (globalIsOurs) logs.disable();
  setSdkLoggerProvider(loggerProvider);
  if (setGlobal) {
    logs.setGlobalLoggerProvider(loggerProvider);
  }
  return loggerProvider;
}

/** Make provider.forceFlush()/shutdown() also flush/shut down the logs pipeline. */
function chainLoggerProvider(
  provider: BasicTracerProvider,
  loggerProvider: LoggerProvider,
): void {
  const flushTraces = provider.forceFlush.bind(provider);
  const shutdownTraces = provider.shutdown.bind(provider);

  provider.forceFlush = async () => {
    await Promise.all([flushTraces(), loggerProvider.forceFlush()]);
  };
  provider.shutdown = async () => {
    try {
      await Promise.all([shutdownTraces(), loggerProvider.shutdown()]);
    } finally {
      if (getSdkLoggerProvider() === loggerProvider) setSdkLoggerProvider(undefined);
      if (logs.getLoggerProvider() === loggerProvider) logs.disable();
    }
  };
}

async function tryAutoInstrument(): Promise<void> {
  for (const pkg of INSTRUMENTOR_PACKAGES) {
    try {
      const mod = await import(pkg);
      if (typeof mod?.register === "function") {
        mod.register();
      } else if (typeof mod?.default?.register === "function") {
        mod.default.register();
      }
    } catch {
      // Package not installed, skip
    }
  }
}

export async function register(
  options: RegisterOptions = {},
): Promise<BasicTracerProvider> {
  const endpoint = resolveEndpoint(options);
  const protocol = resolveProtocol(options, endpoint);

  const serviceName =
    options.serviceName ?? options.projectName ?? "unknown_service";
  const resourceAttrs: Record<string, string> = {
    "service.name": serviceName,
  };
  if (options.serviceVersion) {
    resourceAttrs["service.version"] = options.serviceVersion;
  }

  const resource = new Resource(resourceAttrs);
  const provider = new BasicTracerProvider({ resource });

  const exporter =
    options.exporter ?? (await createExporter(protocol, endpoint, options.headers));

  const processor =
    options.batch === false
      ? new SimpleSpanProcessor(exporter)
      : new BatchSpanProcessor(exporter);
  provider.addSpanProcessor(processor);

  const setGlobal = options.setGlobal ?? true;
  if (setGlobal) {
    provider.register();
  }

  const loggerProvider = await setupLogs(
    options,
    endpoint,
    protocol,
    resourceAttrs,
    setGlobal,
  );
  if (loggerProvider) {
    chainLoggerProvider(provider, loggerProvider);
  }

  const autoInstrument = options.autoInstrument ?? true;
  if (autoInstrument) {
    tryAutoInstrument().catch(() => {});
  }

  return provider;
}
