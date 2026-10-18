# Contributing to FreshClone

Thanks for helping make project setup easier to trust. Documentation improvements, small examples, diagnostics, tests, and bug reports are all useful contributions.

This is an early project. The API and configuration format may change before a stable release. Keep proposals focused and explain the contributor problem they solve.

## Get started

1. Fork the repository and clone your fork.
2. Install Node.js 22 or newer and npm; Node.js 24 is recommended.
3. Run `npm ci` and `npm run build`.
4. Create a branch for your change.

```sh
git clone https://github.com/YOUR-USERNAME/freshclone.git
cd freshclone
npm ci
npm run build
git switch -c improve-setup-report
```

Use `node dist/src/cli.js --help` to explore the CLI. You can preview the example without Docker:

```sh
node dist/src/cli.js plan --root examples/hello-node
```

To exercise the container runner, start a Docker daemon configured for Linux containers and run:

```sh
node dist/src/cli.js check --root examples/hello-node
```

The first run may need to pull the configured image from the registry.

## Find work

- Browse the [issue tracker](https://github.com/ergishasani/freshclone/issues).
- Look for a small, well-scoped task whose expected behavior you can reproduce.
- Comment if you intend to work on an issue, to help avoid duplicate efforts.
- Open an issue before a major feature, new dependency, or configuration change.

An unassigned issue is not a guarantee of acceptance. A clear problem statement and small pull request make review easier.

## Development checks

```sh
npm test
npm run check
npm run build
```

`npm run check` runs the type checker, formatting checks, and tests. If it reports formatting differences, run `npm run format`, then rerun the check.

Add a focused test when changing command selection, validation, file copying, HTTP checks, or process handling. Tests should demonstrate a real failure or user-visible behavior. Documentation-only changes usually do not need new tests.

For runner changes, also run the bundled example with Docker and include the outcome in your pull request. If Docker is unavailable, say so clearly; do not report that a container check passed.

## Pull requests

Keep one clear purpose per pull request. Describe:

- The problem and the resulting behavior.
- The relevant issue, if there is one.
- The checks you ran and any checks you could not run.
- Configuration changes, compatibility concerns, or execution risks.

Update documentation when behavior changes. Do not commit generated build output, credentials, local `.env` files, or dependency folders. Review command output and fixtures for private data before sharing them.

All contributions are made under the repository's [MIT License](LICENSE). A separate contributor license agreement is not required. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Maintainer review

Maintainers review correctness, clarity, test coverage appropriate to the change, and whether the change fits the project scope. Feedback may require narrowing an otherwise useful proposal.

Use ordinary `pull_request` workflows for contributed code. Do not introduce a privileged trigger such as `pull_request_target` to execute a contributor's branch, and do not expose repository secrets to setup checks. See [SECURITY.md](SECURITY.md).

## Report a problem

Use the bug-report form for ordinary bugs. Include the FreshClone version, Node.js version, operating system, Docker version if relevant, configuration, marked README blocks, and a minimal reproduction. Remove secrets from logs before posting.

For a suspected vulnerability, use the private reporting channel in [SECURITY.md](SECURITY.md), not a public issue.
