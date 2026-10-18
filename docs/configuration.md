# Configuration and execution

FreshClone reads `.freshclone.yml` from the project root by default. Use `--root` to choose the target project and `--config` to select a different configuration file inside that project. The selected Markdown file must also remain inside the project, including any symlink target.

## Example

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

| Field                 | Meaning                                                                      |
| --------------------- | ---------------------------------------------------------------------------- |
| `version`             | Configuration schema version; use `1`                                        |
| `readme`              | Markdown file containing the selected blocks                                 |
| `image`               | Linux Docker image used to execute commands                                  |
| `timeout`             | Time limit for each setup step, in seconds; integer from 1 to 600            |
| `steps`               | Ordered list of marked blocks to execute                                     |
| `steps[].block`       | Name in a `freshclone` marker                                                |
| `steps[].background`  | Start this block in the background when `true`                               |
| `expect.http.url`     | HTTP URL at `127.0.0.1` or `localhost` to poll from inside the container     |
| `expect.http.status`  | Expected HTTP response status; integer from 200 to 599, default `200`        |
| `expect.http.timeout` | Maximum HTTP readiness wait, in seconds; integer from 1 to 300, default `30` |

Start with one foreground installation block and one background application block. At most one background step is allowed, and it must be last. A background step requires `expect.http`; a configuration with only foreground steps can omit the expectation. Changing an image or timeout changes the environment being verified.

The defaults for `readme`, `image`, and `timeout` are `README.md`, `node:24-bookworm-slim`, and `60`. Use explicit values when documenting your project's expected environment. Unknown configuration fields and duplicate step references are rejected.

## README blocks

Put a named marker directly before a shell fence:

````markdown
<!-- freshclone:install -->

```sh
npm ci
```
````

Use each block name only once. Names must start with a letter and contain only letters, numbers, hyphens, or underscores. Configuration selects blocks explicitly and determines their execution order. FreshClone does not execute every code fence in a README.

Fences may be labeled `sh`, `bash`, or `shell`, but commands run through the image's `sh` shell. Use portable shell commands suitable for the configured image; a `bash` fence does not select a Bash interpreter. A Windows host is supported through a Linux Docker daemon; PowerShell and Windows containers are outside the initial scope.

Shell setup such as `cd` and `export` persists between ordered steps. Background steps launch processes so FreshClone can continue to the HTTP check. Prefer a single application-start block marked `background: true` and keep its startup command in the foreground within that block; FreshClone handles backgrounding it. Foreground steps use the configured setup timeout; readiness for the background application uses the HTTP timeout.

## `init`

`init` generates a setup-only `.freshclone.yml` from all existing marked blocks in `README.md`, in document order. Every block is a foreground step; the generated file has no background step or HTTP expectation. It never overwrites an existing configuration file and does not edit documentation.

For a web application, set the final application-start step to `background: true` and add `expect.http` with your application's URL and expected response, as in the complete example above. A long-running server left in a foreground step will time out. Review the selected blocks, image, and time limits before running `check`.

If your README has no selected blocks yet, add markers first. `init` and `plan` require no Docker daemon.

## `plan`

`plan` reads and validates the configuration and prints the selected commands. Use it to catch missing or duplicate blocks before pulling an image or running commands.

```sh
node dist/src/cli.js plan --root examples/hello-node
node dist/src/cli.js plan --root examples/hello-node --json
```

Planning does not run the commands and does not prove that dependencies are available or the application will start. It does not require a Git repository.

## `check`

`check` uses Git to identify tracked files under the target project and copies their current working-tree contents into a temporary directory. This includes tracked local changes, rather than the committed contents of `HEAD`.

The copy excludes `.git`, `node_modules`, and untracked files. It also excludes `.env` and `.env.*`, with exceptions for tracked `.env.example`, `.env.sample`, and `.env.template` files. Commit a safe example and document how to create configuration instead of relying on a local `.env`. Symbolic links in the snapshot are rejected.

FreshClone launches a Linux container, runs the chosen commands, performs the HTTP check when configured, and cleans up the container and temporary files. The HTTP request is made from inside the container. `127.0.0.1` refers to that container, not your host.

```sh
node dist/src/cli.js check --root examples/hello-node
node dist/src/cli.js check --root examples/hello-node --json
```

The source checkout is not modified by setup commands. The container has a read-only root filesystem, writable workspace and temporary storage, and fixed memory/CPU/process limits. Commands should write project files under the workspace, use temporary storage under `/tmp`, and not require root privileges. The execution environment has network access; package installation and image pulls can fail because of registry availability or connectivity.

Command output is captured in per-step files under the container's `/tmp`. Reports include the last 64 KiB of each step's combined standard output and standard error; they are not complete logs. The text report prints failed-step output, while JSON includes the captured output for every step. Log files share the bounded temporary storage, so a very noisy command can exhaust it. Raw output is not redacted.

## Interpretation

A passing check verifies only the configured path and expectation. Without `expect.http`, it means the selected setup commands exited successfully; it does not verify a running application. With an HTTP expectation, it also means the selected endpoint returned the expected status within the readiness limit. A response status does not establish that every page or feature works. Choose an endpoint that gives useful evidence the application is ready.

Docker, package registries, and base-image changes can affect results. Pin image digests and dependency lockfiles when you need stronger reproducibility.

See [SECURITY.md](../SECURITY.md) before running external repositories or adding the check to CI.
