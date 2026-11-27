# 0017. Injected config: every module gets its config explicitly

- Status: Accepted
- Date: 2026-11-26
- Supersedes: [0007](0007-engine-on-shared-config.md)

## Context

Until now `src/core/config.ts` exported one shared, mutable config object, `C` (0007). Tuning (`setTuning`) and channel maps (`applyChannelMap`) changed it in place, and most modules read it directly.

That caused the plan's problem 6. The in-app full test swapped the shared channel map and pinned default tuning while the live engine kept running. A fader move on the live engine could follow the test's stereo links. If audio restarted during the test, the test's channel map was sent to the audio thread and stayed there.

## Decision

There is no shared config. Every module receives a `Config` and reads only that one.

- `config.ts` exports `defaultConfig()`, `configWith(over)` and `copyConfig(cfg)`. The channel-map helpers (`applyChannelMap`, `autoChannelMap`, `channelMapState`, `restoreChannelMapState`) take an explicit target.
- `withTuning(base, overrides)` in `src/core/tuning.ts` returns a new config with frozen tuning sections. The config records its overrides in `TUNED`, which feeds the tuning report and the audio worker's `open` message.
- `src/host/main.ts` builds one config at start with `showConfig`: defaults, then the template's channel map, then the template's tuning and `--tune` (the later one wins). `--auto` (and the single-input fit in `--diagnose` and `--vet`) then fits its channel map to the input; `--channel-map` only sets the device columns handed to `RemoteCapture`. That one object goes to the engine, the consoles, `RemoteCapture`, `MeterReceiver`, `AbleSetReceiver`, the emulator, the dashboard's command limiter (through `engine.cfg`), the banner, the checks and the full test.
- `Engine` takes `cfg` and passes it to everything it builds: the assistant and its job units, `SimConsole`, `SimCapture`, `Calibrator`, `BlockAnalyser`, `perChannel` and the default template.
- The full test runs on a private copy of the live config. `vetSequence` builds its own config (`vetConfig()`: defaults plus `VET_MAP`) and its own console on the test's link. It never changes the live one.
- `tools/guard.ts` fails lint on any import of `C` from `config.ts` and on any `C.` read.

## Consequences

- The full test cannot leak into the live app. `test/vet-isolation.test.ts` checks the live channel map, tuning, `RemoteCapture` open message and engine behaviour during and after a run.
- Two engines with different configs can run side by side, so tests build their own config with `defaultConfig()` or `configWith()` and no longer save and restore global state.
- Tuning is fixed for the life of a config. Changing it means building a new config and new objects, which the app only does at start.
- A config is still a plain object, and the channel-map helpers change their target in place. Only `main` and the full test do this, before anything reads the config.
- Every constructor or function that reads config takes it as a required argument, so a missing one is a type error rather than a silent fall-back to defaults. The one exception is the pure maths in `src/core/dsp.ts`: its number parameters (sample rate, ring threshold, FFT size and so on) still default to the factory values from a private `defaultConfig()`. Every caller in `src` passes them explicitly.
- The only places that build a config from scratch are the roots: `main` (`showConfig`, `--diagnose`, `--vet`), the audio worker, the OSC demo and the full test's `vetConfig()`.
