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
import { AWSSigV4OTLPExporter, AWSSigV4OTLPLogExporter, sendScoresAsDouble } from "./exporters.js";
import { installTestCaseProcessor } from "./testcase.js";
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
   * OTLP/HTTP logs endpoint (full URL) for evaluation events. Default:
   * OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, else derived from the traces endpoint
   * only when it ends in `/v1/traces`, else OTEL_EXPORTER_OTLP_ENDPOINT +
   * `/v1/logs`. When nothing applies, register() warns and skips logs.
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

/** Result of logs endpoint resolution: a URL, or why none could be chosen. */
export type LogsEndpointResolution =
  | { url: string; reason?: undefined }
  | { url: null; reason: string };

function derived(tracesUrl: string, source: string): LogsEndpointResolution {
  const url = tracesToLogsUrl(tracesUrl);
  if (url) return { url };
  return {
    url: null,
    reason:
      `${source} "${tracesUrl}" does not end in /v1/traces, so no logs endpoint can be ` +
      `derived from it`,
  };
}

/**
 * Resolve the OTLP/HTTP logs endpoint for evaluation events.
 *
 * 1. `logsEndpoint` option (full URL, used as-is)
 * 2. `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` (full URL, used as-is)
 * 3. `endpoint` option, only if it ends in `/v1/traces` (swapped for `/v1/logs`)
 * 4. `OTEL_EXPORTER_OTLP_ENDPOINT` (base URL, `/v1/logs` appended)
 * 5. `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, only if it ends in `/v1/traces`
 * 6. No traces endpoint configured: DEFAULT_LOGS_ENDPOINT
 *
 * With a gRPC traces exporter only 1 and 2 apply (the logs exporter is OTLP/HTTP).
 * Otherwise `url` is null and `reason` says why.
 */
export function resolveLogsEndpoint(
  options: RegisterOptions,
  protocol: "http" | "grpc",
): LogsEndpointResolution {
  if (options.logsEndpoint) return { url: options.logsEndpoint };

  const logsEnv = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  if (logsEnv) return { url: logsEnv };

  if (protocol === "grpc") {
    return {
      url: null,
      reason: "traces are exported over gRPC and the evaluation logs exporter is OTLP/HTTP",
    };
  }

  if (options.endpoint) return derived(options.endpoint, "traces endpoint");

  const baseEnv = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (baseEnv) return { url: `${baseEnv.replace(/\/+$/, "")}/v1/logs` };

  const tracesEnv = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (tracesEnv) return derived(tracesEnv, "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT");

  return { url: DEFAULT_LOGS_ENDPOINT };
}

/**
 * Logs endpoint for a SigV4 (OSIS) trace exporter: `logsEndpoint`, else
 * `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, else the exporter's URL only if it ends
 * in `/v1/traces`. An OSIS logs pipeline usually has its own URL: pass it.
 */
export function resolveSigV4LogsEndpoint(
  options: RegisterOptions,
  exporter: AWSSigV4OTLPExporter,
): LogsEndpointResolution {
  if (options.logsEndpoint) return { url: options.logsEndpoint };
  const logsEnv = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  if (logsEnv) return { url: logsEnv };
  return derived(exporter.endpoint, "AWSSigV4OTLPExporter endpoint");
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

/** A log exporter for evaluation events, or why none was created. */
export type LogExporterResolution =
  | { exporter: LogRecordExporter; reason?: undefined }
  | { exporter: null; reason: string };

export async function createLogExporter(
  options: RegisterOptions,
  protocol: "http" | "grpc",
): Promise<LogExporterResolution> {
  if (options.logExporter) return { exporter: options.logExporter };
  if (options.exporter instanceof AWSSigV4OTLPExporter) {
    // Same auth as traces: sign log exports with the same service and region.
    const resolved = resolveSigV4LogsEndpoint(options, options.exporter);
    if (resolved.url === null) {
      return {
        exporter: null,
        reason:
          `${resolved.reason}. An OSIS logs pipeline has its own URL: pass ` +
          `logsEndpoint (for example https://<logs-pipeline>.<region>.osis.amazonaws.com/v1/logs)`,
      };
    }
    return {
      exporter: new AWSSigV4OTLPLogExporter({
        endpoint: resolved.url,
        service: options.exporter.service,
        region: options.exporter.region,
      }),
    };
  }
  if (options.exporter) {
    // A custom span exporter says nothing about where logs should go.
    const url = options.logsEndpoint || process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    if (!url) {
      return {
        exporter: null,
        reason: "a custom exporter was passed without logsEndpoint or logExporter",
      };
    }
    return { exporter: await otlpHttpLogExporter(url, options.headers) };
  }
  const resolved = resolveLogsEndpoint(options, protocol);
  if (resolved.url === null) return { exporter: null, reason: resolved.reason };
  return { exporter: await otlpHttpLogExporter(resolved.url, options.headers) };
}

async function otlpHttpLogExporter(
  url: string,
  headers?: Record<string, string>,
): Promise<LogRecordExporter> {
  const { OTLPLogExporter } = await import("@opentelemetry/exporter-logs-otlp-http");
  const exporter = new OTLPLogExporter({ url, headers });
  sendScoresAsDouble(exporter);
  return exporter;
}

async function setupLogs(
  options: RegisterOptions,
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

  const { exporter, reason } = await createLogExporter(options, protocol);
  if (!exporter) {
    console.warn(
      `[opensearch-genai-observability-sdk-ts] register(): evaluation logs are NOT exported: ` +
        `${reason}. score() and evaluate() events are dropped. Pass logsEndpoint ` +
        `(or logExporter), or set OTEL_EXPORTER_OTLP_LOGS_ENDPOINT.`,
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
  // Stamps test.* ids on agent root spans while evaluate() runs a test case.
  installTestCaseProcessor(provider);
  provider.addSpanProcessor(processor);

  const setGlobal = options.setGlobal ?? true;
  if (setGlobal) {
    provider.register();
  }

  const loggerProvider = await setupLogs(
    options,
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
