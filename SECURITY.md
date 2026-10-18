# Security

## Supported versions

FreshClone is in early development. Security fixes are developed on `main`; published package releases and long-term support branches are not available yet. When reporting a problem, include the commit or version you tested.

## Report a vulnerability privately

Use [GitHub's private vulnerability reporting form](https://github.com/ergishasani/freshclone/security/advisories/new). Do not publish exploit details, credentials, or sensitive logs in a public issue.

If the form is unavailable, request a private security contact using a contact method listed on the [maintainer's GitHub profile](https://github.com/ergishasani). Please give maintainers a reasonable opportunity to investigate before publishing details. There is no guaranteed response time or paid bounty program.

A useful report includes the affected version or commit, environment, impact, a minimal reproduction, and any suggested mitigation. Use test credentials and synthetic data wherever possible.

## Execution model and limits

FreshClone intentionally runs shell commands controlled by a repository. A successful check says that the selected instructions completed and the configured application check passed in the chosen environment. It does not establish that the repository or its dependencies are safe.

- Run checks only for repositories you trust.
- Docker is a disposable execution environment, not a guarantee of isolation from hostile workloads.
- The Docker daemon has authority on its host. Use appropriate host and runner isolation for your environment.
- FreshClone does not inject host credentials, environment variables, or the Docker socket into the application container.
- Git-tracked current working-tree files are copied into temporary storage for execution. `.env` and `.env.*` files are excluded except for `.env.example`, `.env.sample`, and `.env.template`. This filename filter is not secret scanning: credentials in other tracked files or example files are still copied.
- Symbolic links in the execution snapshot are rejected to avoid copying through unexpected paths.
- Application commands can access the network and download dependencies. The initial release does not provide network isolation.
- The container has a read-only root filesystem, a writable temporary workspace, a bounded `/tmp`, dropped capabilities, and limits of 1 GiB memory, two CPUs, and 256 processes. These defaults reduce resource consumption; they do not establish a hostile-code sandbox.
- Logs are raw application output and may contain credentials, private paths, or sensitive project data. Reports keep only the last 64 KiB per step, while per-step capture files use the container's bounded temporary storage. Review logs and JSON output before publishing them; no automatic redaction is performed.
- README commands, image references, configuration, and dependencies are all part of the code you must review.

Temporary file copying protects the source checkout from ordinary changes made by setup commands. It does not turn Docker into a safe environment for arbitrary untrusted code.

## GitHub Actions guidance

Use an ordinary `pull_request` workflow for contributor changes, with minimal permissions and no repository secrets passed to setup checks. Never use a privileged event such as `pull_request_target` to check out and run commands from a contributor's branch.

Review workflow changes carefully. Avoid privileged containers, mounting host directories, exposing the Docker socket to the application, or making self-hosted runners available to untrusted contributors.

Pin third-party Actions to reviewed commit SHAs when adopting the project in a production workflow. Image tags can change; use a reviewed image digest when reproducibility or your threat model requires it.
