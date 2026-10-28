// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

export { register, DEFAULT_ENDPOINT, DEFAULT_LOGS_ENDPOINT } from './register.js';
export type { RegisterOptions } from './register.js';
export { observe, withObserve, Op } from './observe.js';
export type { ObserveOptions } from './observe.js';
export { enrich, markAgentRoot, AGENT_ROOT_ATTRIBUTE } from './enrich.js';
export type { EnrichOptions } from './enrich.js';
export { score, resolveAssessment, EVALUATION_RESULT_EVENT } from './score.js';
export type {
  ScoreOptions,
  Assessment,
  EvaluationLevel,
  EvaluatorType,
  ScoreDirection,
} from './score.js';
export {
  Benchmark,
  evaluate,
  defineScorer,
  TEST_CASE_RESULT_EVENT,
  TEST_SUITE_RUN_RESULT_EVENT,
} from './benchmark.js';
export { TestCaseSpanProcessor } from './testcase.js';
export type {
  EvalScore,
  Scorer,
  ScorerFn,
  ScorerSpec,
  EvaluateOptions,
  BenchmarkOptions,
  TestCaseStatus,
  BenchmarkResult,
  BenchmarkSummary,
  ScoreSummary,
  TestCaseResult,
} from './benchmark.js';
export { OpenSearchTraceRetriever } from './retrieval.js';
export type {
  Message,
  SpanRecord,
  TraceRecord,
  SessionRecord,
} from './retrieval.js';
export { AWSSigV4OTLPExporter, AWSSigV4OTLPLogExporter } from './exporters.js';
export { SDK_SCOPE_NAME, SDK_VERSION } from './version.js';
