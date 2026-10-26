// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { trace } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { score, _resetScoreWarnings, EVALUATION_RESULT_EVENT } from '../src/score.js';
import { SDK_SCOPE_NAME, SDK_VERSION } from '../src/version.js';
import { getFinishedSpans, getFinishedLogRecords, clearSpans } from './setup.js';

const TRACE_ID = 'abcdef1234567890abcdef1234567890';
const SPAN_ID = '1234567890abcdef';

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clearSpans();
  _resetScoreWarnings();
  delete process.env.OPENSEARCH_GENAI_EVAL_CARRIER;
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  clearSpans();
  delete process.env.OPENSEARCH_GENAI_EVAL_CARRIER;
  warnSpy.mockRestore();
});

function onlyRecord() {
  const records = getFinishedLogRecords();
  expect(records).toHaveLength(1);
  return records[0];
}

describe('score (event carrier, default)', () => {
  it('emits one gen_ai.evaluation.result log event and no span', () => {
    const before = Date.now();
    score({ name: 'accuracy', value: 0.95 });

    expect(getFinishedSpans()).toHaveLength(0);
    const r = onlyRecord();
    expect(r.eventName).toBe(EVALUATION_RESULT_EVENT);
    expect(r.eventName).toBe('gen_ai.evaluation.result');
    expect(r.severityNumber).toBe(SeverityNumber.INFO);
    expect(r.body).toBeUndefined();
    expect(r.attributes['gen_ai.evaluation.name']).toBe('accuracy');
    expect(r.attributes['gen_ai.evaluation.score.value']).toBe(0.95);
    // event name is a top-level field, not an attribute
    expect(r.attributes['event.name']).toBeUndefined();
    // timestamp set explicitly to evaluation time
    const tsMs = r.hrTime[0] * 1000 + r.hrTime[1] / 1e6;
    expect(tsMs).toBeGreaterThanOrEqual(before - 1);
    expect(tsMs).toBeLessThanOrEqual(Date.now() + 1);
  });

  it('uses the SDK scope when no evaluator is named', () => {
    score({ name: 'x', value: 1 });
    const r = onlyRecord();
    expect(r.instrumentationScope.name).toBe(SDK_SCOPE_NAME);
    expect(r.instrumentationScope.name).toBe('opensearch-genai-observability-sdk-ts');
    expect(r.instrumentationScope.version).toBe(SDK_VERSION);
    expect(r.attributes['opensearch.evaluation.evaluator.name']).toBeUndefined();
  });

  it('uses the evaluator as instrumentation scope and attribute', () => {
    score({ name: 'relevance', value: 0.9, evaluator: 'helpfulness_judge', evaluatorVersion: '3.1.0' });
    const r = onlyRecord();
    expect(r.instrumentationScope.name).toBe('helpfulness_judge');
    expect(r.instrumentationScope.version).toBe('3.1.0');
    expect(r.attributes['opensearch.evaluation.evaluator.name']).toBe('helpfulness_judge');
    expect(r.attributes['opensearch.evaluation.evaluator.version']).toBe('3.1.0');
  });

  it('maps all options to standard and opensearch.* attributes', () => {
    score({
      name: 'faithfulness',
      value: 0.4,
      label: 'fail',
      explanation: 'Unsupported claim',
      responseId: 'chatcmpl-123',
      level: 'tool_call',
      evaluatorType: 'llm_judge',
      direction: 'maximize',
      scoreMin: 0,
      scoreMax: 1,
      conversationId: 'sess-1',
      agentName: 'travel-planner',
      errorType: 'timeout',
      judgeTraceId: 'ffffffffffffffffffffffffffffffff',
    });
    const a = onlyRecord().attributes;
    expect(a).toEqual({
      'gen_ai.evaluation.name': 'faithfulness',
      'gen_ai.evaluation.score.value': 0.4,
      'gen_ai.evaluation.score.label': 'fail',
      'gen_ai.evaluation.explanation': 'Unsupported claim',
      'gen_ai.response.id': 'chatcmpl-123',
      'gen_ai.conversation.id': 'sess-1',
      'gen_ai.agent.name': 'travel-planner',
      'error.type': 'timeout',
      'opensearch.evaluation.level': 'tool_call',
      'opensearch.evaluation.evaluator.type': 'llm_judge',
      'opensearch.evaluation.score.direction': 'maximize',
      'opensearch.evaluation.score.min': 0,
      'opensearch.evaluation.score.max': 1,
      'opensearch.evaluation.judge.trace_id': 'ffffffffffffffffffffffffffffffff',
    });
  });

  it('truncates explanation to 500 chars', () => {
    score({ name: 'test', value: 0.5, explanation: 'x'.repeat(600) });
    expect((onlyRecord().attributes['gen_ai.evaluation.explanation'] as string).length).toBe(500);
  });

  it('passes through primitive custom attributes; explicit options win', () => {
    score({
      name: 'test',
      value: 0.5,
      attributes: {
        'custom.key': 'value',
        'custom.num': 42,
        'custom.flag': true,
        'custom.obj': { nested: 1 },
        'gen_ai.evaluation.name': 'override',
      },
    });
    const a = onlyRecord().attributes;
    expect(a['custom.key']).toBe('value');
    expect(a['custom.num']).toBe(42);
    expect(a['custom.flag']).toBe(true);
    expect(a['custom.obj']).toBeUndefined();
    expect(a['gen_ai.evaluation.name']).toBe('test');
  });

  it('handles score without value', () => {
    score({ name: 'binary', label: 'pass' });
    const a = onlyRecord().attributes;
    expect(a['gen_ai.evaluation.score.value']).toBeUndefined();
    expect(a['gen_ai.evaluation.score.label']).toBe('pass');
  });

  it('parents to the active span (inline evaluation)', () => {
    const tracer = trace.getTracer('test');
    let ids: { traceId: string; spanId: string } | undefined;
    tracer.startActiveSpan('chat gpt-4o', (span) => {
      ids = span.spanContext();
      score({ name: 'relevance', value: 0.9 });
      span.end();
    });
    const r = onlyRecord();
    expect(r.spanContext?.traceId).toBe(ids!.traceId);
    expect(r.spanContext?.spanId).toBe(ids!.spanId);
    expect(r.attributes['opensearch.evaluation.level']).toBeUndefined();
  });

  it('has no span context when standalone', () => {
    score({ name: 'standalone', value: 0.7 });
    expect(onlyRecord().spanContext).toBeUndefined();
  });

  it('parents to a stored span when traceId and spanId are given', () => {
    const tracer = trace.getTracer('test');
    tracer.startActiveSpan('unrelated', (span) => {
      score({ name: 'test', value: 1.0, traceId: TRACE_ID, spanId: SPAN_ID });
      span.end();
    });
    const r = onlyRecord();
    expect(r.spanContext?.traceId).toBe(TRACE_ID);
    expect(r.spanContext?.spanId).toBe(SPAN_ID);
    expect(r.attributes['opensearch.evaluation.trace_id']).toBeUndefined();
  });

  it('normalizes 0x-prefixed ids', () => {
    score({ name: 'test', value: 1.0, traceId: `0x${TRACE_ID}`, spanId: `0X${SPAN_ID}` });
    const r = onlyRecord();
    expect(r.spanContext?.traceId).toBe(TRACE_ID);
    expect(r.spanContext?.spanId).toBe(SPAN_ID);
  });

  it('trace-level score: no span context, no derived span id, trace_id + level=trace', () => {
    const tracer = trace.getTracer('test');
    tracer.startActiveSpan('unrelated', (span) => {
      score({ name: 'task_success', value: 1, traceId: TRACE_ID });
      span.end();
    });
    const r = onlyRecord();
    expect(r.spanContext).toBeUndefined();
    expect(r.attributes['opensearch.evaluation.trace_id']).toBe(TRACE_ID);
    expect(r.attributes['opensearch.evaluation.level']).toBe('trace');
  });

  it('trace-level score keeps an explicit level', () => {
    score({ name: 'session_quality', value: 1, traceId: TRACE_ID, level: 'session' });
    expect(onlyRecord().attributes['opensearch.evaluation.level']).toBe('session');
  });

  it('throws when spanId is given without traceId', () => {
    expect(() => score({ name: 'x', value: 1, spanId: SPAN_ID })).toThrow(/spanId requires traceId/);
  });

  it('ignores an invalid traceId instead of parenting to the active span', () => {
    const tracer = trace.getTracer('test');
    tracer.startActiveSpan('unrelated', (span) => {
      score({ name: 'x', value: 1, traceId: 'not-hex' });
      span.end();
    });
    const r = onlyRecord();
    expect(r.spanContext).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('multiple scores emit multiple events', () => {
    score({ name: 'accuracy', value: 0.95 });
    score({ name: 'relevance', value: 0.8 });
    score({ name: 'fluency', value: 0.9 });
    expect(getFinishedLogRecords().map(r => r.attributes['gen_ai.evaluation.name'])).toEqual([
      'accuracy',
      'relevance',
      'fluency',
    ]);
  });

  it('does not warn for the default carrier', () => {
    score({ name: 'x', value: 1 });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('score (deprecated span carrier)', () => {
  it('carrier "span" creates an evaluation span with a span event and no log event', () => {
    score({ name: 'accuracy', value: 0.95, label: 'good', carrier: 'span' });

    expect(getFinishedLogRecords()).toHaveLength(0);
    const spans = getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span.name).toBe('evaluation accuracy');
    expect(span.attributes['gen_ai.operation.name']).toBe('evaluation');
    expect(span.attributes['gen_ai.evaluation.name']).toBe('accuracy');
    expect(span.attributes['gen_ai.evaluation.score.value']).toBe(0.95);
    expect(span.attributes['gen_ai.evaluation.score.label']).toBe('good');
    const ev = span.events.find(e => e.name === 'gen_ai.evaluation.result');
    expect(ev?.attributes?.['gen_ai.evaluation.score.value']).toBe(0.95);
  });

  it('span carrier is a child of the stored span', () => {
    score({ name: 'x', value: 1, traceId: TRACE_ID, spanId: SPAN_ID, carrier: 'span' });
    const [span] = getFinishedSpans();
    expect(span.spanContext().traceId).toBe(TRACE_ID);
    expect(span.parentSpanId).toBe(SPAN_ID);
  });

  it('span carrier never derives a root span id from the trace id', () => {
    score({ name: 'x', value: 1, traceId: TRACE_ID, carrier: 'span' });
    const [span] = getFinishedSpans();
    expect(span.parentSpanId).toBeUndefined();
    expect(span.parentSpanId).not.toBe(TRACE_ID.slice(16));
    expect(span.attributes['opensearch.evaluation.trace_id']).toBe(TRACE_ID);
    expect(span.attributes['opensearch.evaluation.level']).toBe('trace');
  });

  it('env OPENSEARCH_GENAI_EVAL_CARRIER=span selects the span carrier', () => {
    process.env.OPENSEARCH_GENAI_EVAL_CARRIER = 'span';
    score({ name: 'x', value: 1 });
    expect(getFinishedSpans()).toHaveLength(1);
    expect(getFinishedLogRecords()).toHaveLength(0);
  });

  it('explicit carrier overrides the env var', () => {
    process.env.OPENSEARCH_GENAI_EVAL_CARRIER = 'span';
    score({ name: 'x', value: 1, carrier: 'event' });
    expect(getFinishedSpans()).toHaveLength(0);
    expect(getFinishedLogRecords()).toHaveLength(1);
  });

  it('carrier "both" emits the event and the span', () => {
    score({ name: 'x', value: 1, traceId: TRACE_ID, spanId: SPAN_ID, carrier: 'both' });
    expect(getFinishedSpans()).toHaveLength(1);
    const r = onlyRecord();
    expect(r.spanContext?.spanId).toBe(SPAN_ID);
  });

  it('warns once about the deprecated carrier', () => {
    score({ name: 'a', value: 1, carrier: 'span' });
    score({ name: 'b', value: 1, carrier: 'both' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/deprecated/);
  });
});
