# 0015. CI gate and CI-built releases

- Status: Accepted
- Date: 2026-11-26

## Context

`main` was protected but needed no checks to pass. Releases were built by hand on a laptop, and the app could not say which build it was. Plan items #4 and #3 cover this.

## Decision

**Gate.** One CI job decides what `main` accepts.

- `.github/workflows/ci.yml` runs on pushes to `main` and `dashboard-ts`. Its `ci-ok` job passes only when `lint`, `dashboard` and `typescript` all pass.
- The GitHub ruleset "main" on the default branch requires `ci-ok`, blocks force pushes and deletion, and allows no bypass. It is a repository setting, not a file in the tree.
- The flow: push `dashboard-ts`, wait for its `ci-ok`, then push the same commit to `main`.

**Releases.** CI builds every download.

- `app/ts/package.json` holds the version. The build stamps in the commit. `--version`, the banner, report headers and the dashboard show both.
- `.github/workflows/release.yml` runs on a `v*.*.*` tag, or by hand with a tag name. Its `gate` job refuses a tag whose commit has no passing `ci-ok`. It then checks that the tag matches `package.json` and builds macOS arm64, macOS x64 and Windows x64. Each build must report the tag's version and commit. It writes `SHA256SUMS.txt` and a build attestation, then checks the downloads against the sums.
- **In-place rebuilds.** If the release exists, its files are replaced (`gh release upload --clobber`). This is the owner's choice. A change that is not a new feature or a fix rebuilds the current version rather than adding a new one. v0.2.9 has been rebuilt this way.

## Consequences

- Nothing reaches `main` or a release without passing tests, type checks and lint.
- No laptop builds ship.
- Releases are not immutable and tags are not protected. A tag can be moved and its files rebuilt. The plan's immutability step and its owner-approval environment were not adopted.
- A download is traced by the commit it reports and its attestation, not by the version number alone.
