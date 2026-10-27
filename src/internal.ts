// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  "test.suite.name",
  "test.suite.run.id",
  "test.suite.run.status",
  "test.case.id",
  "test.case.name",
  "test.case.result.status",
  "test.case.error",
  "test.case.input",
  "test.case.output",
  "test.case.expected",
  "opensearch.test_case.input",
  "opensearch.test_case.output",
  "opensearch.test_case.expected",
  "opensearch.test_case.error",
  "opensearch.test_case.duration_ms",
  "opensearch.test_suite_run.case_count",
  "opensearch.test_suite_run.pass_count",
  "opensearch.test_suite_run.fail_count",
  "opensearch.test_suite_run.error_count",
  "opensearch.test_suite_run.duration_ms",
  "error.type",
  "gen_ai.operation.name",
]);

export function parseHex(value: string): number | null {
  if (value === "") return 0;
  const stripped = value.replace(/^0[xX]/, "");
  const parsed = parseInt(stripped, 16);
  return Number.isNaN(parsed) ? null : parsed;
}

export function validateMetadataKeys(
  metadata: Record<string, unknown>,
  context?: string,
): void {
  for (const key of Object.keys(metadata)) {
    if (RESERVED_KEYS.has(key)) {
      const prefix = context ? `[${context}] ` : "";
      console.warn(
        `${prefix}Key "${key}" is reserved and may be overwritten by the SDK.`,
      );
    }
  }
}

/** Normalize a hex trace id (optional 0x prefix, left-padded). Returns null if invalid. */
export function normalizeTraceId(value: string): string | null {
  const clean = value.replace(/^0[xX]/, "").padStart(32, "0").toLowerCase();
  return /^[0-9a-f]{32}$/.test(clean) && !/^0+$/.test(clean) ? clean : null;
}

/** Normalize a hex span id (optional 0x prefix, left-padded). Returns null if invalid. */
export function normalizeSpanId(value: string): string | null {
  const clean = value.replace(/^0[xX]/, "").padStart(16, "0").toLowerCase();
  return /^[0-9a-f]{16}$/.test(clean) && !/^0+$/.test(clean) ? clean : null;
}
