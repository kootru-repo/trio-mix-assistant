# 0006. Job units sharing one state object

- Status: Accepted
- Date: 2026-11-26

## Context

The assistant used to be one large class. Each job (feedback, clip, ride and so on) was hard to test alone. The jobs also need the same facts: each fader and gain, when a channel was last moved, and which jobs are on.

## Decision

Each job is its own unit. All units share one `JobContext` (`src/core/assistant/context.ts`).

- The units are `FeedbackJob`, `ClipJob`, `RideJob`, `RoomModel`, `StageJob`, `PhaseJob` and `UnmaskJob`, plus `Coach`.
- `JobContext` holds the config, a narrow `MixerPort` for console writes, one `MixState`, and the `emit` and `recommend` callbacks.
- `MixAssistant` (`src/core/assistant/core.ts`) builds the context once and composes the units. It keeps the old public API.

## Consequences

- Each unit can be tested with a fake `MixerPort` and its own `MixState` (`test/jobhelpers.ts`, `test/assistant-*.test.ts`).
- The job files import only `context.ts` from the assistant folder, not each other. They see each other's effects through the shared state.
- The shared state is mutable. A unit that writes a field changes what the others see on the next block, so changes to `MixState` need care.
- All of this runs on the main thread, so there are no races on the state (see 0010).
