# Release and package checks

Version 0.2.0 is prepared in source; it has not been published by this change. Until a maintainer publishes it, use a source checkout or local tarball. No npm credentials are stored in the repository.

## Validate the package locally

```sh
npm ci --ignore-scripts
npm run check
npm pack --dry-run
npm run package:check
npm pack
```

`prepack` builds the CLI. The allowlist includes compiled CLI modules/declarations, both runtime helpers, configuration/release documentation, README, and license. Tests, outreach files, local environment files, and source checkouts are excluded. `freshclone --version` reads package metadata, avoiding a separate hardcoded CLI version.

Install the generated tarball in a temporary project to test the packaged binary, including `plan` and `doctor`. The executable is `freshclone`; the package name is `@ergishasani/freshclone`.

`npm run package:check` builds and installs the exact tarball in a temporary directory, verifies its file allowlist, executable, version and Python plan, then removes the temporary installation. With `FRESHCLONE_DOCKER_TESTS=1`, it also runs a real Docker check through the installed CLI; the CI Docker job enables this.

## Publish a reviewed release

1. Run quality checks and the Docker integration suite on Linux. The CI Docker job runs `FRESHCLONE_DOCKER_TESTS=1 npm run test:integration`, plus bundled examples and the composite Action.
2. Review package contents with `npm pack --dry-run`. Update package and lockfile versions together and record changes in CHANGELOG.md.
3. Create a reviewed immutable `v<package-version>` tag through the repository's normal release process. This workflow does not create tags or releases.
4. Set up the npm package and configure its trusted publisher for owner `ergishasani`, repository `freshclone`, workflow `release.yml`, and environment `npm-release`. Configure required reviewers on that GitHub environment. Follow npm's initial-publication process if the package does not yet exist.
5. Run the **npm release** workflow manually. Its default is validation only. Select the matching version tag and explicitly enable the publish input only when ready.

The publish job uses GitHub OIDC with `id-token: write`, not a saved npm token. It requires npm 11.5.1 or newer and Node 22.14 or newer; the workflow uses Node 24 and checks npm before publishing. Its separate validation job checks types, formatting, tests, package contents, and the selected tag/version. See [npm's trusted publisher documentation](https://docs.npmjs.com/trusted-publishers/) for account setup and current requirements.

After publication, users can install with `npm install --global @ergishasani/freshclone` or invoke `npx --package @ergishasani/freshclone freshclone --help`. Do not advertise a registry version until it exists.
