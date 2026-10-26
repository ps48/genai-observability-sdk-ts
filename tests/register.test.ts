// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { logs } from '@opentelemetry/api-logs';
import {
  LoggerProvider,
  SimpleLogRecordProcessor,
  InMemoryLogRecordExporter,
} from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import {
  register,
  createLogExporter,
  resolveLogsEndpoint,
  DEFAULT_ENDPOINT,
  DEFAULT_LOGS_ENDPOINT,
} from '../src/register.js';
import { score } from '../src/score.js';
import { getSdkLoggerProvider, setSdkLoggerProvider } from '../src/logs.js';
import { AWSSigV4OTLPExporter, AWSSigV4OTLPLogExporter } from '../src/exporters.js';

describe('DEFAULT_ENDPOINT', () => {
  it('has the expected value', () => {
    expect(DEFAULT_ENDPOINT).toBe('http://localhost:21890/opentelemetry/v1/traces');
  });
});

describe('register', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL;
    delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
    delete process.env.OTEL_SERVICE_NAME;
    delete process.env.OTEL_SERVICE_VERSION;
    delete process.env.OPENSEARCH_PROJECT;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns a BasicTracerProvider', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = await register({
      exporter,
      setGlobal: false,
      autoInstrument: false,
    });
    expect(provider).toBeDefined();
    expect(typeof provider.getTracer).toBe('function');
    await provider.shutdown();
  });

  it('uses custom exporter', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = await register({
      exporter,
      batch: false,
      setGlobal: false,
      autoInstrument: false,
    });

    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test-span');
    span.end();

    // Force flush to ensure spans are exported
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThanOrEqual(1);
    expect(spans[0].name).toBe('test-span');
    await provider.shutdown();
  });

  it('sets service name from options', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = await register({
      serviceName: 'my-service',
      exporter,
      setGlobal: false,
      autoInstrument: false,
    });

    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test');
    span.end();
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThanOrEqual(1);
    const resource = spans[0].resource;
    expect(resource.attributes['service.name']).toBe('my-service');
    await provider.shutdown();
  });

  it('falls back to projectName for service name', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = await register({
      projectName: 'my-project',
      exporter,
      setGlobal: false,
      autoInstrument: false,
    });

    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test');
    span.end();
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const resource = spans[0].resource;
    expect(resource.attributes['service.name']).toBe('my-project');
    await provider.shutdown();
  });

  it('sets service version from options', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = await register({
      serviceName: 'svc',
      serviceVersion: '1.2.3',
      exporter,
      setGlobal: false,
      autoInstrument: false,
    });

    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test');
    span.end();
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const resource = spans[0].resource;
    expect(resource.attributes['service.version']).toBe('1.2.3');
    await provider.shutdown();
  });

  it('uses SimpleSpanProcessor when batch=false', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = await register({
      exporter,
      batch: false,
      setGlobal: false,
      autoInstrument: false,
    });
    expect(provider).toBeDefined();
    await provider.shutdown();
  });

  it('uses BatchSpanProcessor by default', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = await register({
      exporter,
      setGlobal: false,
      autoInstrument: false,
    });
    expect(provider).toBeDefined();
    await provider.shutdown();
  });
});

describe('register - endpoint resolution', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses explicit endpoint', async () => {
    const exporter = new InMemorySpanExporter();
    // Just verify it doesn't throw with custom endpoint
    const provider = await register({
      endpoint: 'http://custom:4318/v1/traces',
      exporter,
      setGlobal: false,
      autoInstrument: false,
    });
    expect(provider).toBeDefined();
    await provider.shutdown();
  });

  it('falls back to OTEL_EXPORTER_OTLP_TRACES_ENDPOINT env var', async () => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://traces-endpoint:4318/v1/traces';
    const exporter = new InMemorySpanExporter();
    const provider = await register({
      exporter,
      setGlobal: false,
      autoInstrument: false,
    });
    expect(provider).toBeDefined();
    await provider.shutdown();
  });

  it('falls back to OTEL_EXPORTER_OTLP_ENDPOINT with /v1/traces suffix', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://base-endpoint:4318';
    const exporter = new InMemorySpanExporter();
    const provider = await register({
      exporter,
      setGlobal: false,
      autoInstrument: false,
    });
    expect(provider).toBeDefined();
    await provider.shutdown();
  });
});

describe('register - logs pipeline for evaluation events', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL;
    delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
    delete process.env.OPENSEARCH_GENAI_EVAL_CARRIER;
  });

  afterEach(() => {
    process.env = originalEnv;
    logs.disable();
    setSdkLoggerProvider(undefined);
  });

  it('exports score() events through the configured log exporter', async () => {
    const logExporter = new InMemoryLogRecordExporter();
    const provider = await register({
      serviceName: 'eval-svc',
      exporter: new InMemorySpanExporter(),
      logExporter,
      batch: false,
      setGlobal: false,
      autoInstrument: false,
    });

    score({ name: 'relevance', value: 0.9, traceId: 'abcdef1234567890abcdef1234567890', spanId: '1234567890abcdef' });
    await provider.forceFlush();

    const records = logExporter.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    expect(records[0].eventName).toBe('gen_ai.evaluation.result');
    expect(records[0].spanContext?.spanId).toBe('1234567890abcdef');
    expect(records[0].resource.attributes['service.name']).toBe('eval-svc');
    await provider.shutdown();
  });

  it('provider.forceFlush() flushes batched log events', async () => {
    const logExporter = new InMemoryLogRecordExporter();
    const provider = await register({
      exporter: new InMemorySpanExporter(),
      logExporter,
      setGlobal: false,
      autoInstrument: false,
    });
    score({ name: 'x', value: 1 });
    expect(logExporter.getFinishedLogRecords()).toHaveLength(0);
    await provider.forceFlush();
    expect(logExporter.getFinishedLogRecords()).toHaveLength(1);
    await provider.shutdown();
  });

  it('provider.shutdown() also shuts down the logs pipeline', async () => {
    const logExporter = new InMemoryLogRecordExporter();
    const shutdownSpy = vi.spyOn(logExporter, 'shutdown');
    const provider = await register({
      exporter: new InMemorySpanExporter(),
      logExporter,
      setGlobal: false,
      autoInstrument: false,
    });
    expect(getSdkLoggerProvider()).toBeDefined();
    await provider.shutdown();
    expect(shutdownSpy).toHaveBeenCalled();
    expect(getSdkLoggerProvider()).toBeUndefined();
  });

  it('registers the LoggerProvider globally when setGlobal is true', async () => {
    const logExporter = new InMemoryLogRecordExporter();
    const provider = await register({
      exporter: new InMemorySpanExporter(),
      logExporter,
      autoInstrument: false,
    });
    const sdkProvider = getSdkLoggerProvider();
    expect(sdkProvider).toBeDefined();
    expect(logs.getLoggerProvider()).toBe(sdkProvider);
    await provider.shutdown();
    // our global is removed on shutdown so a later register() can install a new one
    expect(logs.getLoggerProvider()).not.toBe(sdkProvider);
  });

  it('does not clobber a user-configured global LoggerProvider', async () => {
    const userExporter = new InMemoryLogRecordExporter();
    const userProvider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor({ exporter: userExporter })],
    });
    logs.setGlobalLoggerProvider(userProvider);

    const sdkExporter = new InMemoryLogRecordExporter();
    const provider = await register({
      exporter: new InMemorySpanExporter(),
      logExporter: sdkExporter,
      autoInstrument: false,
    });

    expect(logs.getLoggerProvider()).toBe(userProvider);
    expect(getSdkLoggerProvider()).toBeUndefined();
    score({ name: 'x', value: 1 });
    expect(userExporter.getFinishedLogRecords()).toHaveLength(1);
    expect(sdkExporter.getFinishedLogRecords()).toHaveLength(0);
    await provider.shutdown();
    expect(logs.getLoggerProvider()).toBe(userProvider);
    await userProvider.shutdown();
  });

  it('a second register() replaces the SDK LoggerProvider', async () => {
    const first = new InMemoryLogRecordExporter();
    const second = new InMemoryLogRecordExporter();
    await register({ exporter: new InMemorySpanExporter(), logExporter: first, batch: false, autoInstrument: false });
    const provider = await register({ exporter: new InMemorySpanExporter(), logExporter: second, batch: false, autoInstrument: false });
    score({ name: 'x', value: 1 });
    expect(first.getFinishedLogRecords()).toHaveLength(0);
    expect(second.getFinishedLogRecords()).toHaveLength(1);
    await provider.shutdown();
  });

  it('logs: false skips the logs pipeline', async () => {
    const provider = await register({
      exporter: new InMemorySpanExporter(),
      logExporter: new InMemoryLogRecordExporter(),
      logs: false,
      setGlobal: false,
      autoInstrument: false,
    });
    expect(getSdkLoggerProvider()).toBeUndefined();
    await provider.shutdown();
  });

  it('creates an OTLP/HTTP log exporter by default', async () => {
    const exporter = await createLogExporter({}, DEFAULT_ENDPOINT, 'http');
    expect(exporter).toBeInstanceOf(OTLPLogExporter);
  });

  it('derives a SigV4 log exporter from a SigV4 trace exporter', async () => {
    const exporter = await createLogExporter(
      {
        exporter: new AWSSigV4OTLPExporter({
          endpoint: 'https://pipe.us-east-1.osis.amazonaws.com/v1/traces',
          region: 'us-east-1',
        }),
      },
      DEFAULT_ENDPOINT,
      'http',
    );
    expect(exporter).toBeInstanceOf(AWSSigV4OTLPLogExporter);
    expect((exporter as AWSSigV4OTLPLogExporter).endpoint).toBe(
      'https://pipe.us-east-1.osis.amazonaws.com/v1/logs',
    );
  });

  it('SigV4 log exporter honors an explicit logsEndpoint', async () => {
    const exporter = await createLogExporter(
      {
        logsEndpoint: 'https://logs-pipe.us-east-1.osis.amazonaws.com/v1/logs',
        exporter: new AWSSigV4OTLPExporter({
          endpoint: 'https://pipe.us-east-1.osis.amazonaws.com/v1/traces',
          region: 'us-east-1',
        }),
      },
      DEFAULT_ENDPOINT,
      'http',
    );
    expect((exporter as AWSSigV4OTLPLogExporter).endpoint).toBe(
      'https://logs-pipe.us-east-1.osis.amazonaws.com/v1/logs',
    );
  });

  it('warns and skips when no logs endpoint can be derived', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = await register({
      endpoint: 'http://collector:4317',
      protocol: 'grpc',
      exporter: new InMemorySpanExporter(),
      setGlobal: false,
      autoInstrument: false,
    });
    expect(getSdkLoggerProvider()).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/logsEndpoint/));
    warnSpy.mockRestore();
    await provider.shutdown();
  });
});

describe('resolveLogsEndpoint', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('derives the default logs endpoint from the default traces endpoint', () => {
    expect(resolveLogsEndpoint({}, DEFAULT_ENDPOINT, 'http')).toBe(DEFAULT_LOGS_ENDPOINT);
    expect(DEFAULT_LOGS_ENDPOINT).toBe('http://localhost:21890/opentelemetry/v1/logs');
  });

  it('swaps /v1/traces for /v1/logs on an explicit endpoint', () => {
    expect(
      resolveLogsEndpoint({ endpoint: 'http://c:4318/v1/traces' }, 'http://c:4318/v1/traces', 'http'),
    ).toBe('http://c:4318/v1/logs');
  });

  it('prefers logsEndpoint, then OTEL_EXPORTER_OTLP_LOGS_ENDPOINT', () => {
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = 'http://env-logs:4318/v1/logs';
    expect(resolveLogsEndpoint({ logsEndpoint: 'http://opt/v1/logs' }, DEFAULT_ENDPOINT, 'http')).toBe(
      'http://opt/v1/logs',
    );
    expect(resolveLogsEndpoint({}, DEFAULT_ENDPOINT, 'http')).toBe('http://env-logs:4318/v1/logs');
  });

  it('uses OTEL_EXPORTER_OTLP_ENDPOINT base + /v1/logs', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://base:4318/';
    expect(resolveLogsEndpoint({}, 'http://base:4318/v1/traces', 'http')).toBe('http://base:4318/v1/logs');
  });

  it('returns null for gRPC or non-standard traces paths', () => {
    expect(resolveLogsEndpoint({}, 'http://c:4317', 'grpc')).toBeNull();
    expect(resolveLogsEndpoint({}, 'http://c/custom/ingest', 'http')).toBeNull();
  });
});
