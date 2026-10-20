# Security

## Supported versions

FreshClone is in early development. Security fixes target `main` and the latest `0.1.x` release, currently `v0.1.0`. The CLI and configuration API may change before a stable `1.0` release. There are no long-term support branches or published npm packages. When reporting a problem, include the commit or version you tested.

## Repository and release protections

Changes to `main` require a pull request, successful checks on an up-to-date branch, a linear history, and resolved review conversations. All files have a maintainer code owner, and contributor changes require maintainer approval. Repository administrators can bypass review requirements only through a pull request, so the sole maintainer can merge their own changes after CI passes. Separate rules enforce CI and prevent direct pushes, force pushes, and deletion of `main`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the required checks and review process.

Version tags matching `v*` cannot be moved or deleted. Releases are maintainer-controlled, and fixes use new version tags rather than changing an existing release tag.

## Report a vulnerability privately

Use [GitHub's private vulnerability reporting form](https://github.com/ergishasani/freshclone/security/advisories/new). Do not publish exploit details, credentials, or sensitive logs in a public issue.

If the form is unavailable, request a private security contact using a contact method listed on the [maintainer's GitHub profile](https://github.com/ergishasani). Please give maintainers a reasonable opportunity to investigate before publishing details. There is no guaranteed response time or paid bounty program.

A useful report includes the affected version or commit, environment, impact, a minimal reproduction, and any suggested mitigation. Use test credentials and synthetic data wherever possible.

## Execution model and limits

FreshClone intentionally runs shell commands controlled by a repository. A successful check says that the selected instructions completed and the configured application check passed in the chosen environment. It does not establish that the repository or its dependencies are safe.

- Run checks only for repositories you trust.
- Docker is a disposable execution environment, not a guarantee of isolation from hostile workloads.
- The Docker daemon has authority on its host. Use appropriate host and runner isolation for your environment.
- FreshClone does not inject host credentials, host environment variables, or the Docker socket into application/service containers. Explicit configuration `env` values are passed to the application shell or named service; use synthetic test data.
- Git-tracked current working-tree files are copied into temporary storage for execution. `.env` and `.env.*` files are excluded except for `.env.example`, `.env.sample`, and `.env.template`. This filename filter is not secret scanning: credentials in other tracked files or example files are still copied.
- Symbolic links in the execution snapshot are rejected to avoid copying through unexpected paths.
- Application commands can access the network and download dependencies. The initial release does not provide network isolation.
- Optional services run on a unique bridge network without published host ports or host directory mounts. Their filesystems remain writable for database initialization; anonymous image volumes are removed with their containers. Each service has 512 MiB memory, one CPU, 256 processes, and no-new-privileges. TCP readiness verifies connectivity, not authentication or database integrity.
- The application container has a read-only root filesystem, a writable temporary workspace, a bounded `/tmp`, dropped capabilities, and limits of 1 GiB memory, two CPUs, and 256 processes. These defaults reduce resource consumption; they do not establish a hostile-code sandbox.
- Logs are raw application output and may contain credentials, private paths, or sensitive project data. Reports keep only the last 64 KiB per step, while per-step capture files use the container's bounded temporary storage. Review logs and JSON output before publishing them; no automatic redaction is performed.
- README commands, image references, configuration, and dependencies are all part of the code you must review.

Temporary file copying protects the source checkout from ordinary changes made by setup commands. It does not turn Docker into a safe environment for arbitrary untrusted code.

## GitHub Actions guidance

Use an ordinary `pull_request` workflow for contributor changes, with minimal permissions and no repository secrets passed to setup checks. Never use a privileged event such as `pull_request_target` to check out and run commands from a contributor's branch.

The repository's default workflow token is read-only, and GitHub Actions is not allowed to create or approve pull requests. Workflows from outside contributors require maintainer approval before they run. That approval permits execution; it does not approve merging the contribution.

Review workflow changes carefully. Avoid privileged containers, mounting host directories, exposing the Docker socket to the application, or making self-hosted runners available to untrusted contributors.

Pin third-party Actions to reviewed commit SHAs when adopting the project in a production workflow. Image tags can change; use a reviewed image digest when reproducibility or your threat model requires it.
