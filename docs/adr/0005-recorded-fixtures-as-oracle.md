# 0005. Recorded fixtures as the oracle

- Status: Accepted
- Date: 2026-11-26

## Context

The app was ported from a Python reference to TypeScript (commit `b9b584c` and the two after it). The port had to give the same numbers and the same datagrams. Later refactors must keep the behaviour unless a change is meant.

## Decision

Tests compare against recorded reference data in `fixtures/*.json`.

- The first fixtures (`dsp`, `osc`, `rng` and others) were recorded from the Python reference. That recorder is no longer in the tree.
- `fixture(name)` in `test/helpers.ts` loads a file. `close` and `closeArray` compare numbers within a stated tolerance.
- `assistant`, `engine` and `osc` can be re-recorded. With `RECORD_FIXTURES=1` their tests call `saveFixture(name, data)`, which writes `fixtures/<name>.json`.
- A re-recording is a behaviour change. Every diff is reviewed as an intended change and named in the commit message.

## Consequences

- A refactor that changes a decision, a datagram or a snapshot field fails a test.
- Adding a snapshot field means re-recording `engine.json`.
- The DSP and RNG fixtures cannot be re-recorded with the current tools. A change there needs a new recorder or a hand-checked update.
