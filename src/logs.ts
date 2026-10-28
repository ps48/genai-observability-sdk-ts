// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { logs, type Logger, type LoggerProvider } from "@opentelemetry/api-logs";
import { SDK_SCOPE_NAME, SDK_VERSION } from "./version.js";

/**
 * LoggerProvider created by register(). score() prefers it over the global
 * provider so that register({ setGlobal: false }) still exports evaluation
 * events. When register() finds a user-configured global LoggerProvider it
 * does not create one, and score() uses the global provider.
 */
let sdkLoggerProvider: LoggerProvider | undefined;

export function setSdkLoggerProvider(provider: LoggerProvider | undefined): void {
  sdkLoggerProvider = provider;
}

export function getSdkLoggerProvider(): LoggerProvider | undefined {
  return sdkLoggerProvider;
}

/** The provider score() emits through: the one from register(), else the global one. */
export function resolveLoggerProvider(): LoggerProvider {
  return sdkLoggerProvider ?? logs.getLoggerProvider();
}

const GLOBAL_LOGS_API_KEY = Symbol.for("io.opentelemetry.js.api.logs");

/** True when any OTel JS logs API version has registered a global LoggerProvider. */
export function hasGlobalLoggerProvider(): boolean {
  return (globalThis as Record<symbol, unknown>)[GLOBAL_LOGS_API_KEY] !== undefined;
}

/** Instrumentation scope attribute naming the SDK that emitted an event. */
export const SDK_NAME_SCOPE_ATTRIBUTE = "opensearch.genai.sdk.name";
/** Instrumentation scope attribute with the version of that SDK. */
export const SDK_VERSION_SCOPE_ATTRIBUTE = "opensearch.genai.sdk.version";

/**
 * Logger for SDK events. The scope name/version is the evaluator identity when
 * given, else the SDK scope. Every logger carries scope attributes naming the
 * SDK, so the grade source can be derived from the scope.
 */
export function getEventLogger(name: string = SDK_SCOPE_NAME, version: string | undefined = SDK_VERSION): Logger {
  return resolveLoggerProvider().getLogger(name, version, {
    attributes: {
      [SDK_NAME_SCOPE_ATTRIBUTE]: SDK_SCOPE_NAME,
      [SDK_VERSION_SCOPE_ATTRIBUTE]: SDK_VERSION,
    },
  });
}
