// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { createRequire } from 'module';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';

/** Inline ExportResultCode to avoid depending on @opentelemetry/core directly. */
const ExportResultCode = { SUCCESS: 0, FAILED: 1 } as const;
type ExportResult =
  | { code: typeof ExportResultCode.SUCCESS }
  | { code: typeof ExportResultCode.FAILED; error?: Error };

interface SigV4Options {
  endpoint: string;
  service?: string;
  region?: string;
}

function resolveRegion(region?: string): string {
  const resolved =
    region ?? process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? '';
  if (!resolved) {
    throw new Error(
      "No AWS region found. Set via 'region' parameter, " +
        'AWS_DEFAULT_REGION, or AWS_REGION environment variable.',
    );
  }
  return resolved;
}

/** POST an OTLP/JSON body to `endpoint`, signed with AWS SigV4. */
async function signAndPost(
  endpoint: string,
  service: string,
  region: string,
  serialized: Uint8Array,
): Promise<void> {
  const body = Buffer.from(serialized);
  const url = new URL(endpoint);

  const { fromNodeProviderChain } = await import('@aws-sdk/credential-providers');
  const credentials = await fromNodeProviderChain()();

  const aws4Module = await import('aws4');
  const aws4 = aws4Module.default ?? aws4Module;
  const signed = aws4.sign(
    {
      service,
      region,
      method: 'POST',
      path: url.pathname + url.search,
      host: url.host,
      headers: {
        'Content-Type': 'application/json',
        Host: url.host,
      },
      body,
    },
    {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
  );

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: signed.headers as Record<string, string>,
    body,
  });

  if (!response.ok) {
    throw new Error(`Export failed: ${response.status} ${response.statusText}`);
  }
}

function toCallback(
  promise: Promise<void>,
  resultCallback: (result: ExportResult) => void,
  pending: Set<Promise<void>>,
): void {
  const tracked = promise.then(
    () => resultCallback({ code: ExportResultCode.SUCCESS }),
    (error: unknown) =>
      resultCallback({
        code: ExportResultCode.FAILED,
        error: error instanceof Error ? error : new Error(String(error)),
      }),
  );
  pending.add(tracked);
  void tracked.finally(() => pending.delete(tracked));
}

/** Wait for in-flight exports (used by forceFlush and shutdown). */
async function drain(pending: Set<Promise<void>>): Promise<void> {
  await Promise.all(Array.from(pending));
}

/**
 * An OTLP trace exporter that signs HTTP requests with AWS SigV4.
 * Uses JSON serialization and sends traces to an AWS endpoint (e.g., OSIS pipeline).
 */
export class AWSSigV4OTLPExporter implements SpanExporter {
  private _endpoint: string;
  private _service: string;
  private _region: string;
  private _pending = new Set<Promise<void>>();

  constructor(options: SigV4Options) {
    this._endpoint = options.endpoint;
    this._service = options.service ?? 'osis';
    this._region = resolveRegion(options.region);
  }

  get endpoint(): string {
    return this._endpoint;
  }

  get service(): string {
    return this._service;
  }

  get region(): string {
    return this._region;
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    toCallback(this._export(spans), resultCallback, this._pending);
  }

  async shutdown(): Promise<void> {
    await drain(this._pending);
  }

  async forceFlush(): Promise<void> {
    await drain(this._pending);
  }

  private async _export(spans: ReadableSpan[]): Promise<void> {
    // @opentelemetry/otlp-transformer is a transitive dep of
    // @opentelemetry/exporter-trace-otlp-http, available at runtime.
    // @ts-expect-error — not in direct deps but guaranteed present
    const transformer: { JsonTraceSerializer: { serializeRequest(spans: ReadableSpan[]): Uint8Array | undefined } } = await import('@opentelemetry/otlp-transformer');
    const serialized = transformer.JsonTraceSerializer.serializeRequest(spans);
    if (!serialized) {
      throw new Error('Failed to serialize spans');
    }
    await signAndPost(this._endpoint, this._service, this._region, serialized);
  }
}

interface LogsSerializer {
  serializeRequest(logs: ReadableLogRecord[]): Uint8Array | undefined;
}

let logsSerializer: LogsSerializer | undefined;

/**
 * Load JsonLogsSerializer from the otlp-transformer that
 * @opentelemetry/exporter-logs-otlp-http depends on. The trace exporters pull
 * in an older otlp-transformer that does not serialize LogRecord.eventName,
 * so resolve relative to the logs exporter rather than from this package.
 */
function loadLogsSerializer(): LogsSerializer {
  if (!logsSerializer) {
    const localRequire = createRequire(import.meta.url);
    const logsExporterPath = localRequire.resolve('@opentelemetry/exporter-logs-otlp-http');
    const transformer = createRequire(logsExporterPath)('@opentelemetry/otlp-transformer') as {
      JsonLogsSerializer: LogsSerializer;
    };
    logsSerializer = transformer.JsonLogsSerializer;
  }
  return logsSerializer;
}

/** Attributes that OTel semconv types as double. */
const DOUBLE_ATTRIBUTES: ReadonlySet<string> = new Set([
  "gen_ai.evaluation.score.value",
  "opensearch.evaluation.score.min",
  "opensearch.evaluation.score.max",
  "opensearch.evaluation.score.threshold",
  "opensearch.test_case.duration_ms",
  "opensearch.test_suite_run.duration_ms",
]);

interface OtlpKeyValue {
  key?: string;
  value?: { intValue?: number | string; doubleValue?: number };
}

/**
 * Re-encode whole-number values of double-typed attributes in an OTLP/JSON
 * logs request as `doubleValue`. OTel JS encodes any integral JS number as
 * `intValue`, and the logs API has no way to ask for a double, so a score of
 * `1` would otherwise arrive as an int64.
 */
export function forceDoubleAttributes(serialized: Uint8Array): Uint8Array {
  const text = Buffer.from(serialized).toString("utf8");
  if (!text.includes('"intValue"')) return serialized;
  const request = JSON.parse(text) as {
    resourceLogs?: { scopeLogs?: { logRecords?: { attributes?: OtlpKeyValue[] }[] }[] }[];
  };
  let changed = false;
  for (const rl of request.resourceLogs ?? []) {
    for (const sl of rl.scopeLogs ?? []) {
      for (const record of sl.logRecords ?? []) {
        for (const kv of record.attributes ?? []) {
          const value = kv.value;
          if (!kv.key || !DOUBLE_ATTRIBUTES.has(kv.key) || value?.intValue === undefined) continue;
          value.doubleValue = Number(value.intValue);
          delete value.intValue;
          changed = true;
        }
      }
    }
  }
  return changed ? new Uint8Array(Buffer.from(JSON.stringify(request), "utf8")) : serialized;
}

function doubleAttributesSerializer(base: LogsSerializer): LogsSerializer {
  return {
    serializeRequest(logs: ReadableLogRecord[]): Uint8Array | undefined {
      const serialized = base.serializeRequest(logs);
      return serialized ? forceDoubleAttributes(serialized) : serialized;
    },
  };
}

/**
 * Make an `@opentelemetry/exporter-logs-otlp-http` OTLPLogExporter send
 * double-typed attributes (for example `gen_ai.evaluation.score.value`) as
 * `doubleValue` even when the value is a whole number. Wraps the exporter's
 * OTLP/JSON serializer; returns false (and changes nothing) when the exporter
 * does not have the expected internals.
 */
export function sendScoresAsDouble(exporter: unknown): boolean {
  const delegate = (exporter as { _delegate?: { _serializer?: LogsSerializer & { deserializeResponse?: unknown } } })
    ?._delegate;
  const serializer = delegate?._serializer;
  if (!delegate || typeof serializer?.serializeRequest !== "function") return false;
  delegate._serializer = { ...serializer, ...doubleAttributesSerializer(serializer) };
  return true;
}

/**
 * An OTLP log exporter that signs HTTP requests with AWS SigV4 (OTLP/JSON).
 * Used for `gen_ai.evaluation.result` events sent to an AWS endpoint
 * (for example an OSIS logs pipeline).
 */
export class AWSSigV4OTLPLogExporter implements LogRecordExporter {
  private _endpoint: string;
  private _service: string;
  private _region: string;
  private _pending = new Set<Promise<void>>();

  constructor(options: SigV4Options) {
    this._endpoint = options.endpoint;
    this._service = options.service ?? 'osis';
    this._region = resolveRegion(options.region);
  }

  get endpoint(): string {
    return this._endpoint;
  }

  export(
    logs: ReadableLogRecord[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    toCallback(this._export(logs), resultCallback, this._pending);
  }

  async shutdown(): Promise<void> {
    await drain(this._pending);
  }

  async forceFlush(): Promise<void> {
    await drain(this._pending);
  }

  private async _export(logs: ReadableLogRecord[]): Promise<void> {
    const serialized = doubleAttributesSerializer(loadLogsSerializer()).serializeRequest(logs);
    if (!serialized) {
      throw new Error('Failed to serialize log records');
    }
    await signAndPost(this._endpoint, this._service, this._region, serialized);
  }
}
