# 0007. Engine on the shared config, until plan item #5 replaces it

- Status: Accepted, to be superseded by plan item #5 (config injection) in `docs/plans/architecture-remediation.md`
- Date: 2026-11-26

## Context

`src/core/config.ts` exports one shared, mutable config object, `C`. Many modules read it directly: the engine, the DSP, capture, the emulator and others. `setTuning` and `applyChannelMap` change it in place.

Only `MixAssistant` already takes a config (its `config` option). It falls back to `C` when none is given.

## Decision

For now the engine and everything it builds keep reading the shared `C`. We do not thread a config through the engine until plan item #5 does it step by step.

## Consequences

- Tuning and channel maps reach every module with no plumbing.
- Tests and the in-app full test must save and restore `C` (`channelMapState`, `restoreChannelMapState`, `pinDefaultTuning`).
- The full test changes `C` while the live engine runs. If audio restarts during the test, the test's channel map can reach the audio thread. This is problem 6 in the plan, and #5 fixes it.
- The audio worker sets `C.MEAS_MIC_CH` and calls `setTuning` from its open message (`src/host/audioworker.ts`). Step 3 of #5 stops this.
- When #5 lands, a new record supersedes this one, and a guard test checks that nothing imports `C`.
