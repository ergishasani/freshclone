# Roadmap

The goal is a reliable check of a contributor's documented setup path. Version 0.2.0 is prepared in source, not yet published to npm.

## Implemented

- Explicit marked Markdown blocks, strict YAML validation, and offline plans.
- Guided and scripted initialization, prerequisite diagnostics, and immutable config creation.
- Git-tracked working-tree snapshots and disposable Linux containers.
- Node.js and Python supervisors, explicit sh/Bash, preserved shell state and timeouts.
- Named scenarios and explicit test environment values.
- Disposable service networks, PostgreSQL/Redis examples, and bounded TCP readiness.
- HTTP status/body/JSON, file existence, and foreground output assertions.
- Live progress, step durations, failure categories, JSON, GitHub summaries and annotations.
- Real container integration tests and examples of missing configuration, migrations, and never-ready applications.
- npm packaging and a manual, tag-checked trusted-publishing workflow.

## Next

- Try the tool with willing maintainers and document adoption friction.
- Complete maintainer account setup and publish the reviewed npm release.
- Use integration results to refine service readiness, diagnostics, and compatibility guarantees.

## Later candidates

- Further runtimes and operating-system environments, driven by real repositories.
- Optional network restrictions, configurable resource budgets, and a supported strategy for applications that need test credentials.
- Multi-document setup paths and richer application-specific readiness checks.

## Outside current scope

Executing hostile repositories safely, automatically selecting unmarked commands, AI-generated repairs, a hosted repository/credential service, or replacing application tests.
