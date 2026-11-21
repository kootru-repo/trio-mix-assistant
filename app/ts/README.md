# Trio Mix-Assistant in TypeScript

A TypeScript port of the Python application in [`../trio_mix`](../trio_mix). The Python stays the
reference until a real show has run on the TypeScript build.

Node 22 or newer is the only requirement. The runtime has no npm dependencies; `typescript` and
`@types/node` are needed only to build and check.

## Layout

| Folder | Holds | Rule |
|---|---|---|
| `src/core` | Signal processing, console protocol, the four jobs, coach mode, calibration, show flow, the engine and its telemetry, the desk emulator, the QR encoder, device-capture logic | No platform APIs. `tsconfig.core.json` compiles it with no DOM and no Node types, so `setTimeout`, `Buffer` or `node:*` fail the build. Time, randomness and networking arrive through `Clock`, `Rng` and `UdpFactory`. |
| `src/host` | Node bindings: UDP, HTTP/WebSocket server, TLS certificates, SQLite session log, advisor, command line | Everything that touches the operating system |
| `test` | Tests, run directly by Node | |
| `fixtures` | JSON recorded from the Python reference | Regenerate with the scripts in `tools` |
| `tools` | Python recorders | They import the reference and write `fixtures/` |

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

Every module is checked against fixtures recorded from the Python code, not against hand-written
expectations:

- Signal processing, scaling tables and OSC datagrams are compared number for number and byte for
  byte (including against `python-osc`).
- `SeededRng` reproduces numpy's `default_rng` stream exactly (PCG64 with numpy's seeding and
  ziggurat tables), so the simulator generates the same audio as Python for the same seed.
- The assistant and the engine are replayed through scripted runs recorded from Python on a manual
  clock: every event, coach recommendation and telemetry value must match.

To refresh the fixtures after changing the Python reference, run each `tools/record_*.py` from
`app/ts/tools`, then `npm test`.

## What is not verified

- Live audio input needs a native audio module that is not a dependency (see
  `src/host/audiodevice.ts`). The logic around it is tested with a fake stream; the adapter has not
  run against real hardware.
- Nothing here has driven a real M32C or X32. Follow `../HARDWARE_BRINGUP.md` before a show.
