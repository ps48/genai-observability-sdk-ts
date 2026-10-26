# Contributing to OpenSearch GenAI Observability SDK for TypeScript

Thank you for your interest in contributing! This document provides guidelines for contributing to this project.

## Code of Conduct

This project has adopted the [Amazon Open Source Code of Conduct](https://aws.github.io/code-of-conduct). For more information, see the [Code of Conduct FAQ](https://aws.github.io/code-of-conduct-faq).

## Security

If you discover a potential security issue, please notify the OpenSearch Security Team via [opensearch-security@amazon.com](mailto:opensearch-security@amazon.com). Do **not** create a public GitHub issue for security vulnerabilities.

## Developer Certificate of Origin

This project requires the [Developer Certificate of Origin (DCO)](https://developercertificate.org/). All commits must be signed off:

```bash
git commit -s -m "Your commit message"
```

This adds a `Signed-off-by: Your Name <your.email@example.com>` trailer to your commit message.

## Getting Started

### Prerequisites

- Node.js >= 18
- [pnpm](https://pnpm.io/) (install with `npm install -g pnpm`)

### Setup

```bash
git clone https://github.com/opensearch-project/genai-observability-sdk-ts.git
cd genai-observability-sdk-ts
pnpm install
```

### Development Commands

```bash
pnpm build       # Build ESM + CJS + type declarations
pnpm test        # Run tests
pnpm test:watch  # Run tests in watch mode
pnpm typecheck   # Type-check with tsc
pnpm lint        # Lint source and test files
```

### Project Structure

```
src/
├── index.ts        # Barrel export
├── observe.ts      # observe() / withObserve() / Op
├── enrich.ts       # enrich() — span attribute helpers
├── register.ts     # register() — OTel pipeline setup
├── score.ts        # score(): gen_ai.evaluation.result log events
├── logs.ts         # LoggerProvider used by score()
├── version.ts      # SDK scope name and version
├── benchmark.ts    # Benchmark class / evaluate()
├── exporters.ts    # AWSSigV4OTLPExporter, AWSSigV4OTLPLogExporter
├── retrieval.ts    # OpenSearchTraceRetriever
└── internal.ts     # Shared utilities
tests/
├── setup.ts        # Shared test provider
├── observe.test.ts
├── enrich.test.ts
├── register.test.ts
├── score.test.ts
├── benchmark.test.ts
├── exporters.test.ts
├── retrieval.test.ts
├── internal.test.ts
└── version.test.ts
examples/           # Usage examples
```

## Submitting Changes

1. Fork the repository
2. Create a feature branch: `git checkout -b my-feature`
3. Make your changes
4. Add or update tests for your changes
5. Ensure all checks pass: `pnpm test && pnpm typecheck && pnpm lint`
6. Commit with DCO sign-off: `git commit -s -m "Add feature X"`
7. Push and create a pull request

### Pull Request Guidelines

- Keep PRs focused on a single change
- Include tests for new functionality
- Update documentation if the public API changes
- Ensure CI passes before requesting review
- Use meaningful commit messages

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
