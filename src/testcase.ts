// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { trace, type Context, type SpanContext } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';

/**
 * The test case evaluate() is running right now.
 *
 * The TypeScript SDK does not install a context manager, so the case cannot be
 * found through the active OTel context. evaluate() runs cases one at a time
 * and its task is synchronous, so a module-level "current case" is reliable:
 * every span started while it is set belongs to that case.
 */
export interface ActiveTestCase {
  attributes: Record<string, string>;
  /** First root span started while the case ran: the agent run's root span. */
  root?: SpanContext;
  /** Span ids started while the case ran, to tell roots from their children. */
  readonly seen: Set<string>;
}

let activeCase: ActiveTestCase | undefined;

/** @internal Run `fn` with `testCase` as the current case (restores the previous one). */
export function runInTestCase<T>(testCase: ActiveTestCase, fn: () => T): T {
  const previous = activeCase;
  activeCase = testCase;
  try {
    return fn();
  } finally {
    activeCase = previous;
  }
}

function parentSpanId(span: Span): string | undefined {
  const s = span as unknown as { parentSpanId?: string; parentSpanContext?: SpanContext };
  return s.parentSpanContext?.spanId ?? s.parentSpanId;
}

/**
 * Span processor that stamps `test.suite.name`, `test.suite.run.id`,
 * `test.case.id` and `test.case.name` on the root span(s) of each test case
 * while evaluate() runs it, and remembers the first root span so the case's
 * `opensearch.test_case.result` event and score events are parented to it.
 *
 * A span is a case root when it has no parent, or when its parent was not
 * started inside the same case (for example a remote parent). Without a context manager every span is a root,
 * so all of them are stamped and the first one is used as the trace context.
 *
 * register() installs it. evaluate() also adds it to the global
 * BasicTracerProvider (OTel JS 1.x) when missing. With a provider that cannot
 * take processors after construction (OTel JS 2.x), pass it yourself:
 * `new BasicTracerProvider({ spanProcessors: [new TestCaseSpanProcessor(), ...] })`.
 */
export class TestCaseSpanProcessor implements SpanProcessor {
  onStart(span: Span, _parentContext: Context): void {
    const testCase = activeCase;
    if (!testCase) return;

    const ctx = span.spanContext();
    const parent = parentSpanId(span);
    const isRoot = !parent || !testCase.seen.has(parent);
    testCase.seen.add(ctx.spanId);
    if (!isRoot) return;

    span.setAttributes(testCase.attributes);
    if (!testCase.root) {
      testCase.root = { traceId: ctx.traceId, spanId: ctx.spanId, traceFlags: ctx.traceFlags };
    }
  }

  onEnd(_span: ReadableSpan): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

const instrumented = new WeakSet<object>();
let missingWarned = false;

interface ProcessorHost {
  addSpanProcessor(processor: SpanProcessor): void;
  _registeredSpanProcessors?: SpanProcessor[];
}

/** @internal Add a TestCaseSpanProcessor to `provider` once. Returns false if it cannot. */
export function installTestCaseProcessor(provider: unknown): boolean {
  if (!provider || typeof provider !== 'object') return false;
  if (instrumented.has(provider)) return true;
  const host = provider as Partial<ProcessorHost>;
  if (host._registeredSpanProcessors?.some(p => p instanceof TestCaseSpanProcessor)) {
    instrumented.add(provider);
    return true;
  }
  if (typeof host.addSpanProcessor !== 'function') return false;
  host.addSpanProcessor(new TestCaseSpanProcessor());
  instrumented.add(provider);
  return true;
}

/** @internal Make sure the global tracer provider stamps test case root spans. */
export function ensureGlobalTestCaseProcessor(): void {
  const global = trace.getTracerProvider() as unknown as { getDelegate?: () => unknown };
  const delegate = typeof global.getDelegate === 'function' ? global.getDelegate() : global;
  if (instrumented.has(delegate as object)) return;
  if (installTestCaseProcessor(delegate)) return;
  // No SDK provider registered: there are no spans to stamp.
  if ((delegate as object | undefined)?.constructor?.name === 'NoopTracerProvider') return;
  if (missingWarned) return;
  missingWarned = true;
  console.warn(
    "[opensearch-genai-observability-sdk-ts] evaluate(): could not add TestCaseSpanProcessor to " +
      "the global tracer provider, so agent root spans are not stamped with test.* attributes " +
      "and case events have no trace context. Add new TestCaseSpanProcessor() to your provider.",
  );
}
