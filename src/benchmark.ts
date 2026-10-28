// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Offline evaluation runs: `evaluate()` and `Benchmark`.
 *
 * Shape of a run:
 *
 * ```
 * trace (one per test case)       the agent run, exactly like production
 *   root span                     + test.suite.name, test.suite.run.id, test.case.id, test.case.name
 *   LogRecord gen_ai.evaluation.result      one per score, parented to the root span, test.* copied
 *   LogRecord opensearch.test_case.result   one per case, parented to the root span
 * LogRecord opensearch.test_suite_run.result   one per run, no trace context
 * ```
 *
 * The SDK creates no spans of its own for a run.
 */

import {
  trace,
  context as otelContext,
  ROOT_CONTEXT,
  TraceFlags,
  type SpanContext,
  type Attributes,
} from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { createHash, randomUUID } from 'crypto';
import { RESERVED_KEYS, normalizeSpanId, normalizeTraceId, validateMetadataKeys } from './internal.js';
import { getEventLogger } from './logs.js';
import {
  score,
  normalizeAssessment,
  resolveAssessment,
  type Assessment,
  type EvaluatorType,
  type ScoreDirection,
} from './score.js';
import {
  ensureGlobalTestCaseProcessor,
  runInTestCase,
  type ActiveTestCase,
} from './testcase.js';

const IO_TRUNCATION_LIMIT = 10_000;
const TRUNCATION_MARKER = "...[truncated]";

/** OTel event name of one test case result. */
export const TEST_CASE_RESULT_EVENT = "opensearch.test_case.result";
/** OTel event name of one test suite run result. */
export const TEST_SUITE_RUN_RESULT_EVENT = "opensearch.test_suite_run.result";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/**
 * One score from a scorer (or passed to `Benchmark.log({ scores: [...] })`).
 *
 * Verdict fields are optional; unset ones fall back to the scorer's
 * `defineScorer()` declaration. `assessment` (or `passed`) is an explicit
 * verdict and wins; otherwise `threshold` + `direction` is applied to `value`.
 */
export interface EvalScore {
  name: string;
  /** Numeric score. May be omitted for a verdict-only result. */
  value?: number;
  label?: string;
  explanation?: string;
  metadata?: Record<string, unknown>;
  /** Explicit verdict (`opensearch.evaluation.assessment`). Wins over `passed`. */
  assessment?: Assessment;
  /** Explicit verdict as a boolean. */
  passed?: boolean;
  /** `opensearch.evaluation.score.threshold`. */
  threshold?: number;
  /** `opensearch.evaluation.score.direction` (default `maximize` with a threshold). */
  direction?: ScoreDirection;
  scoreMin?: number;
  scoreMax?: number;
}

/** What a scorer declares about the evaluation it produces (see `defineScorer`). */
export interface ScorerSpec {
  /**
   * `gen_ai.evaluation.name` of number/boolean results and of the error grade
   * emitted when the scorer throws. Default: the function name.
   */
  name?: string;
  /** Default `maximize` when `threshold` is set. */
  direction?: ScoreDirection;
  threshold?: number;
  scoreMin?: number;
  scoreMax?: number;
  /** Evaluator identity: instrumentation scope and `opensearch.evaluation.evaluator.name`. */
  evaluator?: string;
  evaluatorType?: EvaluatorType;
}

export type ScorerFn = (
  input: unknown,
  output: unknown,
  expected: unknown,
) => EvalScore | EvalScore[] | number | boolean;

/** A scorer function with its declared name and rule attached. */
export type Scorer = ScorerFn & { readonly scorerSpec: ScorerSpec };

const DIRECTIONS: readonly ScoreDirection[] = ['maximize', 'minimize'];
const EVALUATOR_TYPES: readonly EvaluatorType[] = ['llm_judge', 'code', 'human', 'external'];

/**
 * Declare a scorer's evaluation name and pass rule for `evaluate()`.
 *
 * ```ts
 * const quality = defineScorer(
 *   { name: 'answer_quality', threshold: 4, scoreMin: 1, scoreMax: 5, evaluatorType: 'llm_judge' },
 *   (input, output) => judge(input, output),
 * );
 * ```
 *
 * Rule fields are defaults for every score the scorer returns; fields set on a
 * returned `EvalScore` win. Throws on an unknown `direction` / `evaluatorType`
 * or a non-finite `threshold` / `scoreMin` / `scoreMax`.
 */
export function defineScorer(spec: ScorerSpec, fn: ScorerFn): Scorer {
  if (spec.direction !== undefined && !DIRECTIONS.includes(spec.direction)) {
    throw new Error(`direction must be one of ${DIRECTIONS.join(', ')}; got "${spec.direction}"`);
  }
  if (spec.evaluatorType !== undefined && !EVALUATOR_TYPES.includes(spec.evaluatorType)) {
    throw new Error(
      `evaluatorType must be one of ${EVALUATOR_TYPES.join(', ')}; got "${spec.evaluatorType}"`,
    );
  }
  for (const key of ['threshold', 'scoreMin', 'scoreMax'] as const) {
    const v = spec[key];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) {
      throw new Error(`${key} must be a finite number; got ${JSON.stringify(v)}`);
    }
  }
  const resolved: ScorerSpec = {
    ...spec,
    direction: spec.direction ?? (spec.threshold !== undefined ? 'maximize' : undefined),
  };
  const scorer = ((input: unknown, output: unknown, expected: unknown) =>
    fn(input, output, expected)) as Scorer;
  Object.defineProperty(scorer, 'name', { value: fn.name || spec.name || 'score' });
  Object.defineProperty(scorer, 'scorerSpec', { value: Object.freeze(resolved), enumerable: true });
  return scorer;
}

function specOf(fn: ScorerFn): ScorerSpec | undefined {
  return (fn as Partial<Scorer>).scorerSpec;
}

/** Fill unset rule fields of a score from its scorer's declaration. */
function applySpec(s: EvalScore, spec?: ScorerSpec): EvalScore {
  if (!spec) return s;
  return {
    ...s,
    threshold: s.threshold ?? spec.threshold,
    direction: s.direction ?? spec.direction,
    scoreMin: s.scoreMin ?? spec.scoreMin,
    scoreMax: s.scoreMax ?? spec.scoreMax,
  };
}

/** Verdict of a score: explicit `assessment` / `passed`, else threshold rule. */
function verdictOf(s: EvalScore): Assessment | undefined {
  let explicit = s.assessment !== undefined ? normalizeAssessment(s.assessment) : undefined;
  if (explicit === undefined && s.passed !== undefined) explicit = normalizeAssessment(Boolean(s.passed));
  return resolveAssessment({
    value: s.value,
    assessment: explicit,
    threshold: s.threshold,
    direction: s.direction,
  });
}

function assessmentsOf(scores: EvalScore[]): Record<string, Assessment> {
  const out: Record<string, Assessment> = {};
  for (const s of scores) {
    const v = verdictOf(s);
    if (v) out[s.name] = v;
  }
  return out;
}

function hasFailVerdict(assessments: Record<string, Assessment>): boolean {
  return Object.values(assessments).includes('fail');
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
  /** Legacy status: `"pass"`, or `"fail"` when the case errored or a score failed its verdict. */
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
  /** Evaluation name to declared verdict, for scores that have one. */
  assessments?: Record<string, Assessment>;
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
 * identity copied. `target` is the evaluated span (the agent run's root span
 * or a caller-supplied span). With only a trace id
 * the score is trace-level; with neither the event has no trace context.
 */
function emitCaseScores(
  scores: EvalScore[],
  identity: CaseIdentity,
  target: { traceId?: string; spanId?: string },
  extra: { evaluator?: string; evaluatorType?: EvaluatorType; errorType?: string } = {},
): void {
  const testAttrs = identityAttributes(identity);
  for (const s of scores) {
    const metadata = s.metadata ? toAttributes(safeMetadata(s.metadata, `score:${s.name}`)) : {};
    const options = {
      name: s.name,
      value: s.value,
      label: s.label,
      explanation: s.explanation,
      direction: s.direction,
      scoreMin: s.scoreMin,
      scoreMax: s.scoreMax,
      threshold: s.threshold,
      assessment: verdictOf(s),
      evaluator: extra.evaluator,
      evaluatorType: extra.evaluatorType,
      errorType: extra.errorType,
      attributes: { ...metadata, ...testAttrs },
      traceId: target.traceId,
      spanId: target.traceId ? target.spanId : undefined,
    };
    // No target: do not pick up whatever span the caller has active.
    otelContext.with(ROOT_CONTEXT, () => score(options));
  }
}

function scoreValues(scores: EvalScore[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of scores) if (s.value !== undefined) out[s.name] = s.value;
  return out;
}

function emitEvent(eventName: string, attributes: Attributes, parent?: SpanContext | null): void {
  const ctx = parent
    ? trace.setSpanContext(ROOT_CONTEXT, { ...parent, isRemote: true })
    : ROOT_CONTEXT;
  getEventLogger().emit({
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

// ---------------------------------------------------------------------------
// Benchmark class
// ---------------------------------------------------------------------------

export interface BenchmarkOptions {
  metadata?: Record<string, unknown>;
  recordIo?: boolean;
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

  constructor(name: string, options?: BenchmarkOptions) {
    this._name = name;
    this._metadata = safeMetadata(options?.metadata, `benchmark:${name}`);
    this._recordIo = options?.recordIo ?? false;
    this._runId = makeRunId();
    this._start = performance.now();
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
    /** `{ name: value }`, or `EvalScore[]` to declare verdicts (assessment / threshold) and bounds. */
    scores?: Record<string, number> | EvalScore[];
    metadata?: Record<string, unknown>;
    /** Error message. The case event status becomes `error` (`status` stays `fail`). */
    error?: string;
    /** `error.type` for an errored case (exception class name or similar). */
    errorType?: string;
    /**
     * Explicit case status. Default `error` when `error` or `errorType` is given,
     * else `fail` when a score has a `fail` verdict, else `pass`.
     */
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
    const evalScores: EvalScore[] = Array.isArray(options.scores)
      ? options.scores
      : Object.entries(options.scores ?? {}).map(([name, value]) => ({ name, value }));
    const assessments = assessmentsOf(evalScores);
    const failed = hasFailVerdict(assessments);
    const hasError = options.error !== undefined;
    const resultStatus: TestCaseStatus =
      options.status ?? (hasError || options.errorType ? 'error' : failed ? 'fail' : 'pass');
    const legacyStatus = options.status ?? (hasError || failed ? 'fail' : 'pass');
    const errorType = options.errorType;
    const caseMeta = toAttributes(safeMetadata(options.metadata, `case:${caseId}`));
    const evaluated = spanContextFrom(options.traceId, options.spanId);

    if (evalScores.length > 0) {
      emitCaseScores(evalScores, identity, { traceId: options.traceId, spanId: options.spanId });
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
      parent: evaluated,
    });

    this._cases.push({
      caseId,
      caseName: options.caseName,
      input: options.input,
      output: options.output,
      expected: options.expected,
      scores: scoreValues(evalScores),
      error: options.error,
      status: legacyStatus,
      resultStatus,
      errorType,
      durationMs: options.durationMs,
      traceId: evaluated?.traceId,
      spanId: evaluated?.spanId,
      assessments: Object.keys(assessments).length > 0 ? assessments : undefined,
    });
  }

  close(): BenchmarkSummary {
    if (this._closed) {
      throw new Error('Benchmark is already closed');
    }
    this._closed = true;

    const summary = computeSummary(this._name, this._runId, this._cases, elapsedMs(this._start));
    emitRunEvent(summary, toAttributes(this._metadata));
    console.log(formatSummary(summary));
    return summary;
  }
}

// ---------------------------------------------------------------------------
// evaluate() function
// ---------------------------------------------------------------------------

export interface EvaluateOptions {
  name: string;
  task: (input: unknown) => unknown;
  data: Array<{ input: unknown; expected?: unknown; caseId?: string; caseName?: string }>;
  /** Scorer functions, optionally wrapped with `defineScorer()` to declare name and rule. */
  scores: Array<ScorerFn | Scorer>;
  metadata?: Record<string, unknown>;
  recordIo?: boolean;
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
 *
 * Case status (`test.case.result.status`): `error` if the task or a scorer
 * threw; else `fail` if any score has a `fail` verdict (explicit `assessment`
 * / `passed`, or `threshold` + `direction` from the score or its
 * `defineScorer()` declaration); else `pass`. Scores without a declared rule
 * never fail a case. A scorer that throws emits a grade with `error.type`,
 * named after its declared `name` (else the function name).
 */
export function evaluate(options: EvaluateOptions): BenchmarkResult {
  const filteredMetadata = toAttributes(safeMetadata(options.metadata, `evaluate:${options.name}`));
  const recordIo = options.recordIo ?? false;
  const runId = makeRunId();
  const runStart = performance.now();
  const cases: TestCaseResult[] = [];

  ensureGlobalTestCaseProcessor();

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
    const scoreGroups: Array<{ scores: EvalScore[]; spec?: ScorerSpec; errorType?: string }> = [];
    const scorerErrors: string[] = [];

    const active: ActiveTestCase = { attributes: identityAttributes(identity), seen: new Set() };

    // Run task
    try {
      output = runInTestCase(active, () => otelContext.with(ROOT_CONTEXT, () => options.task(item.input)));
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
        const spec = specOf(scorer);
        // Evaluation name of number/boolean results and of the error grade.
        const evalName = spec?.name || scorer.name || 'score';
        try {
          const result = scorer(item.input, output, expected);
          let produced: EvalScore[];
          if (typeof result === 'boolean') {
            produced = [{ name: evalName, value: result ? 1 : 0, passed: result }];
          } else if (typeof result === 'number') {
            produced = [{ name: evalName, value: result }];
          } else if (Array.isArray(result)) {
            produced = result;
          } else {
            produced = [result];
          }
          produced = produced.map(s => applySpec(s, spec));
          for (const es of produced) {
            if (es.value !== undefined) caseScores[es.name] = es.value;
          }
          scoreGroups.push({ scores: produced, spec });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          scorerErrors.push(msg);
          const scorerErrorType = errorTypeOf(e);
          errorType ??= scorerErrorType;
          // Error grade (error.type, no value) under the evaluation name the
          // scorer would have produced, so it is not a separate evaluation.
          scoreGroups.push({
            scores: [applySpec({ name: evalName, explanation: msg }, spec)],
            spec,
            errorType: scorerErrorType,
          });
        }
      }
    }

    const assessments = assessmentsOf(
      scoreGroups.filter(g => !g.errorType).flatMap(g => g.scores),
    );
    const failed = hasFailVerdict(assessments);
    const resultStatus: TestCaseStatus = errorType ? 'error' : failed ? 'fail' : 'pass';
    const legacyStatus = resultStatus === 'pass' ? 'pass' : 'fail';
    const root = active.root;
    for (const group of scoreGroups) {
      emitCaseScores(group.scores, identity, { traceId: root?.traceId, spanId: root?.spanId }, {
        evaluator: group.spec?.evaluator,
        evaluatorType: group.spec?.evaluatorType,
        errorType: group.errorType,
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
      parent: root,
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
      assessments: Object.keys(assessments).length > 0 ? assessments : undefined,
    });
  }

  const summary = computeSummary(options.name, runId, cases, elapsedMs(runStart));
  emitRunEvent(summary, filteredMetadata);
  console.log(formatSummary(summary));

  return { summary, cases };
}
