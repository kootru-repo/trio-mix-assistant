# Trio Mix-Assistant in TypeScript

This is the application. It began as a Python program; that original is **obsolete**, was removed from
the working tree on 2026-11-21 and survives only as the zip in [`../../archive`](../../archive/README.md)
(also in git history at commit `4094d6c`). Do not build on it.

Node 22 or newer is the only requirement. The runtime has no npm dependencies; `typescript` and
`@types/node` are needed only to build and check.

## Layout

| Folder | Holds | Rule |
|---|---|---|
| `src/core` | Signal processing, console protocol, the four jobs, coach mode, calibration, show flow, the engine and its telemetry, the desk emulator, the QR encoder, device-capture logic | No platform APIs. `tsconfig.core.json` compiles it with no DOM and no Node types, so `setTimeout`, `Buffer` or `node:*` fail the build. Time, randomness and networking arrive through `Clock`, `Rng` and `UdpFactory`. |
| `src/host` | Node bindings: UDP, HTTP/WebSocket server, TLS certificates, SQLite session log, advisor, command line | Everything that touches the operating system |
| `test` | Tests, run directly by Node | |
| `fixtures` | JSON recorded from the archived Python original | Committed; the tests need no Python |
| `tools` | The packager (`package.ts`) | |

The point of the split is a later phone app: `core` can run unchanged inside a React Native or
Capacitor shell, with a new host in place of `src/host`.

## Commands

```
npm install
npm run check      # type-check core, then everything
npm test           # all tests
npm run build      # emit JavaScript to dist/
```

## How behaviour is kept identical

Every module was checked against fixtures recorded from the Python original, not against hand-written
expectations. The fixtures in `fixtures/` are committed, so the tests need no Python:

- Signal processing, scaling tables and OSC datagrams are compared number for number and byte for
  byte (including against `python-osc`).
- `SeededRng` reproduces numpy's `default_rng` stream exactly (PCG64 with numpy's seeding and
  ziggurat tables), so the simulator generates the same audio as Python for the same seed.
- The assistant and the engine are replayed through scripted runs recorded from Python on a manual
  clock: every event, coach recommendation and telemetry value must match.

The recorder scripts (`record_*.py`) are in the archive with the Python they import. A fixture should
only change if the intended behaviour changes; then edit the expected value deliberately, with the reason in the commit.

## What is not verified

- Live audio input needs a native audio module that is not a dependency (see
  `src/host/audiodevice.ts`). The logic around it is tested with a fake stream; the adapter has not
  run against real hardware.
- Nothing here has driven a real M32C or X32. Follow `../HARDWARE_BRINGUP.md` before a show.
