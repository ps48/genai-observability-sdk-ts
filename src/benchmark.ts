// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import {
  trace,
  context as otelContext,
  SpanStatusCode,
  TraceFlags,
  type Span,
  type SpanContext,
  type Context,
  type Link,
  type Attributes,
} from '@opentelemetry/api';
import { createHash, randomUUID } from 'crypto';
import { RESERVED_KEYS, normalizeSpanId, normalizeTraceId, validateMetadataKeys } from './internal.js';
import { score } from './score.js';

const TRACER_NAME = "opensearch-genai-observability-sdk-ts-benchmarks";
const IO_TRUNCATION_LIMIT = 10_000;
const TRUNCATION_MARKER = "...[truncated]";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface EvalScore {
  name: string;
  value: number;
  label?: string;
  explanation?: string;
  metadata?: Record<string, unknown>;
}

export interface ScoreSummary {
  name: string;
  avg: number;
  min: number;
  max: number;
  count: number;
}

export interface BenchmarkSummary {
  benchmarkName: string;
  runId: string;
  totalCases: number;
  errorCount: number;
  durationMs: number;
  scores: Record<string, ScoreSummary>;
}

export interface TestCaseResult {
  caseId: string;
  caseName?: string;
  input: unknown;
  output: unknown;
  expected: unknown;
  scores: Record<string, number>;
  error?: string;
  status: string;
  scorerErrors?: string[];
}

export interface BenchmarkResult {
  summary: BenchmarkSummary;
  cases: TestCaseResult[];
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function makeRunId(): string {
  const now = new Date();
  const ts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '_',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  const short = randomUUID().replace(/-/g, '').slice(0, 8);
  return `run_${ts}_${short}`;
}

function makeCaseId(input: unknown): string {
  const serialized = JSON.stringify(input ?? '');
  return createHash('sha256').update(serialized).digest('hex').slice(0, 16);
}

function truncateIo(value: unknown): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (s.length <= IO_TRUNCATION_LIMIT) return s;
  return s.slice(0, IO_TRUNCATION_LIMIT - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

function toAttributes(record: Record<string, unknown>): Attributes {
  const attrs: Attributes = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      attrs[key] = value;
    }
  }
  return attrs;
}

function safeMetadata(
  metadata: Record<string, unknown> | undefined,
  context?: string,
): Record<string, unknown> {
  if (!metadata) return {};
  validateMetadataKeys(metadata, context);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!RESERVED_KEYS.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

function buildSpanLink(traceIdHex?: string, spanIdHex?: string): Link | null {
  // A link needs a real span id. Never derive one from the trace id.
  if (!traceIdHex || !spanIdHex) return null;
  const traceId = normalizeTraceId(traceIdHex);
  const spanId = normalizeSpanId(spanIdHex);
  if (!traceId || !spanId) return null;

  const spanContext: SpanContext = {
    traceId,
    spanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  };
  return { context: spanContext };
}

interface CaseIdentity {
  suiteName: string;
  runId: string;
  caseId: string;
  caseName?: string;
}

/**
 * Emit one gen_ai.evaluation.result event per score. Events are parented to
 * the evaluated span when traceId + spanId are known, scored at trace level
 * when only traceId is known, and otherwise parented to the test_case span.
 * Suite and case identity is copied onto each event.
 */
function emitCaseScores(
  caseSpan: Span,
  scores: EvalScore[],
  identity: CaseIdentity,
  target?: { traceId?: string; spanId?: string },
): void {
  // Pass the case span ids explicitly: works without a global context manager.
  const caseIds = caseSpan.spanContext();
  const testAttrs: Attributes = {
    "test.suite.name": identity.suiteName,
    "test.suite.run.id": identity.runId,
    "test.case.id": identity.caseId,
  };
  if (identity.caseName) testAttrs["test.case.name"] = identity.caseName;

  for (const s of scores) {
    const metadata = s.metadata ? toAttributes(safeMetadata(s.metadata, `score:${s.name}`)) : {};
    const options = {
      name: s.name,
      value: s.value,
      label: s.label,
      explanation: s.explanation,
      attributes: { ...metadata, ...testAttrs },
    };
    if (target?.traceId) {
      score({ ...options, traceId: target.traceId, spanId: target.spanId });
    } else {
      score({ ...options, traceId: caseIds.traceId, spanId: caseIds.spanId });
    }
  }
}

function computeSummary(
  name: string,
  runId: string,
  cases: TestCaseResult[],
  startTime: number,
): BenchmarkSummary {
  const errorCount = cases.filter(c => c.status === 'fail').length;
  const durationMs = Date.now() - startTime;

  const scoreAcc: Record<string, { sum: number; min: number; max: number; count: number }> = {};
  for (const c of cases) {
    for (const [scoreName, scoreValue] of Object.entries(c.scores)) {
      if (!scoreAcc[scoreName]) {
        scoreAcc[scoreName] = { sum: scoreValue, min: scoreValue, max: scoreValue, count: 1 };
      } else {
        const acc = scoreAcc[scoreName];
        acc.sum += scoreValue;
        acc.min = Math.min(acc.min, scoreValue);
        acc.max = Math.max(acc.max, scoreValue);
        acc.count += 1;
      }
    }
  }

  const scores: Record<string, ScoreSummary> = {};
  for (const [scoreName, acc] of Object.entries(scoreAcc)) {
    scores[scoreName] = {
      name: scoreName,
      avg: acc.count > 0 ? acc.sum / acc.count : 0,
      min: acc.min,
      max: acc.max,
      count: acc.count,
    };
  }

  return {
    benchmarkName: name,
    runId,
    totalCases: cases.length,
    errorCount,
    durationMs,
    scores,
  };
}

function formatSummary(summary: BenchmarkSummary): string {
  const lines: string[] = [];
  lines.push(`Benchmark: ${summary.benchmarkName}`);
  lines.push(`Run ID:    ${summary.runId}`);
  lines.push(`Cases:     ${summary.totalCases} (${summary.errorCount} errors)`);
  lines.push(`Duration:  ${summary.durationMs}ms`);

  const scoreNames = Object.keys(summary.scores);
  if (scoreNames.length > 0) {
    lines.push('Scores:');
    for (const name of scoreNames) {
      const s = summary.scores[name];
      lines.push(`  ${name}: avg=${s.avg.toFixed(3)} min=${s.min.toFixed(3)} max=${s.max.toFixed(3)} (n=${s.count})`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Benchmark class
// ---------------------------------------------------------------------------

export class Benchmark {
  private _name: string;
  private _metadata: Record<string, unknown>;
  private _recordIo: boolean;
  private _runId: string;
  private _startTime: number;
  private _cases: TestCaseResult[] = [];
  private _closed = false;
  private _rootSpan: Span;
  private _rootContext: Context;

  constructor(name: string, options?: { metadata?: Record<string, unknown>; recordIo?: boolean }) {
    this._name = name;
    this._metadata = safeMetadata(options?.metadata, `benchmark:${name}`);
    this._recordIo = options?.recordIo ?? false;
    this._runId = makeRunId();
    this._startTime = Date.now();

    const tracer = trace.getTracer(TRACER_NAME);
    const rootAttrs: Attributes = {
      ...toAttributes(this._metadata),
      "test.suite.name": name,
      "test.suite.run.id": this._runId,
    };

    this._rootSpan = tracer.startSpan(`test_suite_run ${name}`, { attributes: rootAttrs });
    this._rootContext = trace.setSpan(otelContext.active(), this._rootSpan);
  }

  get name(): string {
    return this._name;
  }

  get runId(): string {
    return this._runId;
  }

  log(options: {
    input?: unknown;
    output?: unknown;
    expected?: unknown;
    scores?: Record<string, number>;
    metadata?: Record<string, unknown>;
    error?: string;
    caseId?: string;
    caseName?: string;
    traceId?: string;
    spanId?: string;
  }): void {
    if (this._closed) {
      throw new Error('Benchmark is already closed');
    }

    if (options.spanId && !options.traceId) {
      throw new Error('spanId requires traceId');
    }

    const caseId = options.caseId ?? makeCaseId(options.input);
    const hasError = options.error !== undefined;
    const status = hasError ? 'fail' : 'pass';

    const tracer = trace.getTracer(TRACER_NAME);

    const caseMeta = safeMetadata(options.metadata, `case:${caseId}`);
    const spanAttrs: Attributes = {
      ...toAttributes(caseMeta),
      "test.suite.name": this._name,
      "test.suite.run.id": this._runId,
      "test.case.id": caseId,
      "test.case.result.status": status,
    };

    if (options.caseName) spanAttrs["test.case.name"] = options.caseName;
    if (hasError) spanAttrs["opensearch.test_case.error"] = options.error;

    if (this._recordIo) {
      if (options.input !== undefined) spanAttrs["opensearch.test_case.input"] = truncateIo(options.input);
      if (options.output !== undefined) spanAttrs["opensearch.test_case.output"] = truncateIo(options.output);
      if (options.expected !== undefined) spanAttrs["opensearch.test_case.expected"] = truncateIo(options.expected);
    }

    const links: Link[] = [];
    const link = buildSpanLink(options.traceId, options.spanId);
    if (link) links.push(link);

    const span = tracer.startSpan(
      `test_case ${options.caseName ?? caseId}`,
      { attributes: spanAttrs, links },
      this._rootContext,
    );

    if (options.scores) {
      const evalScores: EvalScore[] = Object.entries(options.scores).map(
        ([name, value]) => ({ name, value }),
      );
      emitCaseScores(
        span,
        evalScores,
        { suiteName: this._name, runId: this._runId, caseId, caseName: options.caseName },
        { traceId: options.traceId, spanId: options.spanId },
      );
    }

    if (hasError) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: options.error });
    }

    span.end();

    this._cases.push({
      caseId,
      caseName: options.caseName,
      input: options.input,
      output: options.output,
      expected: options.expected,
      scores: options.scores ?? {},
      error: options.error,
      status,
    });
  }

  close(): BenchmarkSummary {
    if (this._closed) {
      throw new Error('Benchmark is already closed');
    }
    this._closed = true;

    const errorCount = this._cases.filter(c => c.status === 'fail').length;
    const suiteStatus = errorCount === 0 ? 'success' : 'failure';

    this._rootSpan.setAttribute("test.suite.run.status", suiteStatus);
    if (errorCount > 0) {
      this._rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: `${errorCount} case(s) failed` });
    }
    this._rootSpan.end();

    const summary = computeSummary(this._name, this._runId, this._cases, this._startTime);
    console.log(formatSummary(summary));
    return summary;
  }
}

// ---------------------------------------------------------------------------
// evaluate() function
// ---------------------------------------------------------------------------

type ScorerFn = (input: unknown, output: unknown, expected: unknown) => EvalScore | EvalScore[] | number;

export function evaluate(options: {
  name: string;
  task: (input: unknown) => unknown;
  data: Array<{ input: unknown; expected?: unknown; caseId?: string; caseName?: string }>;
  scores: ScorerFn[];
  metadata?: Record<string, unknown>;
  recordIo?: boolean;
}): BenchmarkResult {
  const filteredMetadata = safeMetadata(options.metadata, `evaluate:${options.name}`);
  const recordIo = options.recordIo ?? false;
  const runId = makeRunId();
  const startTime = Date.now();
  const cases: TestCaseResult[] = [];

  const tracer = trace.getTracer(TRACER_NAME);

  const rootAttrs: Attributes = {
    ...toAttributes(filteredMetadata),
    "test.suite.name": options.name,
    "test.suite.run.id": runId,
  };

  const rootSpan = tracer.startSpan(`test_suite_run ${options.name}`, { attributes: rootAttrs });
  const rootContext = trace.setSpan(otelContext.active(), rootSpan);

  for (const item of options.data) {
    const caseId = item.caseId ?? makeCaseId(item.input);
    const caseName = item.caseName;
    const expected = item.expected;

    let output: unknown;
    let error: string | undefined;
    let caseStatus = 'pass';
    const caseScores: Record<string, number> = {};
    const evalScores: EvalScore[] = [];
    const scorerErrors: string[] = [];

    // Run task
    try {
      output = options.task(item.input);
      if (output instanceof Promise) {
        throw new Error(
          "evaluate() does not support async task functions. " +
          "The task returned a Promise — use a synchronous task or await the async call inside a sync wrapper."
        );
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      caseStatus = 'fail';
    }

    // Run scorers
    if (caseStatus !== 'fail') {
      for (const scorer of options.scores) {
        try {
          const result = scorer(item.input, output, expected);
          if (typeof result === 'number') {
            const scoreName = scorer.name || 'score';
            const es: EvalScore = { name: scoreName, value: result };
            evalScores.push(es);
            caseScores[es.name] = es.value;
          } else if (Array.isArray(result)) {
            for (const es of result) {
              evalScores.push(es);
              caseScores[es.name] = es.value;
            }
          } else {
            evalScores.push(result);
            caseScores[result.name] = result.value;
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          scorerErrors.push(msg);
        }
      }
    }

    const spanAttrs: Attributes = {
      "test.suite.name": options.name,
      "test.suite.run.id": runId,
      "test.case.id": caseId,
      "test.case.result.status": caseStatus,
    };

    if (caseName) spanAttrs["test.case.name"] = caseName;
    if (error) spanAttrs["opensearch.test_case.error"] = error;

    if (recordIo) {
      if (item.input !== undefined) spanAttrs["opensearch.test_case.input"] = truncateIo(item.input);
      if (output !== undefined) spanAttrs["opensearch.test_case.output"] = truncateIo(output);
      if (expected !== undefined) spanAttrs["opensearch.test_case.expected"] = truncateIo(expected);
    }

    const caseSpan = tracer.startSpan(
      `test_case ${caseName ?? caseId}`,
      { attributes: spanAttrs },
      rootContext,
    );

    emitCaseScores(caseSpan, evalScores, { suiteName: options.name, runId, caseId, caseName });

    if (caseStatus === 'fail') {
      caseSpan.setStatus({ code: SpanStatusCode.ERROR, message: error });
    }

    caseSpan.end();

    cases.push({
      caseId,
      caseName,
      input: item.input,
      output,
      expected,
      scores: caseScores,
      error,
      status: caseStatus,
      scorerErrors: scorerErrors.length > 0 ? scorerErrors : undefined,
    });
  }

  // Finalize root span
  const errorCount = cases.filter(c => c.status === 'fail').length;
  const suiteStatus = errorCount === 0 ? 'success' : 'failure';
  rootSpan.setAttribute("test.suite.run.status", suiteStatus);
  if (errorCount > 0) {
    rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: `${errorCount} case(s) failed` });
  }
  rootSpan.end();

  const summary = computeSummary(options.name, runId, cases, startTime);
  console.log(formatSummary(summary));

  return { summary, cases };
}
