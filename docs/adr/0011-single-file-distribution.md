# 0011. Single-file distribution

- Status: Accepted
- Date: 2026-11-26

## Context

The users are musicians, not developers. Asking them to install Node.js and run commands is a barrier.

## Decision

Ship one executable per platform, built as a Node.js single executable application.

- `tools/package.ts` builds the app folder: the compiled JavaScript, the dashboard, `show.conf`, templates and docs.
- `tools/sea.ts` stages the native audio module (`naudiodon2`) and checks that it loads. It writes a manifest with a SHA-256 for every file, builds the blob with `--experimental-sea-config`, and injects it with `postject`. On macOS it re-signs the result ad hoc.
- At start, `tools/sea-boot.cts` unpacks the files to `runtime/<manifest id>` in the per-user folder and checks each hash. It seeds `show.conf` and the templates, then loads the app.
- The Node.js and PortAudio licence texts ship with the executable.

## Consequences

- One download, no install. There are three builds: macOS arm64, macOS x64 and Windows x64 (see 0015).
- The app is not signed by a registered developer, so macOS and Windows warn on first run.
- A damaged unpacked file is found by its hash.
- The native audio module ties each build to one platform, so CI builds each on its own runner.
