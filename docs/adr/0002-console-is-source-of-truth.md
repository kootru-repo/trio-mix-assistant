# 0002. The console is the source of truth

- Status: Accepted
- Date: 2026-11-26

## Context

The operator also mixes on the desk, or on a tablet with Mixing Station or X32-Edit. The app keeps a belief of each fader, preamp gain and polarity in `MixState` (`src/core/assistant/context.ts`). That belief starts at 0 dB fader and 20 dB gain. If the app trusted its own belief over the desk, it could undo a hand move or jump the desk.

## Decision

What the console says wins.

- Before the first automatic move, `ConsoleSync` (`src/core/consolesync.ts`) reads each channel's fader, headamp gain and polarity. The engine adopts the values (`adoptDesk` in `src/core/engine/hold.ts`). It reads again after a link drop, a wake-up, a scene recall and a finished full test.
- A fader move reported by the console is adopted (`reconcileFader` in `src/core/engine/controls.ts`). The vocal ride and balance then leave that channel alone for a while (`manual.holdS`).
- The app's own echoes are told apart from hand moves by value, not by time alone (`OutsideEdits`, see 0014).
- The app keeps no mix of its own to push back to the desk.

## Consequences

- A hand move always beats an automatic one.
- The automatic jobs wait at start until the desk has answered. See 0014 for what happens when it does not.
- The README says the same thing to users: the console is always in charge.
