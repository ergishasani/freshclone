# Roadmap

The first goal is a reliable check of a small Node.js application's documented setup path. This roadmap describes direction, not release dates or promises.

## Implemented in the initial source version

- Marked shell blocks in Markdown.
- Explicit YAML configuration and an offline execution plan.
- A source CLI with `init`, `plan`, and `check`.
- A temporary copy of tracked working-tree files.
- Ordered commands, background application startup, and an HTTP response expectation.
- Linux Docker execution, time limits, cleanup, and text/JSON results.
- A small example application and contributor documentation.

## Next: make the core easy to trust

- Exercise the CLI against a few willing maintainers' real repositories and document the friction.
- Expand failure coverage for interrupted processes, Docker errors, missing files, and startup timeouts.
- Improve diagnostics with precise README locations and concise failure context.
- Add example projects with deliberately broken setup steps and documented fixes.
- Evaluate stable JSON output and configuration compatibility before promising an API.
- Prepare a reviewed tagged release and npm publication process.

## Later candidates

These need a concrete use case and design discussion before implementation:

- Python and other runtimes, including removing Node-specific assumptions in readiness checks.
- Multiple checks such as file existence or expected command output.
- Multi-service applications and database readiness.
- More complete GitHub job summaries and annotations.
- An explicit shell selection option for projects that require Bash; all accepted shell fences currently execute through `sh`.
- Additional operating-system environments.
- Stronger resource controls and optional network restrictions.
- A supported strategy for applications requiring test credentials.

## Outside the initial scope

- Executing arbitrary untrusted repositories safely.
- AI-generated setup repairs.
- Automatically deciding which README commands to run.
- A hosted service that stores repositories or credentials.
- Replacing unit tests, end-to-end tests, or dependency security tools.

## Propose a change

Open a [feature request](https://github.com/ergishasani/freshclone/issues/new/choose) with the actual setup problem, a small example, and the behavior you want to verify. Proposals based on a concrete repository are easier to assess than broad platform ideas.
