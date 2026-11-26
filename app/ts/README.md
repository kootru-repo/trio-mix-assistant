# Trio Mix-Assistant

The application: Node 22.13 or newer is the only requirement. The runtime has no required npm dependencies (the audio module `naudiodon2` is optional);
`typescript` and `@types/node` are needed only to build and check.

## Layout

| Folder | Holds | Rule |
|---|---|---|
| `src/core` | Signal processing, console protocol, the six jobs, coach mode, calibration, show flow, the engine and its telemetry, the desk emulator, the QR encoder, device-capture logic | No platform APIs. `tsconfig.core.json` compiles it with no DOM and no Node types, so `setTimeout`, `Buffer` or `node:*` fail the build. Time, randomness and networking arrive through `Clock`, `Rng` and `UdpFactory`. |
| `src/host` | Node bindings: UDP, HTTP/WebSocket server, TLS certificates, SQLite session log, command line | Everything that touches the operating system |
| `test` | Tests, run directly by Node | |
| `fixtures` | Recorded reference data the tests compare against | Committed |
| `tools` | The packager (`package.ts`) | |

The point of the split is a later phone app: `core` can run unchanged inside a React Native or
Capacitor shell, with a new host in place of `src/host`.

## Commands

```
npm install
npm run check      # type-check core, then everything
npm run lint       # Biome lint plus the project rules
npm test           # all tests
npm run build      # emit JavaScript to dist/js
npm run start      # reads show.conf, like start.bat
npm run run        # the command line (see --help)
npm run package    # build dist/package/TrioMixAssistant.zip
```

## How behaviour is checked

Tests compare against stored reference data in `fixtures/` rather than hand-written expectations:

- Signal processing, scaling tables and OSC datagrams are compared number for number and byte for byte.
- `SeededRng` is a PCG64 generator with a published seeding and ziggurat scheme, so a fixed seed gives
  the same simulated audio every run, and the same audio as the recorded runs.
- The assistant and the engine are replayed through scripted runs on a manual clock: every event,
  coach recommendation and telemetry value must match the recording.

A fixture should only change when the intended behaviour changes; edit the expected value
deliberately and give the reason in the commit.

## What is not verified

- Live audio input needs the optional native audio module `naudiodon2` (see
  `src/host/audiodevice.ts`). The logic around it is tested with a fake stream; the adapter has run
  on a real one- and two-channel Windows input, but not on a Mac or on a console's multichannel USB feed.
- Nothing here has driven a real M32C or X32. Follow `../HARDWARE_BRINGUP.md` before a show.
