# Tag-triggered npm publishing via Trusted Publishing

Date: 2026-11-24

## Decision

`@erzhe/harness-kit` is published by `.github/workflows/publish.yml`, not from a laptop. Pushing a `v<version>` tag runs: tag == `package.json` version check, refuse if that version is already on npm, `pnpm install --frozen-lockfile`, typecheck, test, build, a bundled-CLI `--version` smoke test, `npm publish --provenance`, then a GitHub Release with generated notes. Versions containing `-` go to the `next` dist-tag and are marked prerelease; everything else goes to `latest`.

Auth is npm Trusted Publishing (OIDC). There is no `NPM_TOKEN` secret to rotate. The package owner must register `reunion-labs/harness-kit` + `publish.yml` as a trusted publisher on npmjs.com; renaming the workflow file or moving the repository breaks publishing until that registration is updated. Provenance also requires `package.json` `repository.url` to point at the publishing repository.

## Release steps

1. Bump `package.json` version in a PR (plus `upgrade` migrations / lock if the release needs them) and merge it.
2. `git tag v<version> <merge-commit> && git push origin v<version>`.
3. Check the Publish workflow run; the GitHub Release is created only after npm publish succeeds.

The CI toolchain is pinned to pnpm 9 (lockfile v9); pnpm 8 cannot read the lockfile.
