# Configuration and execution

FreshClone reads `.freshclone.yml` from the project root. `--root` selects the project, `--config` selects a configuration inside it, and `--scenario` selects a named setup path. Configuration and README symlink targets must remain inside the project. Unknown keys and duplicate block references are errors.

## Complete example

```yaml
version: 1
runtime: node
image: node:24-bookworm-slim
shell: bash
timeout: 60
env:
  APP_MODE: test
services:
  database:
    image: postgres:17-alpine
    port: 5432
    timeout: 60
    env:
      POSTGRES_PASSWORD: example-only-password
steps:
  - block: install
  - block: configure
  - block: migrate
  - block: start
    background: true
expect:
  files: [dist/index.js]
  output:
    - block: migrate
      contains: migration-complete
  http:
    url: http://127.0.0.1:3000/health
    status: 200
    timeout: 30
    contains: ready
    json:
      ready: true
      database.connected: true
```

The README must contain every selected marker. Document commands for configuring the application's database URL using `database:5432`; FreshClone does not invent the application's environment variable names or migration commands.

## Fields

| Field                  | Meaning                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `version`              | Configuration schema, currently `1`                                                                                        |
| `readme`               | Relative Markdown path; default `README.md`                                                                                |
| `runtime`              | Supervisor runtime: `node` (default) or `python`                                                                           |
| `image`                | Linux image; default `node:24-bookworm-slim` or `python:3.13-slim` for Python                                              |
| `shell`                | `sh` (default) or `bash`; must exist in the selected image                                                                 |
| `timeout`              | Per foreground step limit, integer 1–600 seconds; default 60                                                               |
| `env`                  | Explicit string values for the application shell; never imports the host environment                                       |
| `steps`                | Nonempty ordered list of unique marked block names                                                                         |
| `steps[].background`   | Only one background step is permitted, and it must be last                                                                 |
| `expect.http.url`      | Local `http://127.0.0.1` or `http://localhost` endpoint; requires a background step                                        |
| `expect.http.status`   | Expected status 200–599; default 200                                                                                       |
| `expect.http.timeout`  | Readiness limit 1–300 seconds; default 30                                                                                  |
| `expect.http.contains` | Literal substring required in the response body                                                                            |
| `expect.http.json`     | Mapping from dotted field paths to expected JSON values; all must match                                                    |
| `expect.files`         | Nonempty list of files required under the workspace after setup/readiness                                                  |
| `expect.output`        | List of `{block, contains}` checks against foreground step output                                                          |
| `services`             | Named disposable dependencies with `image`, TCP `port`, optional `env`, and optional `timeout` (1–300 seconds, default 30) |
| `scenarios`            | Named overrides for alternative setup paths                                                                                |

All configured expectations must pass. HTTP status and body checks are retried together until the readiness deadline. Responses are bounded to 1 MiB; redirects are not followed. Dotted JSON paths use exact own properties (for example `database.connected` or `items.0.id`). Objects and arrays are compared structurally; strings are literal, not regular expressions. File checks reject paths or resolved symlinks outside the workspace. They check regular file existence, not contents. Output assertions inspect only the retained last 64 KiB, and background output is not an accepted readiness assertion.

Shell state such as `cd` and `export` persists between steps. File expectations are relative to the workspace root, even when a step changes directory. Application environment settings affect the shell and its children, not the supervisor. Environment values must be strings (quote numbers and booleans in YAML). Runtime and shell control variables such as `PATH`, `NODE_OPTIONS`, `PYTHONPATH`, and `BASH_ENV` are reserved. Use synthetic test values; this is not a credential store.

## README blocks

Put a unique named marker immediately before an executable fence:

````markdown
<!-- freshclone:install -->

```sh
npm ci
```
````

Names start with a letter and contain letters, numbers, hyphens, or underscores. Accepted fence labels are `sh`, `bash`, and `shell`. The configuration's `shell` determines execution; a `bash` fence alone does not change the interpreter. Unmarked fences are never executed.

## Initialization

`freshclone init` guides terminal users through block selection, runtime, shell, image, server block, and readiness URL. It previews available block names and never overwrites an existing configuration. It does not edit the README or run commands.

For scripts, use explicit options:

```sh
freshclone init --no-interactive --blocks install,start --start start --url http://127.0.0.1:8000/ --runtime python --shell bash
```

The selected server block is moved to the end and marked `background: true`. Without a server selection, initialization creates a setup-only recipe. With nonterminal input it never prompts; use `--interactive` only from a terminal. Add markers before initializing.

## Named scenarios

Common fields are inherited. A scenario replaces any field it specifies; nested mappings and lists are **not** deep merged. `version` and `readme` are shared and cannot be overridden. Every scenario's configuration is validated before selection.

```yaml
version: 1
steps:
  - block: install
scenarios:
  production:
    steps:
      - block: install
      - block: build
      - block: start
        background: true
    expect:
      http:
        url: http://127.0.0.1:3000/
  python:
    runtime: python
    steps:
      - block: pip-install
```

```sh
freshclone plan --scenario production
freshclone check --scenario production
```

Without `--scenario`, root `steps` are used. If only scenarios provide steps, selection is required. Use a CI matrix or separate invocations to check every path; a selected scenario runs once, in a fresh workspace.

## Disposable services

Each run creates a unique Docker bridge network. Services are reachable by name from the application container (for example `database:5432`, `cache:6379`). No host ports, host source directories, or Docker socket are passed to services. FreshClone starts every service, waits for its configured TCP port from inside the application container, then runs README steps. TCP connectivity does not verify authentication, migrations, or full application readiness: document those commands and check an application health endpoint.

Service containers have 512 MiB memory, one CPU, 256 processes, and `no-new-privileges`. Their filesystems remain writable for database initialization. The application retains its read-only root, dropped capabilities, 1 GiB/two CPU limit, writable temporary workspace and bounded `/tmp`. Containers and the network are removed after success, failure, or interruption. Service image pulls and application image startup each have bounded infrastructure timeouts; service readiness limits apply after the application supervisor starts. Network access remains enabled.

## Doctor and plan

```sh
freshclone doctor --json
freshclone plan --scenario production --json
```

`doctor` independently checks the host Node version, tracked project files, Linux Docker availability, and selected configuration/README blocks. It reports all failures with fixes. It does not pull an image or execute documentation. Image runtime and shell availability are verified when `check` starts the container. `plan` works without Git or Docker and prints selected commands, image, runtime, shell, explicit environment, services, and expectations.

## Snapshot and execution

`check` copies **current Git-tracked working-tree contents**, including tracked local edits. It does not restore `HEAD`. Untracked files, `.git`, `node_modules`, and local `.env*` are excluded, except tracked `.env.example`, `.env.sample`, and `.env.template`. Symbolic links in the snapshot are rejected. A safe tracked example plus a documented copy step is the supported way to create local test configuration.

The selected image must provide its supervisor runtime (`node` or `python3`), the selected shell, and tools used by its README. Host Node.js is still required for the CLI when checking Python projects. The source checkout is not modified by application commands.

## Reports and failures

Text output includes step durations, source locations, expectation results, and failed-step output. Live progress goes to stderr and repeats the current phase with elapsed time every five seconds. `--quiet` disables progress. `--json` disables progress automatically and keeps stdout to a single JSON result. Reports have `schemaVersion: 1`; additive fields may be introduced before 1.0.

| `failureKind`       | Meaning                                                               |
| ------------------- | --------------------------------------------------------------------- |
| `configuration`     | Invalid arguments, YAML, paths, or block selection                    |
| `infrastructure`    | Git, Docker, image/runtime/shell startup, or report transport failure |
| `setup`             | Foreground command failure or timeout                                 |
| `application-exit`  | Background application exited before readiness                        |
| `readiness-timeout` | HTTP status/content expectations never passed                         |
| `service-readiness` | A dependency's TCP port never became reachable                        |
| `expectation`       | Post-setup file/output assertions failed                              |
| `interrupted`       | The check received an interrupt                                       |

Step logs retain the last 64 KiB of combined stdout/stderr. They are raw and unredacted; bounded log storage can fill on noisy workloads. A setup-only pass proves only that the selected commands and optional file/output checks passed. A web pass verifies its configured endpoint and content, not every feature.

`--github` appends a Markdown summary to `GITHUB_STEP_SUMMARY` when set and emits escaped failure annotations. This is automatic under `GITHUB_ACTIONS=true`. Logs are HTML-escaped in summaries and omitted from raw terminal output in GitHub mode. The composite Action accepts `root`, `config`, and `scenario` inputs. The CLI still returns a nonzero exit for a failed check or failed summary write.
