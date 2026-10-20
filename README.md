# FreshClone

[![CI](https://github.com/ergishasani/freshclone/actions/workflows/ci.yml/badge.svg?event=push)](https://github.com/ergishasani/freshclone/actions/workflows/ci.yml)

**Your tests pass. Can a new contributor actually start the app?**

FreshClone checks the setup commands in your README in a disposable Docker environment, then verifies that your application responds. Catch missing setup steps before a contributor has to report them.

An environment variable on a maintainer's laptop, an old dependency folder, or an undocumented configuration file can hide a broken onboarding experience. FreshClone starts with the files tracked by Git and runs the instructions a newcomer would follow.

**Status:** early development. Source version 0.2.0 supports Node.js and Python projects in Linux containers, with named scenarios and disposable database services. This version is not published to npm; use the source checkout below or build a tarball with `npm pack`.

## What works today

- Read explicitly marked shell blocks directly from a Markdown file.
- Guide configuration creation, diagnose prerequisites with `doctor`, and preview selected commands without Docker.
- Select named scenarios, explicit Bash/sh execution, and Node or Python application images.
- Start disposable PostgreSQL/Redis services on an isolated network.
- Assert HTTP status, response content, JSON fields, generated files, and command output.
- Copy Git-tracked files from the current working tree into a temporary directory.
- Execute setup steps in order, preserving shell state between steps.
- Launch an application in the background and check an HTTP endpoint inside the container.
- Stop the run after configured time limits and clean up the container.
- Show live progress, step durations, categorized failures, JSON, and GitHub summaries/README annotations.

FreshClone does not infer which commands are safe or repair your documentation automatically. You choose the blocks and define the expected result.

## Try the included example

You need Git, Node.js 22 or newer, and npm; Node.js 24 is recommended. To run an application check, you also need a running Docker daemon configured for Linux containers. Docker Desktop users should select Linux containers.

```sh
git clone https://github.com/ergishasani/freshclone.git
cd freshclone
npm ci
npm run build
node dist/src/cli.js --help
```

Preview the bundled example without Docker:

```sh
node dist/src/cli.js plan --root examples/hello-node
```

Run the same example in Docker:

```sh
node dist/src/cli.js check --root examples/hello-node
```

The first check may take longer while Docker downloads the configured Node.js image. The example uses Node's built-in HTTP server and requires no third-party application dependencies.

## Check your project

### 1. Mark commands in your README

Place a marker immediately before each shell code fence you want FreshClone to run. The marker is an HTML comment, so readers still see normal setup instructions.

````markdown
Install dependencies:

<!-- freshclone:install -->

```sh
npm ci
```

Start the application:

<!-- freshclone:start -->

```sh
npm run dev
```
````

Use unique block names. Add markers yourself; `init` does not modify your README.

### 2. Create `.freshclone.yml`

```yaml
version: 1
readme: README.md
image: node:24-bookworm-slim
timeout: 60
steps:
  - block: install
  - block: start
    background: true
expect:
  http:
    url: http://127.0.0.1:3000/
    status: 200
    timeout: 30
```

Times are in seconds. The HTTP check runs inside the same container as the application; no host port needs to be exposed.

You can also generate a starter configuration after marking your README:

```sh
node /path/to/freshclone/dist/src/cli.js init --root /path/to/your-project
```

`init` guides terminal users through block selection, runtime, shell, image, and optional server readiness. It never overwrites an existing file. For scripted setup, use `init --no-interactive --blocks install,start --start start --url http://127.0.0.1:3000/`. Without server selection it generates a setup-only recipe. A long-running server left as a foreground step will time out.

### 3. Preview, then run

```sh
node /path/to/freshclone/dist/src/cli.js plan --root /path/to/your-project
node /path/to/freshclone/dist/src/cli.js check --root /path/to/your-project
```

Your target project must be inside a Git working tree for `check`. Commands run against a temporary copy of tracked files, including tracked local edits. They do not run against a clean copy of `HEAD`. Untracked files, `.git`, `node_modules`, and local `.env` files are excluded. Tracked `.env.example`, `.env.sample`, and `.env.template` files are allowed. A local configuration file on your laptop will not accidentally make the check pass.

Without an HTTP expectation, a passing result verifies only that the selected setup commands exited successfully. To verify that an application starts and responds, configure a background step and `expect.http`.

The source project is not modified by the run. Treat command output as potentially sensitive: application logs can print secrets from tracked files or other project data.

## CLI reference

| Command             | Purpose                                                 | Docker required           |
| ------------------- | ------------------------------------------------------- | ------------------------- |
| `freshclone init`   | Guide or script configuration from marked README blocks | No                        |
| `freshclone doctor` | Diagnose Git, Docker, configuration, and marked blocks  | Yes (checks availability) |
| `freshclone plan`   | Validate configuration and show the selected commands   | No                        |
| `freshclone check`  | Run the setup and application check                     | Yes                       |

In a source checkout, replace `freshclone` with `node dist/src/cli.js`.

| Flag                 | Purpose                                        |
| -------------------- | ---------------------------------------------- |
| `--root <directory>` | Select the project directory                   |
| `--config <file>`    | Select a configuration file                    |
| `--json`             | Emit JSON for `plan`, `doctor`, or `check`     |
| `--scenario <name>`  | Select a named setup path                      |
| `--github`           | Write GitHub summaries and failure annotations |
| `--quiet`            | Suppress live progress                         |
| `--help`             | Show command usage                             |
| `--version`          | Show the current version                       |

See the [configuration guide](docs/configuration.md) for the execution model and practical limits.

## Use it in GitHub Actions

After marking your project's README and committing its configuration, add `.github/workflows/freshclone.yml`:

```yaml
name: README setup
on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  onboarding:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          persist-credentials: false
      - uses: ergishasani/freshclone@v0.1.0
```

The composite action builds FreshClone from source and runs `check` in your checked-out project. The current source Action also writes job summaries and README annotations and accepts `scenario`. The released v0.1.0 Action accepts `root` and `config` inputs for projects in a subdirectory or a differently named configuration file. It requires a Linux runner with Docker and registry access.

`@v0.1.0` selects the first versioned release. Replace it with a reviewed FreshClone commit SHA when adopting it in a workflow that needs pinned dependencies. Use `@main` only when you intend to follow ongoing development.

Do not pass repository secrets to these checks or use a privileged event to execute a contributor's branch. See [SECURITY.md](SECURITY.md).

## Contribute

Contributions are welcome, including documentation, useful example projects, clearer diagnostics, and reproducible bug reports. You do not need to build a new runtime to help.

```sh
npm ci
npm run build
npm test
npm run check
```

`npm run check` runs type checking, formatting checks, and tests. A live Docker check is separate; run the included example when changing execution behavior.

Start with [CONTRIBUTING.md](CONTRIBUTING.md), browse [open issues](https://github.com/ergishasani/freshclone/issues), or read the [architecture](docs/architecture.md) and [roadmap](docs/roadmap.md). Please open an issue before a substantial change so the approach can be discussed.

## Scope and related work

[Runme](https://runme.dev/) also makes Markdown commands executable. FreshClone focuses on one question: can a contributor start this application from the documented setup steps? Explicit README blocks, a temporary copy of tracked files, and an application response check are the core of this project.

The source now includes Python, database services, richer assertions, scenarios, and GitHub reporting. Additional operating systems and further runtimes remain future work. See the [configuration guide](docs/configuration.md) and [npm release guide](docs/releases.md).

## Explore the examples

| Example                     | Demonstrates                                         | Expected result |
| --------------------------- | ---------------------------------------------------- | --------------- |
| `examples/hello-node`       | npm setup and HTTP; optional `--scenario production` | Pass            |
| `examples/hello-python`     | Python-only image and JSON readiness                 | Pass            |
| `examples/services-python`  | PostgreSQL and Redis connections                     | Pass            |
| `examples/broken-node`      | Application exits with missing configuration         | Fail            |
| `examples/broken-config`    | Missing `.env` copy step, with documented fix        | Fail            |
| `examples/broken-migration` | Missing SQLite migration, with documented fix        | Fail            |
| `examples/never-ready`      | Server stays alive but returns 503                   | Fail            |

Run `node dist/src/cli.js check --root examples/hello-python`, or substitute another example directory. New examples must be tracked by Git before checking a source checkout.

## Security and license

FreshClone executes repository-controlled shell commands. Run checks only for repositories you trust. Containers provide a disposable execution environment; they are not a secure sandbox for hostile code. FreshClone does not pass host credentials or the Docker socket into the application container. A daemon still has authority on its host, and container workloads can access the network.

See [SECURITY.md](SECURITY.md) for usage guidance and private vulnerability reporting. Contributors agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

Licensed under the [MIT License](LICENSE). Copyright © 2026 Ergis Hasani.
