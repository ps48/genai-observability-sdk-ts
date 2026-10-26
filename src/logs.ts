// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { logs, type LoggerProvider } from "@opentelemetry/api-logs";

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
