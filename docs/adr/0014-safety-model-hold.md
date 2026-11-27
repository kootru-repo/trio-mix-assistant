# 0014. Safety model: HOLD, read-back, link watch, write budget, hand moves win

- Status: Accepted
- Date: 2026-11-26

## Context

A review found that the app could jump the desk on its first move, keep riding blind when the console link dropped, run a burst of catch-up steps after sleep, and fight a hand on the fader. These are problems 1 to 4 in `docs/plans/architecture-remediation.md`. Plan item #1 set out a safety model. Commits `f927d27` and `289f7cc` built most of it.

## Decision

There are two safe states.

- **HOLD**: the app enters it by itself. It cancels ramps, stops the automatic jobs, releases the unmask dip and never mutes. Manual controls and TAKEOVER still work.
- **TAKEOVER**: the operator's button. It mutes the main.

The rule: the console keeping its last values is safe. Muting the PA because of a software fault is not.

The parts:

- **`EngineHold`** (`src/core/engine/hold.ts`) keeps a set of reasons: `unsynced`, `link`, `no-feedback`, `resume`, `write-storm` and `internal-error`. Each has an alert text. `write-storm` and `internal-error` re-arm only when TAKEOVER is pressed and released. `unsynced`, `link` and `resume` clear by themselves once the desk has been read and the link is steady. `no-feedback` (the reply port could not open) lasts until the app restarts.
- **`ConsoleSync`** (`src/core/consolesync.ts`) reads each channel's fader, headamp gain and polarity. The engine starts in `unsynced` and adopts the values before it re-arms. Nominal gain comes from the first read only. A failed read stays held and retries.
- **`LinkWatch`** (`src/core/linkwatch.ts`) tracks console traffic: waiting, up, stale (1.5 s quiet) and down (5 s). Stale or down holds with `link`. When the link is back and steady for 1 s, the desk is read again.
- **Wake-up**: `TickScheduler` and `WallWatch` (`src/core/scheduler.ts`) spot a long gap or a wall-clock jump. The engine runs no catch-up steps. It holds with `resume`, resubscribes and reads the desk again.
- **`WriteGovernor`** (`src/core/writegov.ts`) sits in `OscConsole`, the network console, between each write and the socket. `ConsoleBase.withLane` tags each write with a lane. The lanes are `safety` (uncapped, for TAKEOVER's mute and desk reads), `manual` at 100/s and `auto` at 150/s, with 250/s in total. Over budget, writes merge to the latest value per address. Repeats within 1 s are skipped. An automatic backlog that lasts 2 s holds with `write-storm`.
- **`OutsideEdits`** (`src/core/outsideedits.ts`): a console fader value within 0.3 dB of one the app wrote in the last 2 s is an echo. Anything else is a hand move. A hand move cancels that channel's ramp and is adopted. Three hand moves in 60 s lock the automatic jobs off that channel until TAKEOVER is pressed and released.
- **Ramps and EQ** (`src/core/console.ts`): a ramp that starts late or stalls stops, and the belief is set to the last value sent. EQ bands are written gain-first on a cut and gain-last on a boost, so a cut-off stream never leaves a boost.
- **Process**: an uncaught error calls `fault()` and holds with `internal-error`. The dashboard stays up. A second Ctrl+C quits at once.
- The numbers live in the `link` and `safety` config sections. All of `link` is tunable (0008). Only some of `safety` is: the lane rates, the echo tolerance, the lock rule and the command cap.

## Consequences

- The first automatic move happens only after the desk has been read.
- The `unsynced`, `link` and `resume` holds apply only when a meter receiver is running, so simulation never enters them. Hold ticks are skipped while the full test runs. `internal-error` can happen in any mode.
- There is no `audio` hold reason yet. Plan step 7 (audio failure) and the unclean-stop banner are still to do.
- This is proven against the emulator and fakes only. The real console's safe write rate, echo behaviour and reply times still need checking (plan #1, "Needs a real console").
