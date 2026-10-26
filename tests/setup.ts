// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { context } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { Resource } from '@opentelemetry/resources';
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { logs } from '@opentelemetry/api-logs';
import {
  LoggerProvider,
  SimpleLogRecordProcessor,
  InMemoryLogRecordExporter,
} from '@opentelemetry/sdk-logs';

export const exporter = new InMemorySpanExporter();

const contextManager = new AsyncLocalStorageContextManager();
context.setGlobalContextManager(contextManager);

const provider = new BasicTracerProvider({
  resource: new Resource({ "service.name": "test-service" }),
});
provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
provider.register();

export const logExporter = new InMemoryLogRecordExporter();
export const loggerProvider = new LoggerProvider({
  processors: [new SimpleLogRecordProcessor({ exporter: logExporter })],
});
logs.setGlobalLoggerProvider(loggerProvider);

export function getFinishedLogRecords() {
  return logExporter.getFinishedLogRecords();
}

export function getFinishedSpans() {
  return exporter.getFinishedSpans();
}

export function clearSpans() {
  exporter.reset();
  logExporter.reset();
}
