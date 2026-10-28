// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { Benchmark, evaluate, defineScorer, type EvalScore } from '../src/benchmark.js';
import { score } from '../src/score.js';
import { TestCaseSpanProcessor, installTestCaseProcessor } from '../src/testcase.js';
import { getFinishedSpans, getFinishedLogRecords, clearSpans } from './setup.js';

const scoreRecords = () =>
  getFinishedLogRecords().filter(r => r.eventName === 'gen_ai.evaluation.result');

beforeEach(() => clearSpans());
afterEach(() => clearSpans());

const runEvents = () => getFinishedLogRecords().filter(r => r.eventName === 'opensearch.test_suite_run.result');
const caseEvents = () => getFinishedLogRecords().filter(r => r.eventName === 'opensearch.test_case.result');

describe('Benchmark class', () => {
  it('creates no spans of its own', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('test-suite');
    bm.log({ input: 'q1', output: 'a1', scores: { accuracy: 1 } });
    bm.close();
    expect(getFinishedSpans()).toHaveLength(0);
    logSpy.mockRestore();
  });

  it('has name and runId getters', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('my-bench');
    expect(bm.name).toBe('my-bench');
    expect(typeof bm.runId).toBe('string');
    expect(bm.runId.startsWith('run_')).toBe(true);
    bm.close();
    logSpy.mockRestore();
  });

  it('log emits one score event per score with the suite and case identity', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('suite');
    bm.log({
      input: 'q1',
      output: 'a1',
      caseId: 'case_001',
      caseName: 'greeting',
      scores: { accuracy: 0.9, fluency: 0.8 },
    });
    bm.close();

    const records = scoreRecords();
    expect(records).toHaveLength(2);
    for (const r of records) {
      expect(r.attributes['test.suite.name']).toBe('suite');
      expect(r.attributes['test.suite.run.id']).toBe(bm.runId);
      expect(r.attributes['test.case.id']).toBe('case_001');
      expect(r.attributes['test.case.name']).toBe('greeting');
    }
    expect(records.map(r => r.attributes['gen_ai.evaluation.name'])).toEqual(['accuracy', 'fluency']);
    expect(records[0].attributes['gen_ai.evaluation.score.value']).toBe(0.9);
    logSpy.mockRestore();
  });

  it('log with traceId only scores at trace level', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('suite');
    bm.log({ input: 'q', scores: { accuracy: 1 }, traceId: 'abcdef1234567890abcdef1234567890' });
    bm.close();

    const [record] = scoreRecords();
    expect(record.spanContext).toBeUndefined();
    expect(record.attributes['opensearch.evaluation.trace_id']).toBe('abcdef1234567890abcdef1234567890');
    expect(record.attributes['opensearch.evaluation.level']).toBe('trace');
    expect(caseEvents()[0].spanContext).toBeUndefined();
    logSpy.mockRestore();
  });

  it('log does not record I/O when recordIo is false', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('suite', { recordIo: false });
    bm.log({ input: 'q', output: 'a', expected: 'a' });
    bm.close();

    const [c] = caseEvents();
    expect(c.attributes['opensearch.test_case.input']).toBeUndefined();
    expect(c.attributes['opensearch.test_case.output']).toBeUndefined();
    expect(c.attributes['opensearch.test_case.expected']).toBeUndefined();
    logSpy.mockRestore();
  });

  it('close returns summary with score statistics', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('suite');
    bm.log({ input: 'q1', output: 'a1', scores: { accuracy: 0.8 } });
    bm.log({ input: 'q2', output: 'a2', scores: { accuracy: 1.0 } });
    const summary = bm.close();

    expect(summary.benchmarkName).toBe('suite');
    expect(summary.totalCases).toBe(2);
    expect(summary.errorCount).toBe(0);
    expect(summary.scores['accuracy'].avg).toBe(0.9);
    expect(summary.scores['accuracy'].min).toBe(0.8);
    expect(summary.scores['accuracy'].max).toBe(1.0);
    expect(summary.scores['accuracy'].count).toBe(2);
    expect(runEvents()[0].attributes['test.suite.run.status']).toBe('success');
    logSpy.mockRestore();
  });

  it('throws when logging after close', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('suite');
    bm.close();
    expect(() => bm.log({ input: 'q' })).toThrow('already closed');
    logSpy.mockRestore();
  });

  it('throws when closing twice', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('suite');
    bm.close();
    expect(() => bm.close()).toThrow('already closed');
    logSpy.mockRestore();
  });

  it('filters reserved keys from metadata', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('suite', {
      metadata: { 'custom.key': 'val', 'test.suite.name': 'override' },
    });
    bm.close();

    const [run] = runEvents();
    expect(run.attributes['custom.key']).toBe('val');
    expect(run.attributes['test.suite.name']).toBe('suite');
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('auto-generates caseId from input hash', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('suite');
    bm.log({ input: { query: 'test' } });
    bm.close();

    const caseId = caseEvents()[0].attributes['test.case.id'] as string;
    expect(caseId.length).toBe(16); // sha256 hex prefix
    logSpy.mockRestore();
  });

  it('uses custom caseId when provided', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bm = new Benchmark('suite');
    bm.log({ input: 'q', caseId: 'my-case-id' });
    bm.close();

    expect(caseEvents()[0].attributes['test.case.id']).toBe('my-case-id');
    logSpy.mockRestore();
  });
});

describe('evaluate', () => {
  it('runs task and scorers, returns result', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = evaluate({
      name: 'eval-test',
      task: (input) => `answer:${input}`,
      data: [
        { input: 'q1', expected: 'answer:q1' },
        { input: 'q2', expected: 'answer:q2' },
      ],
      scores: [
        function accuracy(input, output, expected) {
          return { name: 'accuracy', value: output === expected ? 1.0 : 0.0 };
        },
      ],
    });

    expect(result.summary.benchmarkName).toBe('eval-test');
    expect(result.summary.totalCases).toBe(2);
    expect(result.cases).toHaveLength(2);
    expect(result.cases[0].scores['accuracy']).toBe(1.0);
    expect(result.cases[1].scores['accuracy']).toBe(1.0);
    logSpy.mockRestore();
  });

  it('rejects async task functions with a clear error', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = evaluate({
      name: 'async-task-test',
      task: async (input) => `answer: ${input}`,
      data: [{ input: 'q1' }],
      scores: [],
    });

    expect(result.cases[0].status).toBe('fail');
    expect(result.cases[0].error).toContain('does not support async task functions');
    expect(result.summary.errorCount).toBe(1);
    logSpy.mockRestore();
  });

  it('handles task errors', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = evaluate({
      name: 'error-test',
      task: () => { throw new Error('task-failed'); },
      data: [{ input: 'q1' }],
      scores: [],
    });

    expect(result.cases[0].status).toBe('fail');
    expect(result.cases[0].error).toBeDefined();
    expect(result.summary.errorCount).toBe(1);
    logSpy.mockRestore();
  });

  it('handles scorer returning number', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = evaluate({
      name: 'num-scorer',
      task: (input) => input,
      data: [{ input: 'q1' }],
      scores: [
        function myScore(_i: unknown, _o: unknown, _e: unknown) { return 0.75; },
      ],
    });

    expect(result.cases[0].scores['myScore']).toBe(0.75);
    logSpy.mockRestore();
  });

  it('handles scorer returning array of EvalScore', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = evaluate({
      name: 'array-scorer',
      task: (input) => input,
      data: [{ input: 'q1' }],
      scores: [
        function (_i: unknown, _o: unknown, _e: unknown) {
          return [
            { name: 'a', value: 0.8 },
            { name: 'b', value: 0.9 },
          ];
        },
      ],
    });

    expect(result.cases[0].scores['a']).toBe(0.8);
    expect(result.cases[0].scores['b']).toBe(0.9);
    logSpy.mockRestore();
  });

  it('records scorer errors', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = evaluate({
      name: 'scorer-error',
      task: (input) => input,
      data: [{ input: 'q1' }],
      scores: [
        function badScorer() { throw new Error('scorer-boom'); },
      ],
    });

    expect(result.cases[0].scorerErrors!.length).toBeGreaterThan(0);
    logSpy.mockRestore();
  });

  it('does not record I/O when recordIo is false', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    evaluate({
      name: 'no-io-test',
      task: () => 'output',
      data: [{ input: 'input', expected: 'output' }],
      scores: [],
      recordIo: false,
    });

    const [c] = caseEvents();
    expect(c.attributes['opensearch.test_case.input']).toBeUndefined();
    expect(c.attributes['opensearch.test_case.output']).toBeUndefined();
    logSpy.mockRestore();
  });

  it('emits score log events with label, explanation and suite identity', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = evaluate({
      name: 'events-test',
      task: (input) => `echo ${input}`,
      data: [{ input: 'hi', caseId: 'c1', caseName: 'hello case' }],
      scores: [
        () => ({ name: 'judge', value: 0.5, label: 'partial', explanation: 'half right', metadata: { 'judge.model': 'm1' } }),
      ],
    });

    const records = scoreRecords();
    expect(records).toHaveLength(1);
    const r = records[0];
    expect(r.attributes['gen_ai.evaluation.score.label']).toBe('partial');
    expect(r.attributes['gen_ai.evaluation.explanation']).toBe('half right');
    expect(r.attributes['judge.model']).toBe('m1');
    expect(r.attributes['test.suite.name']).toBe('events-test');
    expect(r.attributes['test.suite.run.id']).toBe(result.summary.runId);
    expect(r.attributes['test.case.id']).toBe('c1');
    expect(r.attributes['test.case.name']).toBe('hello case');
    logSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Default shape: test cases as log events (contract section 6)
// ---------------------------------------------------------------------------

const agentTracer = () => trace.getTracer('test-agent');
const eventsNamed = (name: string) => getFinishedLogRecords().filter(r => r.eventName === name);
const quiet = () => vi.spyOn(console, 'log').mockImplementation(() => {});

/** Mock agent: a root span with one child, both ended before returning. */
function tracedTask(input: unknown): string {
  return agentTracer().startActiveSpan('invoke_agent mock', root => {
    agentTracer().startActiveSpan('chat mock-model', child => child.end());
    root.end();
    return `answer:${input}`;
  });
}

function exact(_i: unknown, output: unknown, expected: unknown) {
  return { name: 'exact', value: output === expected ? 1 : 0 };
}

describe('evaluate (default: events, no harness spans)', () => {
  it('creates no test_suite_run / test_case spans and one trace per case', () => {
    const spy = quiet();
    evaluate({
      name: 'shape',
      task: tracedTask,
      data: [{ input: 'a', expected: 'answer:a' }, { input: 'b', expected: 'answer:b' }],
      scores: [exact],
    });
    const spans = getFinishedSpans();
    expect(spans.filter(s => s.name.startsWith('test_suite_run') || s.name.startsWith('test_case'))).toHaveLength(0);
    const roots = spans.filter(s => s.name === 'invoke_agent mock');
    expect(roots).toHaveLength(2);
    expect(roots[0].spanContext().traceId).not.toBe(roots[1].spanContext().traceId);
    for (const r of roots) expect(r.parentSpanId).toBeUndefined();
    spy.mockRestore();
  });

  it('stamps test.* ids on the agent root span only', () => {
    const spy = quiet();
    const result = evaluate({
      name: 'stamp',
      task: tracedTask,
      data: [{ input: 'a', caseId: 'c1', caseName: 'first' }],
      scores: [],
    });
    const root = getFinishedSpans().find(s => s.name === 'invoke_agent mock')!;
    expect(root.attributes['test.suite.name']).toBe('stamp');
    expect(root.attributes['test.suite.run.id']).toBe(result.summary.runId);
    expect(root.attributes['test.case.id']).toBe('c1');
    expect(root.attributes['test.case.name']).toBe('first');
    const child = getFinishedSpans().find(s => s.name === 'chat mock-model')!;
    expect(child.attributes['test.case.id']).toBeUndefined();
    expect(result.cases[0].traceId).toBe(root.spanContext().traceId);
    expect(result.cases[0].spanId).toBe(root.spanContext().spanId);
    spy.mockRestore();
  });

  it('does not adopt the caller active span as parent', () => {
    const spy = quiet();
    agentTracer().startActiveSpan('caller', caller => {
      evaluate({ name: 'iso', task: tracedTask, data: [{ input: 'a' }], scores: [] });
      caller.end();
    });
    const root = getFinishedSpans().find(s => s.name === 'invoke_agent mock')!;
    expect(root.parentSpanId).toBeUndefined();
    spy.mockRestore();
  });

  it('parents score events to the agent root span with test.* copied', () => {
    const spy = quiet();
    const result = evaluate({
      name: 'scores',
      task: tracedTask,
      data: [{ input: 'a', expected: 'answer:a', caseId: 'c1', caseName: 'first' }],
      scores: [exact],
    });
    const root = getFinishedSpans().find(s => s.name === 'invoke_agent mock')!;
    const [r] = eventsNamed('gen_ai.evaluation.result');
    expect(r.spanContext?.traceId).toBe(root.spanContext().traceId);
    expect(r.spanContext?.spanId).toBe(root.spanContext().spanId);
    expect(r.attributes['gen_ai.evaluation.score.value']).toBe(1);
    expect(r.attributes['test.suite.name']).toBe('scores');
    expect(r.attributes['test.suite.run.id']).toBe(result.summary.runId);
    expect(r.attributes['test.case.id']).toBe('c1');
    expect(r.attributes['test.case.name']).toBe('first');
    spy.mockRestore();
  });

  it('emits one opensearch.test_case.result event per case, parented to the root span', () => {
    const spy = quiet();
    const result = evaluate({
      name: 'cases',
      task: tracedTask,
      data: [{ input: 'a', expected: 'answer:a', caseId: 'c1', caseName: 'first' }, { input: 'b' }],
      scores: [exact],
      metadata: { 'model.version': 'v1' },
    });
    const events = eventsNamed('opensearch.test_case.result');
    expect(events).toHaveLength(2);
    const roots = getFinishedSpans().filter(s => s.name === 'invoke_agent mock');
    const e = events[0];
    expect(e.spanContext?.spanId).toBe(roots[0].spanContext().spanId);
    expect(e.spanContext?.traceId).toBe(roots[0].spanContext().traceId);
    expect(e.severityNumber).toBe(9);
    expect(e.instrumentationScope.name).toBe('opensearch-genai-observability-sdk-ts');
    expect(e.attributes['test.suite.name']).toBe('cases');
    expect(e.attributes['test.suite.run.id']).toBe(result.summary.runId);
    expect(e.attributes['test.case.id']).toBe('c1');
    expect(e.attributes['test.case.name']).toBe('first');
    expect(e.attributes['test.case.result.status']).toBe('pass');
    expect(e.attributes['error.type']).toBeUndefined();
    expect(typeof e.attributes['opensearch.test_case.duration_ms']).toBe('number');
    expect(e.attributes['model.version']).toBe('v1');
    // recordIo defaults to false
    expect(e.attributes['opensearch.test_case.input']).toBeUndefined();
    expect(e.attributes['opensearch.test_case.output']).toBeUndefined();
    spy.mockRestore();
  });

  it('records input / expected / output on the case event when recordIo is true', () => {
    const spy = quiet();
    evaluate({
      name: 'io',
      task: tracedTask,
      data: [{ input: { q: 'a' }, expected: 'answer:x' }],
      scores: [],
      recordIo: true,
    });
    const [e] = eventsNamed('opensearch.test_case.result');
    expect(e.attributes['opensearch.test_case.input']).toBe('{"q":"a"}');
    expect(e.attributes['opensearch.test_case.expected']).toBe('answer:x');
    expect(e.attributes['opensearch.test_case.output']).toBe('answer:[object Object]');
    spy.mockRestore();
  });

  it('a crashing case gets an error case event and the run continues', () => {
    const spy = quiet();
    const result = evaluate({
      name: 'crash',
      task: (input) => {
        if (input === 'boom') {
          agentTracer().startActiveSpan('invoke_agent crashing', s => {
            s.end();
          });
          throw new TypeError('agent exploded');
        }
        return tracedTask(input);
      },
      data: [{ input: 'boom', caseId: 'bad' }, { input: 'ok', caseId: 'good' }],
      scores: [exact],
    });
    expect(result.cases).toHaveLength(2);
    expect(result.cases[0].resultStatus).toBe('error');
    expect(result.cases[0].status).toBe('fail');
    expect(result.cases[0].errorType).toBe('TypeError');
    expect(result.cases[1].resultStatus).toBe('pass');

    const events = eventsNamed('opensearch.test_case.result');
    expect(events).toHaveLength(2);
    const bad = events.find(e => e.attributes['test.case.id'] === 'bad')!;
    expect(bad.attributes['test.case.result.status']).toBe('error');
    expect(bad.attributes['error.type']).toBe('TypeError');
    const crashingRoot = getFinishedSpans().find(s => s.name === 'invoke_agent crashing')!;
    expect(bad.spanContext?.spanId).toBe(crashingRoot.spanContext().spanId);
    // Scorers do not run for a crashed task.
    expect(eventsNamed('gen_ai.evaluation.result')).toHaveLength(1);
    spy.mockRestore();
  });

  it('a raising scorer marks the case as error', () => {
    const spy = quiet();
    const result = evaluate({
      name: 'scorer-raise',
      task: tracedTask,
      data: [{ input: 'a' }],
      scores: [function bad() { throw new RangeError('judge down'); }],
    });
    expect(result.cases[0].resultStatus).toBe('error');
    const [e] = eventsNamed('opensearch.test_case.result');
    expect(e.attributes['test.case.result.status']).toBe('error');
    expect(e.attributes['error.type']).toBe('RangeError');
    spy.mockRestore();
  });

  it('a task that creates no span emits events without trace context', () => {
    const spy = quiet();
    const result = evaluate({
      name: 'untraced',
      task: (input) => `answer:${input}`,
      data: [{ input: 'a', expected: 'answer:a' }],
      scores: [exact],
    });
    const [e] = eventsNamed('opensearch.test_case.result');
    expect(e.spanContext).toBeUndefined();
    expect(e.attributes['test.case.result.status']).toBe('pass');
    const [s] = eventsNamed('gen_ai.evaluation.result');
    expect(s.spanContext).toBeUndefined();
    expect(result.cases[0].traceId).toBeUndefined();
    spy.mockRestore();
  });

  it('emits one opensearch.test_suite_run.result event with counts', () => {
    const spy = quiet();
    const result = evaluate({
      name: 'run',
      task: (input) => {
        if (input === 'x') throw new Error('nope');
        return tracedTask(input);
      },
      data: [{ input: 'a' }, { input: 'b' }, { input: 'x' }],
      scores: [],
      metadata: { 'model.version': 'v2' },
    });
    const runs = eventsNamed('opensearch.test_suite_run.result');
    expect(runs).toHaveLength(1);
    const r = runs[0];
    expect(r.spanContext).toBeUndefined();
    expect(r.attributes['test.suite.name']).toBe('run');
    expect(r.attributes['test.suite.run.id']).toBe(result.summary.runId);
    expect(r.attributes['test.suite.run.status']).toBe('failure');
    expect(r.attributes['opensearch.test_suite_run.case_count']).toBe(3);
    expect(r.attributes['opensearch.test_suite_run.pass_count']).toBe(2);
    expect(r.attributes['opensearch.test_suite_run.fail_count']).toBe(0);
    expect(r.attributes['opensearch.test_suite_run.error_count']).toBe(1);
    expect(typeof r.attributes['opensearch.test_suite_run.duration_ms']).toBe('number');
    expect(r.attributes['model.version']).toBe('v2');
    expect(result.summary.passCount).toBe(2);
    expect(result.summary.errorCount).toBe(1);
    // Run event is the last record.
    expect(getFinishedLogRecords().at(-1)!.eventName).toBe('opensearch.test_suite_run.result');
    spy.mockRestore();
  });

  it('run status is success when no case errored', () => {
    const spy = quiet();
    evaluate({ name: 'ok', task: tracedTask, data: [{ input: 'a' }], scores: [] });
    const [r] = eventsNamed('opensearch.test_suite_run.result');
    expect(r.attributes['test.suite.run.status']).toBe('success');
    spy.mockRestore();
  });

  it('stamps and parents correctly without a global context manager', () => {
    const spy = quiet();
    context.disable();
    try {
      evaluate({
        name: 'no-cm',
        task: (input) => {
          const root = agentTracer().startSpan('invoke_agent manual');
          const child = agentTracer().startSpan('chat manual', {}, trace.setSpan(context.active(), root));
          child.end();
          root.end();
          return input;
        },
        data: [{ input: 'a', caseId: 'c1' }],
        scores: [() => 1],
      });
    } finally {
      context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    }
    const root = getFinishedSpans().find(s => s.name === 'invoke_agent manual')!;
    const child = getFinishedSpans().find(s => s.name === 'chat manual')!;
    expect(root.attributes['test.case.id']).toBe('c1');
    expect(child.attributes['test.case.id']).toBeUndefined();
    expect(eventsNamed('opensearch.test_case.result')[0].spanContext?.spanId).toBe(root.spanContext().spanId);
    expect(eventsNamed('gen_ai.evaluation.result')[0].spanContext?.spanId).toBe(root.spanContext().spanId);
    spy.mockRestore();
  });

  it('online score() and spans outside evaluate() are unaffected', () => {
    const spy = quiet();
    evaluate({ name: 'before', task: tracedTask, data: [{ input: 'a' }], scores: [] });
    clearSpans();
    agentTracer().startActiveSpan('invoke_agent online', span => {
      score({ name: 'relevance', value: 0.7 });
      span.end();
    });
    const online = getFinishedSpans().find(s => s.name === 'invoke_agent online')!;
    expect(Object.keys(online.attributes).filter(k => k.startsWith('test.'))).toHaveLength(0);
    const records = getFinishedLogRecords();
    expect(records).toHaveLength(1);
    expect(records[0].eventName).toBe('gen_ai.evaluation.result');
    expect(records[0].spanContext?.spanId).toBe(online.spanContext().spanId);
    expect(Object.keys(records[0].attributes).filter(k => k.startsWith('test.'))).toHaveLength(0);
    spy.mockRestore();
  });
});

describe('Benchmark (default: events, no harness spans)', () => {
  it('log emits a case event parented to the evaluated span and no spans', () => {
    const spy = quiet();
    const bm = new Benchmark('upload', { recordIo: true, metadata: { 'model.version': 'v1' } });
    bm.log({
      input: 'q',
      output: 'a',
      expected: 'a',
      scores: { accuracy: 1 },
      caseId: 'c1',
      caseName: 'first',
      traceId: 'abcdef1234567890abcdef1234567890',
      spanId: '1234567890abcdef',
      durationMs: 12.5,
      metadata: { 'case.tag': 'x' },
    });
    bm.close();
    expect(getFinishedSpans()).toHaveLength(0);

    const [s] = eventsNamed('gen_ai.evaluation.result');
    expect(s.spanContext?.spanId).toBe('1234567890abcdef');
    const [c] = eventsNamed('opensearch.test_case.result');
    expect(c.spanContext?.traceId).toBe('abcdef1234567890abcdef1234567890');
    expect(c.spanContext?.spanId).toBe('1234567890abcdef');
    expect(c.attributes['test.case.id']).toBe('c1');
    expect(c.attributes['test.case.name']).toBe('first');
    expect(c.attributes['test.case.result.status']).toBe('pass');
    expect(c.attributes['opensearch.test_case.input']).toBe('q');
    expect(c.attributes['opensearch.test_case.duration_ms']).toBe(12.5);
    expect(c.attributes['model.version']).toBe('v1');
    expect(c.attributes['case.tag']).toBe('x');
    spy.mockRestore();
  });

  it('log without trace ids emits events without trace context', () => {
    const spy = quiet();
    const bm = new Benchmark('upload');
    bm.log({ input: 'q', scores: { accuracy: 1 } });
    bm.close();
    expect(eventsNamed('gen_ai.evaluation.result')[0].spanContext).toBeUndefined();
    expect(eventsNamed('opensearch.test_case.result')[0].spanContext).toBeUndefined();
    spy.mockRestore();
  });

  it('an errored case is status error and close emits the run event', () => {
    const spy = quiet();
    const bm = new Benchmark('upload');
    bm.log({ input: 'q1', caseId: 'bad', error: 'timeout', errorType: 'TimeoutError' });
    bm.log({ input: 'q2', caseId: 'nocls', error: 'oops' });
    bm.log({ input: 'q3', caseId: 'good' });
    bm.log({ input: 'q4', caseId: 'wrong', status: 'fail' });
    const summary = bm.close();
    const cases = eventsNamed('opensearch.test_case.result');
    expect(cases.map(e => e.attributes['test.case.result.status'])).toEqual(['error', 'error', 'pass', 'fail']);
    expect(cases[0].attributes['error.type']).toBe('TimeoutError');
    expect(cases[1].attributes['error.type']).toBeUndefined();
    const [run] = eventsNamed('opensearch.test_suite_run.result');
    expect(run.attributes['test.suite.run.id']).toBe(bm.runId);
    expect(run.attributes['test.suite.run.status']).toBe('failure');
    expect(run.attributes['opensearch.test_suite_run.case_count']).toBe(4);
    expect(run.attributes['opensearch.test_suite_run.error_count']).toBe(2);
    expect(run.attributes['opensearch.test_suite_run.pass_count']).toBe(1);
    expect(run.attributes['opensearch.test_suite_run.fail_count']).toBe(1);
    expect(summary.errorCount).toBe(2);
    expect(summary.failCount).toBe(1);
    spy.mockRestore();
  });

  it('rejects an unknown status', () => {
    const spy = quiet();
    const bm = new Benchmark('upload');
    expect(() => bm.log({ input: 'q', status: 'bogus' as never })).toThrow('status must be one of');
    bm.close();
    spy.mockRestore();
  });
});

describe('case and run event scope', () => {
  it('uses the SDK scope with SDK scope attributes', () => {
    const spy = quiet();
    const bm = new Benchmark('scope');
    bm.log({ input: 'q' });
    bm.close();
    for (const r of [...caseEvents(), ...runEvents()]) {
      expect(r.instrumentationScope.name).toBe('opensearch-genai-observability-sdk-ts');
      expect(r.instrumentationScope.attributes?.['opensearch.genai.sdk.name']).toBe(
        'opensearch-genai-observability-sdk-ts',
      );
      expect(r.instrumentationScope.attributes?.['opensearch.genai.sdk.version']).toBeDefined();
    }
    spy.mockRestore();
  });
});

describe('TestCaseSpanProcessor installation', () => {
  it('register() installs it once on its provider', async () => {
    const { register } = await import('../src/register.js');
    const { InMemorySpanExporter } = await import('@opentelemetry/sdk-trace-base');
    const provider = await register({
      exporter: new InMemorySpanExporter(),
      setGlobal: false,
      logs: false,
      autoInstrument: false,
    });
    const processors = (provider as unknown as { _registeredSpanProcessors: unknown[] })._registeredSpanProcessors;
    expect(processors.filter(p => p instanceof TestCaseSpanProcessor)).toHaveLength(1);
    expect(installTestCaseProcessor(provider)).toBe(true);
    expect(processors.filter(p => p instanceof TestCaseSpanProcessor)).toHaveLength(1);
    await provider.shutdown();
  });

  it('does not stamp spans when no case is running', () => {
    const processor = new TestCaseSpanProcessor();
    const setAttributes = vi.fn();
    processor.onStart(
      { spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }), setAttributes } as never,
      context.active(),
    );
    expect(setAttributes).not.toHaveBeenCalled();
  });
});

describe('declared scorer rules and verdicts', () => {
  const ASSESSMENT = 'opensearch.evaluation.assessment';
  const THRESHOLD = 'opensearch.evaluation.score.threshold';
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
  const grades = () =>
    Object.fromEntries(scoreRecords().map(r => [r.attributes['gen_ai.evaluation.name'], r]));

  it('defineScorer keeps the function and attaches the spec', () => {
    const exactScorer = defineScorer({ threshold: 4 }, function exactMatch() { return 4; });
    expect(exactScorer.name).toBe('exactMatch');
    expect(exactScorer('q', 'a', undefined)).toBe(4);
    expect(exactScorer.scorerSpec.direction).toBe('maximize');
  });

  it('defineScorer validates its spec', () => {
    expect(() => defineScorer({ direction: 'up' as 'maximize' }, () => 1)).toThrow(/direction/);
    expect(() => defineScorer({ evaluatorType: 'robot' as 'code' }, () => 1)).toThrow(/evaluatorType/);
    expect(() => defineScorer({ threshold: Number.NaN }, () => 1)).toThrow(/threshold/);
  });

  it('names number results after the declaration and applies its rule', () => {
    const quality = defineScorer(
      { name: 'answer_quality', threshold: 4, scoreMin: 1, scoreMax: 5, evaluator: 'quality_judge', evaluatorType: 'llm_judge' },
      function quality() { return 3; },
    );
    const result = evaluate({ name: 'decl', task: x => x, data: [{ input: 'q' }], scores: [quality] });
    const r = grades()['answer_quality'];
    expect(r.attributes['gen_ai.evaluation.score.value']).toBe(3);
    expect(r.attributes[THRESHOLD]).toBe(4);
    expect(r.attributes['opensearch.evaluation.score.direction']).toBe('maximize');
    expect(r.attributes['opensearch.evaluation.score.min']).toBe(1);
    expect(r.attributes['opensearch.evaluation.score.max']).toBe(5);
    expect(r.attributes['opensearch.evaluation.evaluator.name']).toBe('quality_judge');
    expect(r.attributes['opensearch.evaluation.evaluator.type']).toBe('llm_judge');
    expect(r.attributes[ASSESSMENT]).toBe('fail');
    expect(r.instrumentationScope.name).toBe('quality_judge');
    expect(result.cases[0].scores).toEqual({ answer_quality: 3 });
    expect(result.cases[0].assessments).toEqual({ answer_quality: 'fail' });
  });

  it('lets EvalScore fields override the declaration', () => {
    const latency = defineScorer(
      { name: 'latency_budget', direction: 'minimize', threshold: 12 },
      () => ({ name: 'latency_budget', value: 13, threshold: 15 }),
    );
    evaluate({ name: 'override', task: x => x, data: [{ input: 'q' }], scores: [latency] });
    const a = grades()['latency_budget'].attributes;
    expect(a[THRESHOLD]).toBe(15);
    expect(a['opensearch.evaluation.score.direction']).toBe('minimize');
    expect(a[ASSESSMENT]).toBe('pass');
  });

  it('propagates passed / assessment from returned scores', () => {
    const checks = (): EvalScore[] => [
      { name: 'a', value: 0.5, passed: true },
      { name: 'b', value: 0.5, assessment: 'fail' },
      { name: 'c', assessment: 'pass' },
      { name: 'd', value: 0.5, assessment: 'pass', passed: false },
    ];
    const result = evaluate({ name: 'explicit', task: x => x, data: [{ input: 'q' }], scores: [checks] });
    const g = grades();
    expect(g['a'].attributes[ASSESSMENT]).toBe('pass');
    expect(g['b'].attributes[ASSESSMENT]).toBe('fail');
    expect(g['c'].attributes[ASSESSMENT]).toBe('pass');
    expect(g['c'].attributes['gen_ai.evaluation.score.value']).toBeUndefined();
    expect(g['d'].attributes[ASSESSMENT]).toBe('pass');
    expect(result.cases[0].scores).toEqual({ a: 0.5, b: 0.5, d: 0.5 });
  });

  it('treats a boolean result as a verdict', () => {
    const tools = defineScorer({ name: 'tool_selection' }, () => false);
    evaluate({ name: 'bool', task: x => x, data: [{ input: 'q' }], scores: [tools] });
    const a = grades()['tool_selection'].attributes;
    expect(a['gen_ai.evaluation.score.value']).toBe(0);
    expect(a[ASSESSMENT]).toBe('fail');
  });

  it('keeps case status pass when nothing is declared', () => {
    const result = evaluate({ name: 'no-rules', task: x => x, data: [{ input: 'q' }], scores: [() => 0] });
    expect(result.cases[0].status).toBe('pass');
    expect(result.cases[0].assessments).toBeUndefined();
    expect(caseEvents()[0].attributes['test.case.result.status']).toBe('pass');
    expect(scoreRecords()[0].attributes[ASSESSMENT]).toBeUndefined();
  });

  it('fails a case on a fail verdict; run status reflects errors only', () => {
    const quality = defineScorer({ name: 'answer_quality', threshold: 4 }, (input) => (input === 'good' ? 5 : 2));
    const result = evaluate({
      name: 'verdicts',
      task: x => x,
      data: [{ input: 'good', caseId: 'g' }, { input: 'bad', caseId: 'b' }],
      scores: [quality],
    });
    expect(result.cases.map(c => c.status)).toEqual(['pass', 'fail']);
    expect(result.cases.map(c => c.resultStatus)).toEqual(['pass', 'fail']);
    const run = runEvents()[0].attributes;
    expect(run['opensearch.test_suite_run.pass_count']).toBe(1);
    expect(run['opensearch.test_suite_run.fail_count']).toBe(1);
    expect(run['test.suite.run.status']).toBe('success');
  });

  it('error beats a fail verdict', () => {
    const bad = () => { throw new Error('judge down'); };
    evaluate({
      name: 'err-first',
      task: x => x,
      data: [{ input: 'q' }],
      scores: [() => ({ name: 'x', value: 0, passed: false }), bad],
    });
    expect(caseEvents()[0].attributes['test.case.result.status']).toBe('error');
  });

  it('names the error grade after the declared evaluation name', () => {
    const quality = defineScorer(
      { name: 'answer_quality', threshold: 4, scoreMin: 1, scoreMax: 5 },
      function quality(): number { throw new TypeError('judge down'); },
    );
    evaluate({ name: 'err-name', task: x => x, data: [{ input: 'q' }], scores: [quality] });
    const g = grades();
    expect(Object.keys(g)).toEqual(['answer_quality']);
    const a = g['answer_quality'].attributes;
    expect(a['error.type']).toBe('TypeError');
    expect(a[THRESHOLD]).toBe(4);
    expect(a[ASSESSMENT]).toBeUndefined();
    expect(a['gen_ai.evaluation.score.value']).toBeUndefined();
  });

  it('falls back to the function name for an undeclared scorer that throws', () => {
    function quality(): number { throw new Error('judge down'); }
    evaluate({ name: 'err-fn', task: x => x, data: [{ input: 'q' }], scores: [quality] });
    const g = grades();
    expect(Object.keys(g)).toEqual(['quality']);
    expect(g['quality'].attributes['error.type']).toBe('Error');
  });

  it('Benchmark.log accepts EvalScore[] with verdicts', () => {
    const bm = new Benchmark('bench-verdicts');
    bm.log({
      input: 'q',
      caseId: 'c1',
      scores: [
        { name: 'answer_quality', value: 3, threshold: 4, scoreMin: 1, scoreMax: 5 },
        { name: 'tool_selection', value: 1, assessment: 'pass' },
      ],
    });
    bm.close();
    const g = grades();
    expect(g['answer_quality'].attributes[ASSESSMENT]).toBe('fail');
    expect(g['answer_quality'].attributes['opensearch.evaluation.score.max']).toBe(5);
    expect(g['tool_selection'].attributes[ASSESSMENT]).toBe('pass');
    expect(caseEvents()[0].attributes['test.case.result.status']).toBe('fail');
  });

  it('Benchmark.log keeps dict scores neutral and explicit status wins', () => {
    const bm = new Benchmark('bench-dict');
    bm.log({ input: 'q', caseId: 'a', scores: { accuracy: 0 } });
    bm.log({ input: 'q', caseId: 'b', scores: [{ name: 'x', value: 0, passed: false }], status: 'pass' });
    bm.close();
    expect(caseEvents().map(e => e.attributes['test.case.result.status'])).toEqual(['pass', 'pass']);
    expect(scoreRecords()[0].attributes[ASSESSMENT]).toBeUndefined();
  });
});
