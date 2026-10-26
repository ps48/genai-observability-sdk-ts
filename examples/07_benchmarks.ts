// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * Example 07: Benchmarks
 *
 * Demonstrates using the Benchmark class for manual test case logging
 * and the evaluate() function for automated benchmarking with scorers.
 *
 * Each run is a `test_suite_run <suite>` span with one `test_case <case>`
 * span per case. Each score is a `gen_ai.evaluation.result` log event that
 * carries test.suite.name, test.suite.run.id, test.case.id and test.case.name.
 */

import { Benchmark, evaluate, register } from '../src/index.js';
import type { EvalScore } from '../src/index.js';

const provider = await register({
  serviceName: 'benchmark-example',
  batch: false,
  autoInstrument: false,
});

// 1. Manual benchmarking with Benchmark class
const bench = new Benchmark('translation-quality', {
  metadata: { 'eval.language_pair': 'en-fr' },
  recordIo: true,
});

// Log individual test cases
bench.log({
  input: 'Hello, world!',
  output: 'Bonjour, le monde!',
  expected: 'Bonjour, le monde!',
  scores: { bleu: 1.0, semantic_similarity: 0.95 },
  caseName: 'simple-greeting',
});

bench.log({
  input: 'The cat sat on the mat.',
  output: 'Le chat est assis sur le tapis.',
  expected: 'Le chat s\'est assis sur le tapis.',
  scores: { bleu: 0.7, semantic_similarity: 0.85 },
  caseName: 'simple-sentence',
});

bench.log({
  input: 'Complex sentence with idioms.',
  output: 'Error: translation failed',
  error: 'Translation service timeout',
  caseName: 'error-case',
});

// Close the benchmark to get the summary
const summary = bench.close();
console.log(`\nBenchmark: ${summary.benchmarkName}`);
console.log(`Run ID: ${summary.runId}`);
console.log(`Cases: ${summary.totalCases}, Errors: ${summary.errorCount}`);

// 2. Linking benchmark cases to production traces
const bench2 = new Benchmark('production-eval');

bench2.log({
  input: 'What is OpenSearch?',
  output: 'OpenSearch is a search and analytics engine.',
  scores: { relevance: 0.9 },
  // Score the production span that generated this output: the score event is
  // parented to that span and the test_case span links to it.
  traceId: 'abcdef1234567890abcdef1234567890',
  spanId: 'abcdef1234567890',
});

bench2.close();

// 3. Automated evaluation with evaluate()
function lengthScore(_input: unknown, output: unknown, _expected: unknown): EvalScore {
  const len = String(output).length;
  return {
    name: 'length_score',
    value: Math.min(len / 100, 1.0),
    explanation: `Output length: ${len} chars`,
  };
}

function matchScore(_input: unknown, output: unknown, expected: unknown): number {
  return output === expected ? 1.0 : 0.0;
}

const evalResult = evaluate({
  name: 'qa-benchmark',
  task: (input) => {
    const q = (input as { question: string }).question;
    // Simulated LLM response
    return `The answer to "${q}" is based on available knowledge.`;
  },
  data: [
    { input: { question: 'What is AI?' }, expected: 'AI is artificial intelligence.' },
    { input: { question: 'What is ML?' }, expected: 'ML is machine learning.' },
    { input: { question: 'What is NLP?' }, expected: 'NLP is natural language processing.' },
  ],
  scores: [lengthScore, matchScore],
  metadata: { 'eval.model': 'gpt-4', 'eval.version': '1.0' },
});

console.log(`\nAutomated Evaluation: ${evalResult.summary.benchmarkName}`);
console.log(`Total cases: ${evalResult.summary.totalCases}`);
for (const c of evalResult.cases) {
  console.log(`  Case ${c.caseId.slice(0, 8)}: ${c.status} - scores: ${JSON.stringify(c.scores)}`);
}

// Flush spans and evaluation events
await provider.shutdown();
