# Architecture

FreshClone keeps the commands in documentation and puts execution policy in a small configuration file. The CLI ties together Markdown parsing, validation, execution, and reporting.

## Data flow

```text
README + .freshclone.yml
          |
          v
  Parse and validate
          |
          v
  Select ordered blocks ----> plan report
          |
          v
 Copy tracked working files
          |
          v
 Disposable Linux container
          |
          v
  Services -> setup -> start -> assertions
          |
          v
 Report and clean up
```

## Responsibilities

### Markdown parser

Find explicitly marked shell blocks, retain enough source information for useful diagnostics, and reject ambiguous block selection. Parsing never executes commands.

Keep the supported Markdown convention small and predictable. Changes to accepted fence syntax should include tests showing the intended behavior and errors for ambiguous input.

### Configuration

Load YAML, validate the version and field values, resolve selected blocks, and produce an ordered execution plan. Configuration errors should be reported before Docker is invoked.

This is the natural place to keep validation of durations, expected status, and missing block references. Avoid silently guessing commands or correcting misspelled configuration fields.

### Runner

Identify and copy tracked working-tree files, create temporary execution resources, invoke Docker, run ordered commands, and collect results. Shell state is preserved across steps; an application step can run in the background while the readiness check proceeds.

Cleanup and timeouts belong to the runner lifecycle. Error paths need the same cleanup behavior as success paths. A testable boundary around external processes helps verify failures without requiring Docker in every unit test.

### CLI and reporting

Parse arguments, choose `init`, `plan`, or `check`, and render results in text or JSON. Keep machine-readable output separate from human guidance so callers can consume it reliably.

`init` selects existing markers in README order by default. Interactive or explicit options can select a subset, runtime and shell, and a final background server step with an HTTP expectation. Without a server selection, the recipe is setup-only. It does not rewrite README instructions or overwrite existing configuration. `plan` is a useful entry point for validating configuration without Git or Docker.

The container helper captures each step's combined output in a separate file under `/tmp` and includes the last 64 KiB in the report. Keeping logs separate avoids relying on the order in which process output and lifecycle events arrive. Output is raw and unredacted; a setup-only pass does not verify application readiness.

## Working-tree semantics

The target is the current contents of Git-tracked files, including local tracked edits. Git provides the file list; it is not used to restore committed file contents. This makes it possible to check documentation changes before committing them.

Untracked files and dependency folders do not enter the execution copy. Local `.env` files are excluded except for tracked `.env.example`, `.env.sample`, and `.env.template` files. Symbolic links are rejected during snapshot creation. The original checkout is not the application's working directory.

## Extension points

Useful changes can begin in one area:

- A parser improvement with a small Markdown fixture.
- A clearer validation message with an invalid configuration example.
- A runner failure case with a fake process or focused integration test.
- A better report with explicit expected output.
- An example project demonstrating a real setup problem.

The host CLI uses Node.js. The application image selects either the built-in-only Node supervisor (`assets/container-runner.mjs`) or Python supervisor (`assets/container-runner.py`). Both preserve shell state, enforce timeouts, poll services/HTTP, run file/output assertions, and emit the same report schema. Python images do not need Node. Contract integration tests exercise both supervisors against real Docker containers.

The runner owns service containers and their unique Docker network, passes only explicit configuration, and cleans all resources after each run. Supervisors check service TCP readiness before executing documentation; application-specific database checks remain README steps.

`src/init.ts` handles guided/scripted initialization; `src/doctor.ts` collects read-only prerequisite diagnostics; `src/reporting.ts` escapes GitHub summaries and workflow annotations. The CLI keeps progress on stderr and JSON on stdout. Scenario overrides are resolved and validated before block selection, with replacement rather than implicit deep merging.

The project does not need a general plugin framework before there are concrete extensions that require one.

## Trust boundary

Selected shell blocks are executable repository code. FreshClone does not treat Docker as a hostile-code sandbox, inject host credentials, or expose the Docker socket to the application container. Network access and raw application logs remain part of the execution model.

Read [SECURITY.md](../SECURITY.md) when changing file handling, Docker arguments, environment propagation, process cleanup, or workflows.
