# Changelog

This file records notable project changes. FreshClone is under early development and does not yet promise a stable configuration or programmatic API.

## 0.2.0 — Unreleased

### Added

- Guided and scripted init, doctor diagnostics, named scenarios, explicit shell/runtime selection, and static test environment values.
- Python-only container supervisor, disposable service networks and PostgreSQL/Redis examples.
- HTTP response text/JSON, file existence and foreground output expectations.
- Live progress, step durations, structured failure categories, GitHub job summaries and README annotations.
- Real Docker contract tests for both runtimes and examples for missing configuration, migrations and HTTP readiness failures.
- Publishable CLI packaging, metadata-based version output, and manually dispatched npm release validation/publishing.

This version is prepared in source; no npm publication or GitHub release has been performed.

## 0.1.0 — 2026-10-18

### Added

- TypeScript CLI with `init`, `plan`, and `check` commands.
- Explicit command selection from marked shell blocks in Markdown.
- YAML configuration for a Linux container, ordered steps, execution time limits, and an HTTP expectation.
- Execution against a temporary copy of Git-tracked working-tree files.
- Human-readable and JSON reports for plan and check commands.
- A dependency-free Node.js example application.
- Tests, development checks, community guidelines, and GitHub contribution templates.

The initial GitHub Action release is tagged `v0.1.0`. The CLI package is not published to npm; use a source checkout for local development.
