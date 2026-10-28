// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Example 02: Scoring
 *
 * Demonstrates score(), which records each evaluation result as an OTel log
 * event `gen_ai.evaluation.result` parented to the evaluated span. Events are
 * exported over OTLP logs (/v1/logs) by the LoggerProvider that register()
 * sets up, and Data Prepper routes them to the `otel-v1-genai-evaluation` index.
 */

import { context } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { score, withObserve, Op, register } from '../src/index.js';

// Propagate the active span across callbacks so inline scores find it.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

const provider = await register({
  serviceName: 'scoring-example',
  batch: false,
  autoInstrument: false,
});

// 1. Inline: score the active span while it runs
const ids = withObserve('answer', { op: Op.CHAT }, (span) => {
  score({
    name: 'relevance',
    value: 0.92,
    label: 'relevant',
    explanation: 'The response addresses the question.',
    evaluator: 'relevance_judge',
    evaluatorVersion: '1.0.0',
    evaluatorType: 'llm_judge',
    direction: 'maximize',
    scoreMin: 0,
    scoreMax: 1,
  });
  return span.spanContext();
});

// 2. Offline: score a stored span by trace id + span id
score({
  name: 'faithfulness',
  value: 0.4,
  label: 'fail',
  traceId: ids.traceId,
  spanId: ids.spanId,
  responseId: 'resp-123',
});

// 3. Trace-level: only the trace id is known. The event has no span context and
//    carries opensearch.evaluation.trace_id + opensearch.evaluation.level=trace.
score({ name: 'overall-satisfaction', value: 0.9, traceId: ids.traceId });

// 4. Session-scoped human feedback with custom attributes
score({
  name: 'user_feedback',
  value: 1,
  label: 'thumbs_up',
  traceId: ids.traceId,
  spanId: ids.spanId,
  level: 'session',
  conversationId: 'conversation-42',
  evaluatorType: 'human',
  attributes: { 'feedback.channel': 'web' },
});

// 5. A failed evaluation
score({ name: 'toxicity', traceId: ids.traceId, spanId: ids.spanId, errorType: 'timeout' });

// Flush traces and evaluation events
await provider.shutdown();
console.log('Scores have been recorded as gen_ai.evaluation.result events!');
