// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Example 06: Retrieval and Evaluation
 *
 * Demonstrates using the OpenSearchTraceRetriever to fetch traces
 * from OpenSearch and the evaluate() function for benchmarking.
 *
 * Prerequisites:
 * - npm install @opensearch-project/opensearch
 * - A running OpenSearch cluster with trace data
 */

import { evaluate, register } from '../src/index.js';
// import { score } from '../src/index.js'; // used in the commented retrieval section
import type { EvalScore } from '../src/index.js';

const provider = await register({
  serviceName: 'eval-example',
  batch: false,
  autoInstrument: false,
});

// 1. Using evaluate() with a simple task and scorer
function exactMatch(input: unknown, output: unknown, expected: unknown): EvalScore {
  return {
    name: 'exact_match',
    value: output === expected ? 1.0 : 0.0,
  };
}

function containsKeyword(input: unknown, output: unknown, _expected: unknown): EvalScore {
  const outputStr = String(output).toLowerCase();
  const inputStr = String(input).toLowerCase();
  return {
    name: 'contains_keyword',
    value: outputStr.includes(inputStr) ? 1.0 : 0.0,
  };
}

const result = evaluate({
  name: 'qa-evaluation',
  task: (input) => {
    // Simple echo task for demonstration
    const query = (input as { query: string }).query;
    return `The answer to "${query}" is 42.`;
  },
  data: [
    { input: { query: 'meaning of life' }, expected: 'The answer to "meaning of life" is 42.' },
    { input: { query: 'universe' }, expected: 'The answer to "universe" is 42.' },
    { input: { query: 'everything' }, expected: 'The answer to "everything" is 42.' },
  ],
  scores: [exactMatch, containsKeyword],
  recordIo: true,
});

console.log('\nEvaluation Results:');
console.log(`Total cases: ${result.summary.totalCases}`);
console.log(`Errors: ${result.summary.errorCount}`);
for (const [name, scoreSummary] of Object.entries(result.summary.scores)) {
  console.log(`  ${name}: avg=${scoreSummary.avg.toFixed(2)}, min=${scoreSummary.min.toFixed(2)}, max=${scoreSummary.max.toFixed(2)}`);
}

// 2. OpenSearchTraceRetriever usage (requires OpenSearch connection)
// Uncomment the following if you have an OpenSearch cluster:
//
// import { OpenSearchTraceRetriever } from '../src/index.js';
//
// const retriever = new OpenSearchTraceRetriever({
//   host: 'https://localhost:9200',
//   auth: { username: 'admin', password: 'admin' },
//   verifyCerts: false,
// });
//
// // Get traces by session/conversation ID
// const session = await retriever.getTraces('session-123');
// console.log(`Found ${session.traces.length} traces`);
// for (const trace of session.traces) {
//   console.log(`  Trace ${trace.traceId}: ${trace.spans.length} spans`);
// }
//
// // List recent root spans
// const rootSpans = await retriever.listRootSpans({
//   since: new Date(Date.now() - 60 * 60 * 1000), // last hour
//   maxResults: 10,
// });
// console.log(`Found ${rootSpans.length} root spans`);
//
// // Write scores back: one gen_ai.evaluation.result event per evaluated span,
// // parented to that span (exported over OTLP logs to otel-v1-genai-evaluation)
// for (const trace of session.traces) {
//   for (const span of trace.spans.filter((s) => s.operationName === 'invoke_agent')) {
//     score({
//       name: 'helpfulness',
//       value: 0.8,
//       traceId: span.traceId,
//       spanId: span.spanId,
//       agentName: span.agentName,
//       evaluator: 'helpfulness_judge',
//       evaluatorType: 'llm_judge',
//     });
//   }
// }

// Flush spans and evaluation events
await provider.shutdown();
