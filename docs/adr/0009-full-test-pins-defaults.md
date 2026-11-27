# 0009. The full test pins defaults

- Status: Accepted
- Date: 2026-11-26

## Context

The in-app full test ("Run full test", `vetSequence` in `src/core/vet.ts`) drives real engines through feature sequences and checks the results. If a user had tuned a threshold, a step could fail or pass for the wrong reason. Two users' reports would not be comparable.

## Decision

The full test runs on default tuning and a fixed channel map, then puts the user's settings back.

- `vetSequence` saves the channel map, applies its own `VET_MAP`, and calls `pinDefaultTuning()`.
- A `finally` block restores the channel map and the user's tuning.
- The report lists the user's overrides (`tuningLines()` in `src/host/vet.ts`), so the reader knows the live app runs with them.

## Consequences

- A full test result means the same thing on every machine.
- It does not prove that the user's tuned values are safe. Range checks (0008) cover that.
- The pinning works by changing the shared config (0007), so it can leak into the live app while the test runs. Plan item #5 gives the full test its own config.
