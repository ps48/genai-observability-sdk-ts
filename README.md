# OpenSearch GenAI Observability SDK for TypeScript

[![CI](https://github.com/opensearch-project/genai-observability-sdk-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/opensearch-project/genai-observability-sdk-ts/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/opensearch-genai-observability-sdk-ts.svg)](https://www.npmjs.com/package/opensearch-genai-observability-sdk-ts)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

OTel-native tracing and scoring for LLM applications. Instrument your AI workflows with standard OpenTelemetry spans and submit evaluation scores — all routed to OpenSearch through a single OTLP pipeline.

## Features

- **One-line setup** — `register()` configures the full OTel pipeline (TracerProvider, exporter, auto-instrumentation)
- **`observe()`** — function wrapper that creates OTel spans with [GenAI semantic convention](https://opentelemetry.io/docs/specs/semconv/gen-ai/) attributes
- **`withObserve()`** — block-level tracing (TypeScript equivalent of Python's context manager)
- **`enrich()`** — add model, token usage, and other GenAI attributes to the active span from anywhere in your code
- **`markAgentRoot()`** — mark the agent's span as the trace's agent root in OpenSearch Agent Traces
- **Auto-instrumentation** — automatically discovers and activates installed instrumentor packages (OpenAI, etc.)
- **Scoring**: `score()` emits each evaluation result as an OTel `gen_ai.evaluation.result` log event, parented to the evaluated span
- **Benchmarks**: `evaluate()` runs your agent against a dataset with scorers; `Benchmark` uploads results from any eval framework. Each case is its own agent trace plus `opensearch.test_case.result` and `opensearch.test_suite_run.result` log events
- **AWS SigV4** — built-in SigV4 signing for AWS-hosted OpenSearch and Data Prepper endpoints
- **Streaming** — full support for sync/async functions, generators, and async generators
- **Zero lock-in** — remove a wrapper and your code still works; everything is standard OTel

## Requirements

- **Node.js**: ^18.19.0 or >= 20.6.0 (required by `@opentelemetry/sdk-logs`)
- **OpenTelemetry API**: ^1.9.0

## Installation

```bash
npm install opensearch-genai-observability-sdk-ts
# or
pnpm add opensearch-genai-observability-sdk-ts
# or
yarn add opensearch-genai-observability-sdk-ts
```

Optional peer dependencies for specific features:

```bash
# OpenSearch trace retrieval
npm install @opensearch-project/opensearch

# AWS SigV4 authentication
npm install @aws-sdk/credential-providers aws4
```

## Quick Start

```typescript
import { register, observe, Op, enrich, score } from "opensearch-genai-observability-sdk-ts";

// 1. Initialize tracing (one line)
await register({ endpoint: "http://localhost:21890/opentelemetry/v1/traces" });

// 2. Trace your functions
const search = observe(
  { name: "web_search", op: Op.EXECUTE_TOOL },
  (query: string) => {
    return [{ title: `Result for: ${query}` }];
  },
);

const research = observe(
  { name: "research_agent", op: Op.INVOKE_AGENT },
  (query: string) => {
    const results = search(query);
    enrich({ model: "gpt-4.1", provider: "openai", inputTokens: 150, outputTokens: 50 });
    return `Summary of: ${JSON.stringify(results)}`;
  },
);

// 3. Use it
const result = research("What is OpenSearch?");

// 4. Submit scores (after workflow completes): pass the evaluated span's ids
score({ name: "relevance", value: 0.95, traceId: "...", spanId: "..." });
```

This produces the following span tree:

```
invoke_agent research_agent
└── execute_tool web_search
```

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                   Your Application                    │
│                                                       │
│  observe(opts, fn)   withObserve()   enrich()         │
│  score()   evaluate()   Benchmark                     │
│                     │                                 │
│      opensearch-genai-observability-sdk-ts            │
├──────────────────────────────────────────────────────┤
│  register()                                           │
│  ┌──────────────────────────────────────────────┐    │
│  │  TracerProvider                               │    │
│  │  ├── Resource (service.name)                  │    │
│  │  ├── TestCaseSpanProcessor (evaluate())       │    │
│  │  ├── BatchSpanProcessor                       │    │
│  │  │   └── OTLPSpanExporter (HTTP or gRPC)      │    │
│  │  │       └── SigV4 signing (AWS endpoints)    │    │
│  │  └── Auto-instrumentation                     │    │
│  │  LoggerProvider (evaluation and test events)  │    │
│  │  └── BatchLogRecordProcessor                  │    │
│  │      └── OTLPLogExporter (HTTP, /v1/logs)     │    │
│  └──────────────────────────────────────────────┘    │
└───────────────────────┬──────────────────────────────┘
                        │ OTLP (HTTP/gRPC)
                        ▼
               ┌─────────────────┐
               │  Data Prepper /  │
               │  OTel Collector  │
               └────────┬────────┘
                        │
                        ▼
          ┌───────────────────────────────┐
          │   OpenSearch                  │
          │  ├── otel-v1-apm-span-*       │
          │  └── otel-v1-genai-evaluation │
          └───────────────────────────────┘
```

## API Reference

### `register()`

Configures the OTel tracing pipeline and the logs pipeline that carries evaluation events from `score()`. Call once at startup.

```typescript
await register({
  endpoint: "http://my-collector:4318/v1/traces",  // or use env vars
  serviceName: "my-app",
  batch: true,            // BatchSpanProcessor (true) or Simple (false)
  autoInstrument: true,   // discover installed instrumentor packages
});
```

**Endpoint resolution (priority order):**

1. `endpoint` parameter — full URL, used as-is
2. `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` env var — full URL, used as-is
3. `OTEL_EXPORTER_OTLP_ENDPOINT` env var — base URL, `/v1/traces` appended automatically
4. `http://localhost:21890/opentelemetry/v1/traces` — Data Prepper default

**Protocol resolution (priority order):**

1. `protocol` parameter — `"http"` or `"grpc"`
2. `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` env var
3. `OTEL_EXPORTER_OTLP_PROTOCOL` env var
4. Inferred from URL scheme (`grpc://` or `grpcs://` → gRPC, otherwise HTTP)

**Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `endpoint` | `string` | See resolution above | OTLP traces endpoint URL |
| `protocol` | `"http" \| "grpc"` | Auto-detected | Export protocol |
| `serviceName` | `string` | `"unknown_service"` | `service.name` resource attribute |
| `serviceVersion` | `string` | — | `service.version` resource attribute |
| `batch` | `boolean` | `true` | Use BatchSpanProcessor when true |
| `autoInstrument` | `boolean` | `true` | Discover and activate instrumentor packages |
| `exporter` | `SpanExporter` | — | Custom exporter (overrides endpoint/protocol) |
| `headers` | `Record<string, string>` | none | Headers for OTLP exporter (traces and logs) |
| `logs` | `boolean` | `true` | Set up a LoggerProvider for evaluation events |
| `logsEndpoint` | `string` | See [Endpoints](#endpoints-traces-and-evaluation-logs) | OTLP/HTTP logs endpoint URL for evaluation events |
| `logExporter` | `LogRecordExporter` | none | Custom log exporter (overrides `logsEndpoint`) |

**Logs pipeline.** `register()` also creates a `LoggerProvider` with a batch processor (simple when `batch: false`) and an OTLP/HTTP log exporter for evaluation events. `provider.forceFlush()` and `provider.shutdown()` flush and shut down both pipelines. If a global `LoggerProvider` is already registered (for example by `NodeSDK`), `register()` leaves it in place and `score()` emits through it. See [Endpoints: traces and evaluation logs](#endpoints-traces-and-evaluation-logs).

#### Endpoints: traces and evaluation logs

Traces and evaluation events are separate OTLP signals with separate endpoints: spans go to `/v1/traces`, evaluation events (`gen_ai.evaluation.result`, `opensearch.test_case.result`, `opensearch.test_suite_run.result`) go to `/v1/logs`. If the logs endpoint is wrong, traces still arrive but grades and runs are silently missing, so `register()` never guesses.

**Logs endpoint resolution (priority order):**

1. `logsEndpoint` parameter: full URL, used as-is
2. `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` env var: full URL, used as-is
3. `endpoint` parameter, only if it ends in `/v1/traces` (swapped for `/v1/logs`)
4. `OTEL_EXPORTER_OTLP_ENDPOINT` env var: base URL, `/v1/logs` appended (OTel spec)
5. `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` env var, only if it ends in `/v1/traces`
6. Nothing configured: `http://localhost:21890/opentelemetry/v1/logs` (Data Prepper default)

When the traces endpoint does not end in `/v1/traces`, when traces use gRPC (the logs exporter is OTLP/HTTP), or when you pass a custom `exporter` without `logsEndpoint`, `register()` prints a warning that evaluation logs are NOT exported and skips the logs pipeline. Pass `logsEndpoint` (or `logExporter`) or set `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` to fix it.

**Local OTel Collector or Data Prepper.** One base URL serves both signals:

```typescript
// traces -> http://localhost:4318/v1/traces, logs -> http://localhost:4318/v1/logs
await register({ endpoint: "http://localhost:4318/v1/traces", serviceName: "my-app" });
```

or with env vars only:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

**AWS OSIS: two pipelines.** An OpenSearch Ingestion traces pipeline does not accept logs. Create a separate logs pipeline (OTel logs source, routed to `otel-v1-genai-evaluation`) and pass its URL as `logsEndpoint`. When `exporter` is an `AWSSigV4OTLPExporter`, `register()` creates an `AWSSigV4OTLPLogExporter` with the same service and region for `logsEndpoint`, else `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, else the traces URL only if it ends in `/v1/traces`. Otherwise it warns and skips logs:

```typescript
import { register, AWSSigV4OTLPExporter } from "opensearch-genai-observability-sdk-ts";

await register({
  exporter: new AWSSigV4OTLPExporter({
    endpoint: "https://traces-pipeline.us-east-1.osis.amazonaws.com/v1/traces",
    service: "osis",
  }),
  logsEndpoint: "https://logs-pipeline.us-east-1.osis.amazonaws.com/v1/logs",
});
```

**Env vars:**

| Variable | Used for |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base URL for both signals (`/v1/traces` and `/v1/logs` appended) |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Full traces URL. Logs are derived from it only if it ends in `/v1/traces` |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Full logs URL. Overrides everything except `logsEndpoint` |

### `observe()`

Function wrapper that creates OTel spans with GenAI semantic convention attributes. Supports three calling styles:

```typescript
// 1. Bare — uses function name, no op
const fn = observe(function myFunc(x: number) { return x * 2; });

// 2. With options and function
const agent = observe(
  { name: "planner", op: Op.INVOKE_AGENT },
  (query: string) => {
    enrich({ model: "gpt-4.1" });
    return callLlm(query);
  },
);

// 3. Options only — returns a wrapper (decorator factory pattern)
const withTracing = observe({ op: Op.INVOKE_AGENT });
const tracedAgent = withTracing(myAgentFunction);
```

**Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | Function name | Span name |
| `op` | `string` | — | `gen_ai.operation.name` value. Use `Op` constants or any custom string |
| `kind` | `SpanKind` | `INTERNAL` | OTel span kind |
| `nameFrom` | `string` | — | Resolve span name dynamically from a function parameter |

**Span naming:** When `op` is a well-known value, the span name is `"{op} {name}"` (e.g. `"invoke_agent planner"`).

**Attributes set automatically:**

| Attribute | When set |
|---|---|
| `gen_ai.operation.name` | When `op` is provided |
| `gen_ai.agent.name` | All ops except `execute_tool` |
| `gen_ai.tool.name` | When `op=Op.EXECUTE_TOOL` |
| `gen_ai.tool.type` | When `op=Op.EXECUTE_TOOL` (set to `"function"`) |
| `gen_ai.input.messages` / `gen_ai.output.messages` | All ops except `execute_tool` |
| `gen_ai.tool.call.arguments` / `gen_ai.tool.call.result` | When `op=Op.EXECUTE_TOOL` |

**Dynamic naming with `nameFrom`:**

```typescript
const dispatch = observe(
  { op: Op.EXECUTE_TOOL, nameFrom: "toolName" },
  (toolName: string, args: Record<string, unknown>) => { /* ... */ },
);

dispatch("web_search", { q: "hello" });
// Creates span: "execute_tool web_search"
```

**Supported function types:** sync, async, generators, async generators. Errors are captured as span status + exception events and re-thrown.

### `withObserve()`

Block-level tracing — the TypeScript equivalent of Python's `with observe(...)` context manager. Gives direct access to the span.

```typescript
const result = withObserve("thinking", { op: Op.CHAT }, (span) => {
  span.setAttribute("custom.step", "reasoning");
  enrich({ model: "gpt-4.1", inputTokens: 1500 });
  return callLlm(prompt);
});

// Async version
const data = await withObserve("fetch-data", async (span) => {
  return await fetchFromApi();
});
```

### `Op`

Constants for well-known `gen_ai.operation.name` values. Any custom string is also accepted.

| Constant | Value | Use for |
|---|---|---|
| `Op.CHAT` | `"chat"` | LLM chat completions |
| `Op.INVOKE_AGENT` | `"invoke_agent"` | Agent invocations |
| `Op.CREATE_AGENT` | `"create_agent"` | Agent creation/setup |
| `Op.EXECUTE_TOOL` | `"execute_tool"` | Tool/function calls |
| `Op.RETRIEVAL` | `"retrieval"` | RAG retrieval steps |
| `Op.EMBEDDINGS` | `"embeddings"` | Embedding generation |
| `Op.GENERATE_CONTENT` | `"generate_content"` | Content generation |
| `Op.TEXT_COMPLETION` | `"text_completion"` | Text completions |

### `enrich()`

Add GenAI semantic convention attributes to the currently active span. Call from inside an `observe()`-wrapped function or a `withObserve()` block.

```typescript
const chat = observe({ name: "chat", op: Op.CHAT }, (prompt: string) => {
  const result = callLlm(prompt);
  enrich({
    model: "gpt-4.1",
    provider: "openai",
    inputTokens: 150,
    outputTokens: 50,
    temperature: 0.7,
  });
  return result;
});
```

**Parameters:**

| Parameter | Attribute | Description |
|---|---|---|
| `model` | `gen_ai.request.model` | Model name |
| `provider` | `gen_ai.provider.name` | Provider name (openai, anthropic, etc.) |
| `inputTokens` | `gen_ai.usage.input_tokens` | Input token count |
| `outputTokens` | `gen_ai.usage.output_tokens` | Output token count |
| `totalTokens` | `gen_ai.usage.total_tokens` | Total token count |
| `responseId` | `gen_ai.response.id` | Response/completion ID |
| `finishReason` | `gen_ai.response.finish_reasons` | Finish reason(s) |
| `temperature` | `gen_ai.request.temperature` | Temperature setting |
| `maxTokens` | `gen_ai.request.max_tokens` | Max tokens setting |
| `sessionId` | `gen_ai.conversation.id` | Session/conversation ID |
| `agentId` | `gen_ai.agent.id` | Agent ID |
| `agentDescription` | `gen_ai.agent.description` | Agent description |
| `systemInstructions` | `gen_ai.system_instructions` | System prompt |
| `[extra: string]` | As provided | Any additional key-value attributes |

### `markAgentRoot()`

Mark the active span as its trace's agent root. OpenSearch Agent Traces lists a trace by the span marked with `derived.gen_ai.is_root`. Data Prepper marks the outermost GenAI span of each trace for you (the root when it is a GenAI span, or the agent span below an HTTP handler), so you only need this to choose the span yourself. A span marked at the source wins.

```typescript
const plan = observe({ name: "planner", op: Op.INVOKE_AGENT }, async (query: string) => {
  markAgentRoot();
  // ...
});
```

Without the SDK, set the span attribute `derived.gen_ai.is_root` to `true` on the agent's span.

### `score()`

Records one evaluation result as an OTel log event with event name `gen_ai.evaluation.result`, following the [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-events/). The event carries the trace and span id of the **evaluated** span, so it joins to the trace without adding spans to it. It is exported over OTLP logs (`/v1/logs`). Data Prepper routes these events to the `otel-v1-genai-evaluation` index.

```typescript
// Inline: the evaluated span is the active span
withObserve("answer", { op: Op.CHAT }, () => {
  score({ name: "relevance", value: 0.92, label: "relevant", evaluator: "relevance_judge" });
});

// Offline: score a stored span by id
score({
  name: "accuracy",
  value: 0.95,
  traceId: "6ebb9835f43af1552f2cebb9f5165e39",
  spanId: "89829115c2128845",
  explanation: "Weather data matches ground truth",
  evaluator: "accuracy_judge",
  evaluatorVersion: "1.2.0",
  evaluatorType: "llm_judge",
  direction: "maximize",
  scoreMin: 0,
  scoreMax: 1,
});

// Trace-level: only a trace id is known. The event has no span context and
// carries opensearch.evaluation.trace_id and opensearch.evaluation.level=trace.
score({ name: "task_success", value: 1, traceId: "6ebb9835f43af1552f2cebb9f5165e39" });
```

The instrumentation scope of the event is always set: the evaluator (`evaluator` / `evaluatorVersion`), or `opensearch-genai-observability-sdk-ts` and the SDK version when no evaluator is named. Every logger the SDK creates (grades, case and run events) also carries the scope attributes `opensearch.genai.sdk.name` = `opensearch-genai-observability-sdk-ts` and `opensearch.genai.sdk.version` = the SDK version. The grade source (`attributes.derived.evaluation.source = opensearch-sdk` in the evaluation index) is derived from the scope, so custom evaluator names still count as SDK grades. The timestamp is the time `score()` is called.

**Scores are doubles.** `gen_ai.evaluation.score.value` is a double in the OTel semantic conventions, but OTel JS encodes any whole JS number (for example `1`) as an OTLP `intValue`, and the logs API has no way to request a double. The SDK's own log exporters (the OTLP/HTTP exporter `register()` creates, and `AWSSigV4OTLPLogExporter`) re-encode whole-number `gen_ai.evaluation.score.value`, `opensearch.evaluation.score.min` / `.max` / `.threshold` and the `duration_ms` attributes as `doubleValue`. With your own `logExporter` or a global `LoggerProvider` you configured, whole numbers are sent as `intValue`. The OpenSearch evaluation index maps the field as `double`, so stored values are the same either way.

**Parameters:**

| Parameter | Type | Attribute | Description |
|---|---|---|---|
| `name` | `string` | `gen_ai.evaluation.name` | Metric name (required) |
| `value` | `number` | `gen_ai.evaluation.score.value` | Numeric score |
| `label` | `string` | `gen_ai.evaluation.score.label` | Low-cardinality label (`"pass"`, `"relevant"`) |
| `explanation` | `string` | `gen_ai.evaluation.explanation` | Evaluator rationale (truncated to 500 chars) |
| `responseId` | `string` | `gen_ai.response.id` | Evaluated completion id, if known |
| `traceId` | `string` | event trace id | Trace of the evaluated span |
| `spanId` | `string` | event span id | Evaluated span (requires `traceId`) |
| `level` | `"span" \| "trace" \| "session" \| "tool_call"` | `opensearch.evaluation.level` | Defaults to `"trace"` for trace-level scores |
| `evaluator` | `string` | scope name, `opensearch.evaluation.evaluator.name` | Evaluator identity |
| `evaluatorVersion` | `string` | scope version, `opensearch.evaluation.evaluator.version` | Evaluator version |
| `evaluatorType` | `"llm_judge" \| "code" \| "human" \| "external"` | `opensearch.evaluation.evaluator.type` | Kind of evaluator |
| `direction` | `"maximize" \| "minimize"` | `opensearch.evaluation.score.direction` | Whether higher is better |
| `scoreMin` / `scoreMax` | `number` | `opensearch.evaluation.score.min` / `.max` | Scale bounds |
| `threshold` | `number` | `opensearch.evaluation.score.threshold` | Pass threshold. `direction` defaults to `maximize` (recorded) |
| `assessment` | `"pass" \| "fail" \| boolean` | `opensearch.evaluation.assessment` | Explicit verdict. Invalid values are dropped with a warning |
| `conversationId` | `string` | `gen_ai.conversation.id` | Session id for session-scoped evaluations |
| `agentName` | `string` | `gen_ai.agent.name` | Evaluated agent |
| `errorType` | `string` | `error.type` | Set when the evaluator failed |
| `judgeTraceId` | `string` | `opensearch.evaluation.judge.trace_id` | The judge's own trace |
| `attributes` | `Record<string, unknown>` | | Extra string, number, or boolean attributes |

`opensearch.evaluation.*` attributes are OpenSearch extensions for fields that are still proposals in the GenAI semantic conventions. They will move to `gen_ai.*` names when those proposals merge.

A trace-level score (only `traceId`) is never attached to a span id derived from the trace id.

**Verdicts.** OpenSearch Dashboards shows pass/fail only for a declared rule; a result without one is neutral ("Scored"). Declare the rule with `assessment` (explicit verdict) or `threshold` (+ `direction`). When `value` and `threshold` are given without `assessment`, the SDK computes the assessment and records it too: `pass` if `value >= threshold` (`maximize`) or `value <= threshold` (`minimize`), else `fail`. An explicit `assessment` always wins.

```typescript
score({ name: "answer_quality", value: 3, threshold: 4, scoreMin: 1, scoreMax: 5 }); // assessment=fail
score({ name: "latency_s", value: 9.2, threshold: 12, direction: "minimize" });      // assessment=pass
score({ name: "tool_selection", value: 1, assessment: "pass" });
```

### `evaluate()`

Run a task against a dataset, score outputs, and record the run as OTel log events. The SDK creates no spans of its own: each case's agent run is its own trace, exactly like production.

```typescript
import { evaluate } from "opensearch-genai-observability-sdk-ts";
import type { EvalScore } from "opensearch-genai-observability-sdk-ts";

function accuracy(input: unknown, output: unknown, expected: unknown): EvalScore {
  return {
    name: "accuracy",
    value: String(output).includes(String(expected)) ? 1.0 : 0.0,
  };
}

const result = evaluate({
  name: "rag-agent",
  task: (input) => callMyAgent(input),
  data: [
    { input: "What is Python?", expected: "programming language" },
    { input: "What causes rain?", expected: "water vapor" },
  ],
  scores: [accuracy],
  metadata: { agentVersion: "v2" },
  recordIo: true,
});

console.log(result.summary); // { totalCases: 2, passCount: 2, errorCount: 0, scores: { accuracy: { avg: 1.0 } } }
```

Produces:
```
trace (one per case)                        the agent run, unchanged
└── root span                               + test.suite.name, test.suite.run.id, test.case.id, test.case.name
    (event) gen_ai.evaluation.result        one per score, parented to the root span, test.* ids copied
    (event) opensearch.test_case.result     one per case, parented to the root span
(event) opensearch.test_suite_run.result    one per run, no trace context
```

`opensearch.test_case.result` attributes: `test.suite.name`, `test.suite.run.id`, `test.case.id`, `test.case.name`, `test.case.result.status` (`pass` | `fail` | `error`), `error.type` (exception class name, when the task or a scorer threw), `opensearch.test_case.duration_ms`, run `metadata`, and with `recordIo: true` the truncated `opensearch.test_case.input`, `.expected` and `.output`.

`opensearch.test_suite_run.result` attributes: `test.suite.name`, `test.suite.run.id`, `test.suite.run.status` (`success` when no case errored, else `failure`), `opensearch.test_suite_run.case_count`, `.pass_count`, `.fail_count`, `.error_count`, `.duration_ms`, and run `metadata`.

A case whose task throws still gets its case event (status `error`) and the run continues. When the task creates no span, the case and score events have no trace context. All events go to the OTLP logs endpoint; Data Prepper routes them to `otel-v1-genai-evaluation-*`, distinguished by `eventName`.

**How root spans are found.** The TypeScript SDK installs no context manager, so `evaluate()` cannot rely on the active OTel context. Cases run one at a time and `task` is synchronous, so the SDK keeps a module-level "current case" while each task runs. `TestCaseSpanProcessor` reads it in `onStart`: every span started during the case without a parent from the same case (no parent, or a remote parent) is stamped with the `test.*` ids, and the first one becomes the trace context for that case's events. Spans started by scorers (LLM judges) are outside the case and are not stamped. `register()` adds the processor to its provider, and `evaluate()` adds it to a global OTel JS 1.x `BasicTracerProvider` if missing. With a provider that only takes processors at construction (OTel JS 2.x), add it yourself:

```typescript
import { TestCaseSpanProcessor } from "opensearch-genai-observability-sdk-ts";

const provider = new BasicTracerProvider({
  spanProcessors: [new TestCaseSpanProcessor(), new BatchSpanProcessor(exporter)],
});
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `name` | `string` | Benchmark name (`test.suite.name`). Stable across runs |
| `task` | `(input: unknown) => unknown` | Synchronous function that takes input and returns output |
| `data` | `Array<{ input, expected?, caseId?, caseName? }>` | Test cases |
| `scores` | `Array<ScorerFn \| Scorer>` | Scorer functions: `(input, output, expected)` returning `EvalScore`, `EvalScore[]`, `number`, or `boolean`. Optionally wrapped with `defineScorer()` |
| `metadata` | `Record<string, unknown>` | Copied to the case and run events. Reserved keys are filtered |
| `recordIo` | `boolean` | Record input/expected/output as `opensearch.test_case.*` on the case event (default `false`) |

Each `TestCaseResult` has `status` (`pass`, or `fail` when the case errored or failed a verdict), `resultStatus` (`pass` | `fail` | `error`, as emitted), `errorType`, `durationMs`, `assessments` (evaluation name to verdict), and the `traceId` / `spanId` of the agent root span when the task created one.

**Declaring rules.** Wrap a scorer with `defineScorer(spec, fn)` to declare its evaluation name and pass rule up front. A scorer may also return a `boolean` (a verdict) or an `EvalScore` with `assessment` (`"pass"` / `"fail"`), `passed`, `threshold`, `direction`, `scoreMin`, `scoreMax`; fields set on the `EvalScore` win over the declaration.

```typescript
import { defineScorer } from "opensearch-genai-observability-sdk-ts";

const quality = defineScorer(
  { name: "answer_quality", threshold: 4, scoreMin: 1, scoreMax: 5, evaluatorType: "llm_judge" },
  (input, output) => judge(input, output), // number: named "answer_quality", verdict from threshold
);
const latency = defineScorer(
  { name: "latency_budget", direction: "minimize", threshold: 12 },
  () => secondsTaken, // pass when <= 12
);
const tools = defineScorer({ name: "tool_selection" }, () => ({
  name: "tool_selection", value: hitRate, passed: hitRate === 1,
}));
```

`ScorerSpec` fields: `name` (evaluation name of number/boolean results and of the error grade; default the function name), `threshold`, `direction` (default `maximize` with a threshold), `scoreMin` / `scoreMax`, `evaluator` (scope and `evaluator.name`), `evaluatorType`. A scorer that throws emits a grade with `error.type` and no value under the declared `name` (else the function name), so it lands on the same evaluation as its successful results.

**Case status** (`test.case.result.status`): `error` if the task or any scorer threw; else `fail` if any score of the case has a `fail` verdict (explicit `assessment` / `passed`, or `threshold` + `direction`); else `pass`. Scores with no declared rule never fail a case, so without declarations the status is as before (`pass` unless something threw). The run status (`test.suite.run.status`) still reflects errors only.

### `Benchmark`

Upload pre-computed evaluation results from any framework. Each `log()` emits one `gen_ai.evaluation.result` event per score and one `opensearch.test_case.result` event, both parented to the evaluated agent span when `traceId` and `spanId` are given. With only `traceId`, scores are trace-level and the case event has no trace context; with neither, no event has trace context. `error` or `errorType` marks the case `error` (`error.type` from `errorType`); otherwise a `fail` verdict marks it `fail`; `status` sets `pass`, `fail` or `error` explicitly. `scores` is `{ name: value }` or an `EvalScore[]` (to declare `assessment` / `threshold` / bounds). `close()` emits the `opensearch.test_suite_run.result` event. No spans are created.

```typescript
import { Benchmark } from "opensearch-genai-observability-sdk-ts";

const bench = new Benchmark("nightly-eval", {
  metadata: { model: "gpt-4" },
  recordIo: true,
});

bench.log({
  input: "What is Python?",
  output: "A language",
  scores: { accuracy: 1.0 },
});

// Link to existing agent traces
bench.log({
  input: "query",
  output: "answer",
  scores: { accuracy: 0.9 },
  traceId: "6ebb9835f43af1552f2cebb9f5165e39",
  spanId: "89829115c2128845",
  durationMs: 840,
});

// Declare verdicts: the case fails because answer_quality is below its threshold
bench.log({
  input: "query",
  output: "answer",
  scores: [
    { name: "answer_quality", value: 3, threshold: 4, scoreMin: 1, scoreMax: 5 },
    { name: "tool_selection", value: 1, assessment: "pass" },
  ],
});

const summary = bench.close();
```

### `OpenSearchTraceRetriever`

Retrieves GenAI trace spans from OpenSearch. Requires `@opensearch-project/opensearch` package.

```typescript
import { OpenSearchTraceRetriever } from "opensearch-genai-observability-sdk-ts";

const retriever = new OpenSearchTraceRetriever({
  host: "https://localhost:9200",
  auth: { username: "admin", password: "admin" },
  verifyCerts: false,
});

// Retrieve all spans for a session or trace
const session = await retriever.getTraces("my-conversation-id");
for (const trace of session.traces) {
  for (const span of trace.spans) {
    console.log(`${span.operationName}: ${span.name} (${span.model})`);
  }
}

// List recent root spans
const roots = await retriever.listRootSpans({
  services: ["my-agent"],
  maxResults: 10,
});

// Check which traces already have evaluation spans
const evaluated = await retriever.findEvaluatedTraceIds(["trace-id-1", "trace-id-2"]);
```

**Constructor:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `host` | `string` | `"https://localhost:9200"` | OpenSearch endpoint |
| `index` | `string` | `"otel-v1-apm-span-*"` | Index pattern for span data |
| `auth` | `{ username, password } \| "awsSigV4"` | — | Authentication method |
| `verifyCerts` | `boolean` | `true` | Verify TLS certificates |

### `AWSSigV4OTLPExporter`

OTLP trace exporter with AWS SigV4 request signing. Use with `register()` for AWS-hosted endpoints.

```typescript
import { AWSSigV4OTLPExporter } from "opensearch-genai-observability-sdk-ts";

const exporter = new AWSSigV4OTLPExporter({
  endpoint: "https://pipeline.us-east-1.osis.amazonaws.com/v1/traces",
  service: "osis",       // "osis" for OSIS pipelines, "es" for OpenSearch Service
  region: "us-east-1",   // or set AWS_DEFAULT_REGION / AWS_REGION
});
```

`AWSSigV4OTLPLogExporter` takes the same options and signs OTLP/JSON log exports (evaluation events). `register()` creates one automatically when `exporter` is an `AWSSigV4OTLPExporter`.

Requires `@aws-sdk/credential-providers` and `aws4` packages.

## Configuration

| Environment Variable | Description | Default |
|---|---|---|
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Full OTLP traces endpoint URL | — |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base OTLP endpoint URL (`/v1/traces` and `/v1/logs` appended) | — |
| `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` | Protocol for traces (`http/protobuf`, `grpc`) | — |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | Protocol for all signals (`http/protobuf`, `grpc`) | — |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Full OTLP/HTTP logs endpoint URL for evaluation events | See [Endpoints](#endpoints-traces-and-evaluation-logs) |
| `AWS_DEFAULT_REGION` | AWS region for SigV4 signing | — |
| `AWS_REGION` | AWS region for SigV4 signing (fallback) | — |

## Examples

See the [`examples/`](examples/) directory:

| Example | Description |
|---|---|
| [`01_tracing_basics.ts`](examples/01_tracing_basics.ts) | `observe()` wrapper, `withObserve()`, `enrich()` |
| [`02_scoring.ts`](examples/02_scoring.ts) | Span-level, trace-level, and standalone scoring |
| [`03_aws_sigv4.ts`](examples/03_aws_sigv4.ts) | AWS SigV4 authentication with `AWSSigV4OTLPExporter` |
| [`04_async_tracing.ts`](examples/04_async_tracing.ts) | Async function and generator tracing |
| [`05_openai_auto_instrument.ts`](examples/05_openai_auto_instrument.ts) | OpenAI auto-instrumentation via `register()` |
| [`06_retrieval_and_eval.ts`](examples/06_retrieval_and_eval.ts) | Retrieve traces from OpenSearch, evaluate, write scores back |
| [`07_benchmarks.ts`](examples/07_benchmarks.ts) | `evaluate()` with scorers, `Benchmark` with manual logging |

## Python SDK

Looking for the Python version? See [opensearch-genai-observability-sdk-py](https://github.com/opensearch-project/genai-observability-sdk-py).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Developer Guide

```bash
# Install dependencies
pnpm install

# Build (ESM + CJS + type declarations)
pnpm build

# Run tests
pnpm test

# Type-check
pnpm typecheck

# Lint
pnpm lint
```

## Security

If you discover a potential security issue in this project we ask that you notify the OpenSearch Security Team via [opensearch-security@amazon.com](mailto:opensearch-security@amazon.com). Please do **not** create a public GitHub issue.

## License

This project is licensed under the [Apache License 2.0](LICENSE).

## Copyright

Copyright OpenSearch Contributors. See [NOTICE](NOTICE) for details.
