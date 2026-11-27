# 0009. The full test pins defaults

- Status: Accepted
- Date: 2026-11-26

## Context

The in-app full test ("Run full test", `vetSequence` in `src/core/vet.ts`) drives real engines through feature sequences and checks the results. If a user had tuned a threshold, a step could fail or pass for the wrong reason. Two users' reports would not be comparable.

## Decision

The full test runs on default tuning and a fixed channel map, then puts the user's settings back.

- `vetSequence` builds its own config with `vetConfig()` (defaults plus `VET_MAP`) and its own console on the test's link. It never touches the live config (0017).
- The rest of the full test runs on a private copy of the live config (`copyConfig` in `runVet`).
- The report lists the user's overrides (`tuningLines(cfg.TUNED)` in `src/host/vet.ts`), so the reader knows the live app runs with them.

## Consequences

- A full test result means the same thing on every machine.
- It does not prove that the user's tuned values are safe. Range checks (0008) cover that.
- Until plan item #5 the pinning changed the shared config (0007) and could leak into the live app while the test ran. Since 0017 the full test has its own config, and `test/vet-isolation.test.ts` checks that the live config and engine are untouched during and after a run.
