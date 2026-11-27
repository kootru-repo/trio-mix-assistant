# 0018. CI and releases run in Trust Ratchet's reusable workflows

- Status: Accepted
- Date: 2026-11-27
- Amends: [0015](0015-ci-gate-and-releases.md)

## Context

The gate and release workflows of 0015 were proven here and then made generic in Trust Ratchet (release v0.2.0), so other projects can call them instead of copying them. Keeping trio's own copies would mean fixing the same workflow in two places.

## Decision

**Gate.** `.github/workflows/ci.yml` calls Trust Ratchet's `gate.yml`, pinned to the commit of v0.2.0 (`d3d05c6`), twice:

- Node 22 on Windows, Linux and both macOS runners, with lint, type check and tests.
- Node 22.13 on Windows and Linux, with type check and tests.

The `dashboard` job and the `mac-app` build (the macOS downloads between releases) stay in trio's file. `ci-ok` stays in trio's file too, because the ruleset requires it by name. It passes only when both gate calls, `dashboard` and `mac-app` pass. The ruleset and the flow of 0015 are unchanged.

**Releases.** `.github/workflows/release.yml` calls Trust Ratchet's `release.yml` at the same commit, with `rebuild-in-place: true`.

- The reusable workflow:
  - refuses a tag whose commit has no passing `ci-ok` from GitHub Actions;
  - checks the version;
  - writes `SHA256SUMS.txt` and attests the files;
  - removes release files this build does not make;
  - downloads the files again and checks the sums.
- Trio's build command keeps its own checks: the tag must match `package.json`, the exe is stamped with the commit, and the Node licence text must be present. The version command checks the reported commit as well as the version.
- Run by hand with "rehearse" to build and check everything at a branch without publishing.

**Agent turn checks.** The hand-written Trust Ratchet checks for line endings, recorded fixtures and the committed dashboard JavaScript are now its built-in checks (`builtin:lf`, `builtin:protected`, `builtin:generated`). They live in the local Ratchet configuration, not in this tree. `tools/guard.ts` stays: it is the lint gate CI runs for anyone, while Ratchet's checks run only at an agent's turn end.

## Consequences

- A fix to the gate or the release comes from a new Trust Ratchet release and a new pin here, never from a copy edited in place.
- The pinned commit is the trust boundary. Moving it is a reviewed change to these two files.
- Release titles made from now on include the "v" of the tag. Releases rebuilt in place keep their title.
