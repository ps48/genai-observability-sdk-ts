// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import {
  trace,
  context as otelContext,
  ROOT_CONTEXT,
  TraceFlags,
  type Context,
  type Attributes,
} from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { normalizeSpanId, normalizeTraceId } from './internal.js';
import { getEventLogger } from './logs.js';

/** OTel event name of an evaluation result (semantic-conventions-genai). */
export const EVALUATION_RESULT_EVENT = "gen_ai.evaluation.result";

const EXPLANATION_LIMIT = 500;

export type EvaluationLevel = "span" | "trace" | "session" | "tool_call";
export type EvaluatorType = "llm_judge" | "code" | "human" | "external";
export type ScoreDirection = "maximize" | "minimize";

export interface ScoreOptions {
  /** `gen_ai.evaluation.name` (required), for example `"relevance"`. */
  name: string;
  /**
   * `gen_ai.evaluation.score.value` (a double in OTel semconv). The SDK's OTLP
   * log exporters send whole numbers as `doubleValue` too; see README.
   */
  value?: number;
  /** Trace of the evaluated span. Without `spanId` the score is trace-level. */
  traceId?: string;
  /** Evaluated span. Requires `traceId`. */
  spanId?: string;
  /** `gen_ai.evaluation.score.label`, low cardinality (for example `"pass"`). */
  label?: string;
  /** `gen_ai.evaluation.explanation` (truncated to 500 chars). */
  explanation?: string;
  /** `gen_ai.response.id` of the evaluated response, only if known. */
  responseId?: string;
  /** `opensearch.evaluation.level`. Defaults to `"trace"` for trace-level scores. */
  level?: EvaluationLevel;
  /**
   * Evaluator identity: instrumentation scope name of the event and
   * `opensearch.evaluation.evaluator.name`. Without it the scope is the SDK
   * scope (`opensearch-genai-observability-sdk-ts` + SDK version).
   */
  evaluator?: string;
  /** Instrumentation scope version (with `evaluator`) and `opensearch.evaluation.evaluator.version`. */
  evaluatorVersion?: string;
  /** `opensearch.evaluation.evaluator.type`. */
  evaluatorType?: EvaluatorType;
  /** `opensearch.evaluation.score.direction`. */
  direction?: ScoreDirection;
  /** `opensearch.evaluation.score.min`. */
  scoreMin?: number;
  /** `opensearch.evaluation.score.max`. */
  scoreMax?: number;
  /** `gen_ai.conversation.id` (session-scoped evaluations). */
  conversationId?: string;
  /** `gen_ai.agent.name` of the evaluated agent. */
  agentName?: string;
  /** `error.type` when the evaluator failed. */
  errorType?: string;
  /** `opensearch.evaluation.judge.trace_id`: the judge's own trace. */
  judgeTraceId?: string;
  /** Extra attributes (string, number, boolean). Explicit options take precedence. */
  attributes?: Record<string, unknown>;
}

interface Target {
  /** Context to parent the result to. */
  context: Context;
  /** Trace id for trace-level scores without a span id. */
  traceOnlyId?: string;
}

function resolveTarget(traceId?: string, spanId?: string): Target {
  if (spanId && !traceId) {
    throw new Error('score(): spanId requires traceId');
  }
  if (!traceId) {
    // Inline evaluation: the evaluated span is the active span (if any).
    return { context: otelContext.active() };
  }

  const cleanTraceId = normalizeTraceId(traceId);
  if (!cleanTraceId) {
    console.warn(`score(): ignoring invalid traceId "${traceId}"`);
    return { context: ROOT_CONTEXT };
  }
  if (!spanId) {
    // Trace-level score: no span context. Never derive a span id from the trace id.
    return { context: ROOT_CONTEXT, traceOnlyId: cleanTraceId };
  }

  const cleanSpanId = normalizeSpanId(spanId);
  if (!cleanSpanId) {
    console.warn(`score(): ignoring invalid spanId "${spanId}", scoring at trace level`);
    return { context: ROOT_CONTEXT, traceOnlyId: cleanTraceId };
  }

  return {
    context: trace.setSpanContext(otelContext.active(), {
      traceId: cleanTraceId,
      spanId: cleanSpanId,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    }),
  };
}

function buildAttributes(options: ScoreOptions, target: Target): Attributes {
  const attrs: Attributes = {};
  if (options.attributes) {
    for (const [k, v] of Object.entries(options.attributes)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        attrs[k] = v;
      }
    }
  }

  attrs["gen_ai.evaluation.name"] = options.name;
  if (options.value !== undefined) attrs["gen_ai.evaluation.score.value"] = options.value;
  if (options.label) attrs["gen_ai.evaluation.score.label"] = options.label;
  if (options.explanation) {
    attrs["gen_ai.evaluation.explanation"] = options.explanation.slice(0, EXPLANATION_LIMIT);
  }
  if (options.responseId) attrs["gen_ai.response.id"] = options.responseId;
  if (options.errorType) attrs["error.type"] = options.errorType;
  if (options.conversationId) attrs["gen_ai.conversation.id"] = options.conversationId;
  if (options.agentName) attrs["gen_ai.agent.name"] = options.agentName;

  const level = options.level ?? (target.traceOnlyId ? "trace" : undefined);
  if (level) attrs["opensearch.evaluation.level"] = level;
  if (target.traceOnlyId) attrs["opensearch.evaluation.trace_id"] = target.traceOnlyId;
  if (options.evaluator) attrs["opensearch.evaluation.evaluator.name"] = options.evaluator;
  if (options.evaluatorVersion) {
    attrs["opensearch.evaluation.evaluator.version"] = options.evaluatorVersion;
  }
  if (options.evaluatorType) attrs["opensearch.evaluation.evaluator.type"] = options.evaluatorType;
  if (options.direction) attrs["opensearch.evaluation.score.direction"] = options.direction;
  if (options.scoreMin !== undefined) attrs["opensearch.evaluation.score.min"] = options.scoreMin;
  if (options.scoreMax !== undefined) attrs["opensearch.evaluation.score.max"] = options.scoreMax;
  if (options.judgeTraceId) attrs["opensearch.evaluation.judge.trace_id"] = options.judgeTraceId;
  return attrs;
}

function emitEvent(options: ScoreOptions, target: Target, attributes: Attributes): void {
  // Evaluator identity goes in the instrumentation scope (standard mechanism).
  // The scope is always set: the evaluator, else the SDK scope and version.
  // Scope attributes opensearch.genai.sdk.name / .version are always set.
  const logger = options.evaluator
    ? getEventLogger(options.evaluator, options.evaluatorVersion)
    : getEventLogger();
  logger.emit({
    eventName: EVALUATION_RESULT_EVENT,
    timestamp: Date.now(),
    severityNumber: SeverityNumber.INFO,
    attributes,
    context: target.context,
  });
}

/**
 * Record an evaluation result as an OTel `gen_ai.evaluation.result` log event,
 * parented to the evaluated span.
 *
 * - Inline: call while the evaluated span is active.
 * - Offline: pass `traceId` + `spanId` of the evaluated span.
 * - Trace-level: pass only `traceId`. The event has no span context and carries
 *   `opensearch.evaluation.trace_id` and `opensearch.evaluation.level=trace`.
 */
export function score(options: ScoreOptions): void {
  const target = resolveTarget(options.traceId, options.spanId);
  emitEvent(options, target, buildAttributes(options, target));
}
