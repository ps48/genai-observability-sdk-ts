// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Offline evaluation runs: `evaluate()` and `Benchmark`.
 *
 * Default shape (no harness spans):
 *
 * ```
 * trace (one per test case)       the agent run, exactly like production
 *   root span                     + test.suite.name, test.suite.run.id, test.case.id, test.case.name
 *   LogRecord gen_ai.evaluation.result      one per score, parented to the root span, test.* copied
 *   LogRecord opensearch.test_case.result   one per case, parented to the root span
 * LogRecord opensearch.test_suite_run.result   one per run, no trace context
 * ```
 *
 * `traceStructure: true` also creates the older `test_suite_run <suite>` /
 * `test_case <case>` spans (scores then parent to the case span) and still
 * emits the case and run events.
 */

import {
  trace,
  context as otelContext,
  ROOT_CONTEXT,
  SpanStatusCode,
  TraceFlags,
  type Span,
  type SpanContext,
  type Context,
  type Link,
  type Attributes,
} from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { createHash, randomUUID } from 'crypto';
import { RESERVED_KEYS, normalizeSpanId, normalizeTraceId, validateMetadataKeys } from './internal.js';
import { resolveLoggerProvider } from './logs.js';
import { score } from './score.js';
import {
  BENCHMARK_TRACER_NAME,
  ensureGlobalTestCaseProcessor,
  runInTestCase,
  type ActiveTestCase,
} from './testcase.js';
import { SDK_SCOPE_NAME, SDK_VERSION } from './version.js';

const TRACER_NAME = BENCHMARK_TRACER_NAME;
const IO_TRUNCATION_LIMIT = 10_000;
const TRUNCATION_MARKER = "...[truncated]";

/** OTel event name of one test case result. */
export const TEST_CASE_RESULT_EVENT = "opensearch.test_case.result";
/** OTel event name of one test suite run result. */
export const TEST_SUITE_RUN_RESULT_EVENT = "opensearch.test_suite_run.result";

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

/** `test.case.result.status` of a case event. */
export type TestCaseStatus = "pass" | "fail" | "error";
const CASE_STATUSES: readonly TestCaseStatus[] = ["pass", "fail", "error"];

export interface BenchmarkSummary {
  benchmarkName: string;
  runId: string;
  totalCases: number;
  /** Cases whose task or a scorer raised (status `error`). */
  errorCount: number;
  passCount: number;
  failCount: number;
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
  /** Legacy status: `"pass"`, or `"fail"` when the case errored. */
  status: string;
  /** `test.case.result.status` emitted on the case event. */
  resultStatus: TestCaseStatus;
  /** `error.type` (exception class name) when the case errored. */
  errorType?: string;
  durationMs?: number;
  /** Trace and span id of the agent run's root span, when the task created one. */
  traceId?: string;
  spanId?: string;
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

function errorTypeOf(e: unknown): string {
  if (e instanceof Error) return e.constructor?.name || e.name || 'Error';
  return typeof e;
}

/** Elapsed milliseconds, kept fractional so OTLP encodes it as a double. */
function elapsedMs(start: number): number {
  return performance.now() - start;
}

function spanContextFrom(traceIdHex?: string, spanIdHex?: string): SpanContext | null {
  // Needs a real span id. Never derive one from the trace id.
  if (!traceIdHex || !spanIdHex) return null;
  const traceId = normalizeTraceId(traceIdHex);
  const spanId = normalizeSpanId(spanIdHex);
  if (!traceId || !spanId) return null;
  return { traceId, spanId, traceFlags: TraceFlags.SAMPLED, isRemote: true };
}

function buildSpanLink(traceIdHex?: string, spanIdHex?: string): Link | null {
  const spanContext = spanContextFrom(traceIdHex, spanIdHex);
  return spanContext ? { context: spanContext } : null;
}

interface CaseIdentity {
  suiteName: string;
  runId: string;
  caseId: string;
  caseName?: string;
}

function identityAttributes(identity: CaseIdentity): Record<string, string> {
  const attrs: Record<string, string> = {
    "test.suite.name": identity.suiteName,
    "test.suite.run.id": identity.runId,
    "test.case.id": identity.caseId,
  };
  if (identity.caseName) attrs["test.case.name"] = identity.caseName;
  return attrs;
}

/**
 * Emit one gen_ai.evaluation.result event per score, with the suite and case
 * identity copied. `target` is the evaluated span (the agent run's root span,
 * a caller-supplied span, or the opt-in test_case span). With only a trace id
 * the score is trace-level; with neither the event has no trace context.
 */
function emitCaseScores(
  scores: EvalScore[],
  identity: CaseIdentity,
  target: { traceId?: string; spanId?: string },
): void {
  const testAttrs = identityAttributes(identity);
  for (const s of scores) {
    const metadata = s.metadata ? toAttributes(safeMetadata(s.metadata, `score:${s.name}`)) : {};
    const options = {
      name: s.name,
      value: s.value,
      label: s.label,
      explanation: s.explanation,
      attributes: { ...metadata, ...testAttrs },
      traceId: target.traceId,
      spanId: target.traceId ? target.spanId : undefined,
    };
    // No target: do not pick up whatever span the caller has active.
    otelContext.with(ROOT_CONTEXT, () => score(options));
  }
}

function emitEvent(eventName: string, attributes: Attributes, parent?: SpanContext | null): void {
  const ctx = parent
    ? trace.setSpanContext(ROOT_CONTEXT, { ...parent, isRemote: true })
    : ROOT_CONTEXT;
  resolveLoggerProvider().getLogger(SDK_SCOPE_NAME, SDK_VERSION).emit({
    eventName,
    timestamp: Date.now(),
    severityNumber: SeverityNumber.INFO,
    attributes,
    context: ctx,
  });
}

function emitCaseEvent(options: {
  identity: CaseIdentity;
  status: TestCaseStatus;
  errorType?: string;
  recordIo: boolean;
  input?: unknown;
  output?: unknown;
  expected?: unknown;
  durationMs?: number;
  metadata: Attributes;
  parent?: SpanContext | null;
}): void {
  const attrs: Attributes = {
    ...options.metadata,
    ...identityAttributes(options.identity),
    "test.case.result.status": options.status,
  };
  if (options.errorType) attrs["error.type"] = options.errorType;
  if (options.recordIo) {
    if (options.input !== undefined) attrs["opensearch.test_case.input"] = truncateIo(options.input);
    if (options.expected !== undefined) attrs["opensearch.test_case.expected"] = truncateIo(options.expected);
    if (options.output !== undefined) attrs["opensearch.test_case.output"] = truncateIo(options.output);
  }
  if (options.durationMs !== undefined) attrs["opensearch.test_case.duration_ms"] = options.durationMs;
  emitEvent(TEST_CASE_RESULT_EVENT, attrs, options.parent);
}

function emitRunEvent(summary: BenchmarkSummary, metadata: Attributes): void {
  emitEvent(TEST_SUITE_RUN_RESULT_EVENT, {
    ...metadata,
    "test.suite.name": summary.benchmarkName,
    "test.suite.run.id": summary.runId,
    "test.suite.run.status": summary.errorCount === 0 ? 'success' : 'failure',
    "opensearch.test_suite_run.case_count": summary.totalCases,
    "opensearch.test_suite_run.pass_count": summary.passCount,
    "opensearch.test_suite_run.fail_count": summary.failCount,
    "opensearch.test_suite_run.error_count": summary.errorCount,
    "opensearch.test_suite_run.duration_ms": summary.durationMs,
  });
}

function computeSummary(
  name: string,
  runId: string,
  cases: TestCaseResult[],
  durationMs: number,
): BenchmarkSummary {
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
    errorCount: cases.filter(c => c.resultStatus === 'error').length,
    passCount: cases.filter(c => c.resultStatus === 'pass').length,
    failCount: cases.filter(c => c.resultStatus === 'fail').length,
    durationMs,
    scores,
  };
}

function formatSummary(summary: BenchmarkSummary): string {
  const lines: string[] = [];
  lines.push(`Benchmark: ${summary.benchmarkName}`);
  lines.push(`Run ID:    ${summary.runId}`);
  lines.push(`Cases:     ${summary.totalCases} (${summary.errorCount} errors)`);
  lines.push(`Duration:  ${Math.round(summary.durationMs)}ms`);

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

/** Opt-in harness span tree (`traceStructure: true`). */
class SuiteSpans {
  readonly rootSpan: Span;
  readonly rootContext: Context;

  constructor(name: string, runId: string, metadata: Attributes) {
    this.rootSpan = trace.getTracer(TRACER_NAME).startSpan(`test_suite_run ${name}`, {
      attributes: { ...metadata, "test.suite.name": name, "test.suite.run.id": runId },
    });
    this.rootContext = trace.setSpan(otelContext.active(), this.rootSpan);
  }

  startCase(identity: CaseIdentity, attributes: Attributes, links: Link[] = []): Span {
    return trace.getTracer(TRACER_NAME).startSpan(
      `test_case ${identity.caseName ?? identity.caseId}`,
      { attributes: { ...attributes, ...identityAttributes(identity) }, links },
      this.rootContext,
    );
  }

  end(errorCount: number): void {
    this.rootSpan.setAttribute("test.suite.run.status", errorCount === 0 ? 'success' : 'failure');
    if (errorCount > 0) {
      this.rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: `${errorCount} case(s) failed` });
    }
    this.rootSpan.end();
  }
}

function finishCaseSpan(
  span: Span,
  legacyStatus: string,
  error: string | undefined,
  io: { recordIo: boolean; input?: unknown; output?: unknown; expected?: unknown },
): void {
  span.setAttribute("test.case.result.status", legacyStatus);
  if (error) span.setAttribute("opensearch.test_case.error", error);
  if (io.recordIo) {
    if (io.input !== undefined) span.setAttribute("opensearch.test_case.input", truncateIo(io.input));
    if (io.output !== undefined) span.setAttribute("opensearch.test_case.output", truncateIo(io.output));
    if (io.expected !== undefined) span.setAttribute("opensearch.test_case.expected", truncateIo(io.expected));
  }
  if (legacyStatus === 'fail') span.setStatus({ code: SpanStatusCode.ERROR, message: error });
  span.end();
}

// ---------------------------------------------------------------------------
// Benchmark class
// ---------------------------------------------------------------------------

export interface BenchmarkOptions {
  metadata?: Record<string, unknown>;
  recordIo?: boolean;
  /** Also create `test_suite_run` / `test_case` spans (pre-0.2 shape). Default false. */
  traceStructure?: boolean;
}

/**
 * Upload results of cases you ran yourself. Each `log()` emits score events
 * and one `opensearch.test_case.result` event, parented to the evaluated span
 * when `traceId` + `spanId` are given. `close()` emits the run event.
 */
export class Benchmark {
  private _name: string;
  private _metadata: Record<string, unknown>;
  private _recordIo: boolean;
  private _runId: string;
  private _start: number;
  private _cases: TestCaseResult[] = [];
  private _closed = false;
  private _spans?: SuiteSpans;

  constructor(name: string, options?: BenchmarkOptions) {
    this._name = name;
    this._metadata = safeMetadata(options?.metadata, `benchmark:${name}`);
    this._recordIo = options?.recordIo ?? false;
    this._runId = makeRunId();
    this._start = performance.now();
    if (options?.traceStructure) {
      this._spans = new SuiteSpans(name, this._runId, toAttributes(this._metadata));
    }
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
    /** Error message. The case event status becomes `error` (`status` stays `fail`). */
    error?: string;
    /** `error.type` for an errored case (exception class name or similar). */
    errorType?: string;
    /** Explicit case status. Default `error` when `error` or `errorType` is given, else `pass`. */
    status?: TestCaseStatus;
    caseId?: string;
    caseName?: string;
    traceId?: string;
    spanId?: string;
    /** `opensearch.test_case.duration_ms`, if you measured it. */
    durationMs?: number;
  }): void {
    if (this._closed) {
      throw new Error('Benchmark is already closed');
    }

    if (options.spanId && !options.traceId) {
      throw new Error('spanId requires traceId');
    }

    const caseId = options.caseId ?? makeCaseId(options.input);
    const identity: CaseIdentity = {
      suiteName: this._name,
      runId: this._runId,
      caseId,
      caseName: options.caseName,
    };
    if (options.status !== undefined && !CASE_STATUSES.includes(options.status)) {
      throw new Error(`status must be one of ${CASE_STATUSES.join(', ')}; got "${options.status}"`);
    }
    const hasError = options.error !== undefined;
    const resultStatus: TestCaseStatus =
      options.status ?? (hasError || options.errorType ? 'error' : 'pass');
    const legacyStatus = options.status ?? (hasError ? 'fail' : 'pass');
    const errorType = options.errorType;
    const caseMeta = toAttributes(safeMetadata(options.metadata, `case:${caseId}`));
    const evaluated = spanContextFrom(options.traceId, options.spanId);

    let caseSpan: Span | undefined;
    if (this._spans) {
      const links: Link[] = [];
      const link = buildSpanLink(options.traceId, options.spanId);
      if (link) links.push(link);
      caseSpan = this._spans.startCase(identity, caseMeta, links);
    }

    if (options.scores) {
      const evalScores: EvalScore[] = Object.entries(options.scores).map(
        ([name, value]) => ({ name, value }),
      );
      const caseIds = caseSpan?.spanContext();
      const target = options.traceId
        ? { traceId: options.traceId, spanId: options.spanId }
        : { traceId: caseIds?.traceId, spanId: caseIds?.spanId };
      emitCaseScores(evalScores, identity, target);
    }

    if (caseSpan) {
      finishCaseSpan(caseSpan, legacyStatus, options.error, {
        recordIo: this._recordIo,
        input: options.input,
        output: options.output,
        expected: options.expected,
      });
    }

    emitCaseEvent({
      identity,
      status: resultStatus,
      errorType,
      recordIo: this._recordIo,
      input: options.input,
      output: options.output,
      expected: options.expected,
      durationMs: options.durationMs,
      metadata: { ...toAttributes(this._metadata), ...caseMeta },
      parent: evaluated ?? caseSpan?.spanContext(),
    });

    this._cases.push({
      caseId,
      caseName: options.caseName,
      input: options.input,
      output: options.output,
      expected: options.expected,
      scores: options.scores ?? {},
      error: options.error,
      status: legacyStatus,
      resultStatus,
      errorType,
      durationMs: options.durationMs,
      traceId: evaluated?.traceId,
      spanId: evaluated?.spanId,
    });
  }

  close(): BenchmarkSummary {
    if (this._closed) {
      throw new Error('Benchmark is already closed');
    }
    this._closed = true;

    const summary = computeSummary(this._name, this._runId, this._cases, elapsedMs(this._start));
    this._spans?.end(summary.errorCount);
    emitRunEvent(summary, toAttributes(this._metadata));
    console.log(formatSummary(summary));
    return summary;
  }
}

// ---------------------------------------------------------------------------
// evaluate() function
// ---------------------------------------------------------------------------

type ScorerFn = (input: unknown, output: unknown, expected: unknown) => EvalScore | EvalScore[] | number;

export interface EvaluateOptions {
  name: string;
  task: (input: unknown) => unknown;
  data: Array<{ input: unknown; expected?: unknown; caseId?: string; caseName?: string }>;
  scores: ScorerFn[];
  metadata?: Record<string, unknown>;
  recordIo?: boolean;
  /**
   * Also create `test_suite_run` / `test_case` spans (pre-0.2 shape). The task
   * runs inside the case span and scores parent to it. Case and run events
   * are still emitted. Default false.
   */
  traceStructure?: boolean;
}

/**
 * Run `task` on each data item, score it and record the run.
 *
 * Cases run one at a time and `task` must be synchronous. While a case runs,
 * the SDK's TestCaseSpanProcessor stamps `test.*` ids on the root span(s) the
 * task starts and remembers the first one, so score events and the case event
 * are parented to the agent run's own trace. The TypeScript SDK has no default
 * context manager, so this uses a module-level "current case" instead of the
 * active OTel context.
 */
export function evaluate(options: EvaluateOptions): BenchmarkResult {
  const filteredMetadata = toAttributes(safeMetadata(options.metadata, `evaluate:${options.name}`));
  const recordIo = options.recordIo ?? false;
  const runId = makeRunId();
  const runStart = performance.now();
  const cases: TestCaseResult[] = [];

  ensureGlobalTestCaseProcessor();
  const spans = options.traceStructure
    ? new SuiteSpans(options.name, runId, filteredMetadata)
    : undefined;

  for (const item of options.data) {
    const caseStart = performance.now();
    const identity: CaseIdentity = {
      suiteName: options.name,
      runId,
      caseId: item.caseId ?? makeCaseId(item.input),
      caseName: item.caseName,
    };
    const expected = item.expected;

    let output: unknown;
    let error: string | undefined;
    let errorType: string | undefined;
    const caseScores: Record<string, number> = {};
    const evalScores: EvalScore[] = [];
    const scorerErrors: string[] = [];

    const caseSpan = spans?.startCase(identity, {});
    // Default: the agent run is its own trace. traceStructure: inside the case span.
    const taskContext = caseSpan ? trace.setSpan(otelContext.active(), caseSpan) : ROOT_CONTEXT;
    const active: ActiveTestCase = { attributes: identityAttributes(identity), seen: new Set() };

    // Run task
    try {
      output = runInTestCase(active, () => otelContext.with(taskContext, () => options.task(item.input)));
      if (output instanceof Promise) {
        output.catch(() => {});
        throw new Error(
          "evaluate() does not support async task functions. " +
          "The task returned a Promise — use a synchronous task or await the async call inside a sync wrapper."
        );
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      errorType = errorTypeOf(e);
    }

    // Run scorers (outside the case: judge spans are not the agent run)
    if (error === undefined) {
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
          errorType ??= errorTypeOf(e);
        }
      }
    }

    const resultStatus: TestCaseStatus = errorType ? 'error' : 'pass';
    const legacyStatus = resultStatus === 'error' ? 'fail' : 'pass';
    const root = active.root;
    const caseIds = caseSpan?.spanContext();

    const scoreTarget = caseIds ?? root;
    emitCaseScores(evalScores, identity, { traceId: scoreTarget?.traceId, spanId: scoreTarget?.spanId });

    if (caseSpan) {
      finishCaseSpan(caseSpan, legacyStatus, error ?? scorerErrors[0], {
        recordIo,
        input: item.input,
        output,
        expected,
      });
    }

    const durationMs = elapsedMs(caseStart);
    emitCaseEvent({
      identity,
      status: resultStatus,
      errorType,
      recordIo,
      input: item.input,
      output,
      expected,
      durationMs,
      metadata: filteredMetadata,
      parent: root ?? caseIds,
    });

    cases.push({
      caseId: identity.caseId,
      caseName: identity.caseName,
      input: item.input,
      output,
      expected,
      scores: caseScores,
      error,
      status: legacyStatus,
      resultStatus,
      errorType,
      durationMs,
      traceId: root?.traceId,
      spanId: root?.spanId,
      scorerErrors: scorerErrors.length > 0 ? scorerErrors : undefined,
    });
  }

  const summary = computeSummary(options.name, runId, cases, elapsedMs(runStart));
  spans?.end(summary.errorCount);
  emitRunEvent(summary, filteredMetadata);
  console.log(formatSummary(summary));

  return { summary, cases };
}
