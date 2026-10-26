import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  // Provide import.meta.url in the CJS build (used by createRequire in exporters.ts).
  shims: true,
  outDir: "dist",
  external: [
    /^@opentelemetry\//,
    /^@opensearch-project\//,
    /^@aws-sdk\//,
    "aws4",
    "crypto",
  ],
});
