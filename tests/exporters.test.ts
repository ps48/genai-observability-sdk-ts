// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { trace, ROOT_CONTEXT, TraceFlags } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
  type LogRecordExporter,
} from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import {
  AWSSigV4OTLPExporter,
  AWSSigV4OTLPLogExporter,
  forceDoubleAttributes,
  sendScoresAsDouble,
} from '../src/exporters.js';

describe('AWSSigV4OTLPExporter', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.AWS_DEFAULT_REGION;
    delete process.env.AWS_REGION;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('creates exporter with explicit region', () => {
    const exporter = new AWSSigV4OTLPExporter({
      endpoint: 'https://pipeline.us-east-1.osis.amazonaws.com/v1/traces',
      region: 'us-east-1',
    });
    expect(exporter).toBeDefined();
  });

  it('creates exporter with AWS_REGION env var', () => {
    process.env.AWS_REGION = 'eu-west-1';
    const exporter = new AWSSigV4OTLPExporter({
      endpoint: 'https://pipeline.eu-west-1.osis.amazonaws.com/v1/traces',
    });
    expect(exporter).toBeDefined();
  });

  it('creates exporter with AWS_DEFAULT_REGION env var', () => {
    process.env.AWS_DEFAULT_REGION = 'ap-southeast-1';
    const exporter = new AWSSigV4OTLPExporter({
      endpoint: 'https://pipeline.ap-southeast-1.osis.amazonaws.com/v1/traces',
    });
    expect(exporter).toBeDefined();
  });

  it('throws when no region is available', () => {
    expect(
      () =>
        new AWSSigV4OTLPExporter({
          endpoint: 'https://pipeline.osis.amazonaws.com/v1/traces',
        }),
    ).toThrow(/region/i);
  });

  it('uses default service "osis"', () => {
    const exporter = new AWSSigV4OTLPExporter({
      endpoint: 'https://pipeline.osis.amazonaws.com/v1/traces',
      region: 'us-east-1',
    });
    expect(exporter).toBeDefined();
  });

  it('accepts custom service', () => {
    const exporter = new AWSSigV4OTLPExporter({
      endpoint: 'https://custom.example.com/v1/traces',
      region: 'us-east-1',
      service: 'custom-service',
    });
    expect(exporter).toBeDefined();
  });

  it('has shutdown and forceFlush methods', async () => {
    const exporter = new AWSSigV4OTLPExporter({
      endpoint: 'https://pipeline.osis.amazonaws.com/v1/traces',
      region: 'us-east-1',
    });
    await exporter.shutdown();
    await exporter.forceFlush();
  });
});

describe('AWSSigV4OTLPLogExporter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('requires a region', () => {
    const saved = { d: process.env.AWS_DEFAULT_REGION, r: process.env.AWS_REGION };
    delete process.env.AWS_DEFAULT_REGION;
    delete process.env.AWS_REGION;
    expect(() => new AWSSigV4OTLPLogExporter({ endpoint: 'https://x/v1/logs' })).toThrow(/region/i);
    if (saved.d !== undefined) process.env.AWS_DEFAULT_REGION = saved.d;
    if (saved.r !== undefined) process.env.AWS_REGION = saved.r;
  });

  it('signs and posts OTLP/JSON logs including the top-level eventName', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.doMock('@aws-sdk/credential-providers', () => ({
      fromNodeProviderChain: () => async () => ({
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'secret',
      }),
    }));

    const exporter = new AWSSigV4OTLPLogExporter({
      endpoint: 'https://pipe.us-east-1.osis.amazonaws.com/v1/logs',
      region: 'us-east-1',
    });
    const provider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor({ exporter })],
    });
    const ctx = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: 'abcdef1234567890abcdef1234567890',
      spanId: '1234567890abcdef',
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    });
    provider.getLogger('judge', '1.0.0').emit({
      eventName: 'gen_ai.evaluation.result',
      severityNumber: SeverityNumber.INFO,
      attributes: { 'gen_ai.evaluation.name': 'relevance' },
      context: ctx,
    });
    // SimpleLogRecordProcessor does not await exports; the exporter drains them.
    await exporter.forceFlush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://pipe.us-east-1.osis.amazonaws.com/v1/logs');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 .*\/us-east-1\/osis\/aws4_request/);
    const body = JSON.parse(Buffer.from(init.body as Buffer).toString('utf8'));
    const record = body.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(body.resourceLogs[0].scopeLogs[0].scope.name).toBe('judge');
    expect(record.eventName).toBe('gen_ai.evaluation.result');
    expect(record.traceId).toBe('abcdef1234567890abcdef1234567890');
    expect(record.spanId).toBe('1234567890abcdef');
    await provider.shutdown();
  });
});

describe('double-typed attributes over OTLP/JSON', () => {
  function emitTo(exporter: LogRecordExporter, value: number) {
    const provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter })] });
    provider.getLogger('judge').emit({
      eventName: 'gen_ai.evaluation.result',
      attributes: { 'gen_ai.evaluation.name': 'acc', 'gen_ai.evaluation.score.value': value, 'other.count': 3 },
    });
    return provider;
  }

  function attrsOf(body: Uint8Array | Buffer) {
    const parsed = JSON.parse(Buffer.from(body).toString('utf8'));
    const list = parsed.resourceLogs[0].scopeLogs[0].logRecords[0].attributes as {
      key: string;
      value: Record<string, unknown>;
    }[];
    return Object.fromEntries(list.map(kv => [kv.key, kv.value]));
  }

  it('forceDoubleAttributes re-encodes whole-number scores only', () => {
    const body = Buffer.from(JSON.stringify({
      resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes: [
        { key: 'gen_ai.evaluation.score.value', value: { intValue: 1 } },
        { key: 'opensearch.evaluation.score.threshold', value: { intValue: 4 } },
        { key: 'other.count', value: { intValue: 3 } },
      ] }] }] }],
    }));
    const attrs = attrsOf(forceDoubleAttributes(new Uint8Array(body)));
    expect(attrs['gen_ai.evaluation.score.value']).toEqual({ doubleValue: 1 });
    expect(attrs['opensearch.evaluation.score.threshold']).toEqual({ doubleValue: 4 });
    expect(attrs['other.count']).toEqual({ intValue: 3 });
  });

  it('OTLPLogExporter sends a score of 1 as doubleValue', async () => {
    const exporter = new OTLPLogExporter({ url: 'http://localhost:1/v1/logs' });
    expect(sendScoresAsDouble(exporter)).toBe(true);
    const serializer = (exporter as unknown as {
      _delegate: { _serializer: { serializeRequest(l: unknown[]): Uint8Array } };
    })._delegate._serializer;
    const memory = new InMemoryLogRecordExporter();
    const provider = emitTo(memory, 1);
    const attrs = attrsOf(serializer.serializeRequest(memory.getFinishedLogRecords()));
    expect(attrs['gen_ai.evaluation.score.value']).toEqual({ doubleValue: 1 });
    expect(attrs['other.count']).toEqual({ intValue: 3 });
    await provider.shutdown();
    await exporter.shutdown();
  });

  it('AWSSigV4OTLPLogExporter sends a score of 1 as doubleValue', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.doMock('@aws-sdk/credential-providers', () => ({
      fromNodeProviderChain: () => async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' }),
    }));
    const exporter = new AWSSigV4OTLPLogExporter({
      endpoint: 'https://pipe.us-east-1.osis.amazonaws.com/v1/logs',
      region: 'us-east-1',
    });
    const provider = emitTo(exporter, 1);
    await exporter.forceFlush();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(attrsOf(init.body as Buffer)['gen_ai.evaluation.score.value']).toEqual({ doubleValue: 1 });
    await provider.shutdown();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});
