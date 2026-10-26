// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { SDK_VERSION, SDK_SCOPE_NAME } from '../src/version.js';

describe('version', () => {
  it('SDK_VERSION matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(SDK_VERSION).toBe(pkg.version);
  });

  it('SDK_SCOPE_NAME is the TS SDK scope', () => {
    expect(SDK_SCOPE_NAME).toBe('opensearch-genai-observability-sdk-ts');
  });
});
