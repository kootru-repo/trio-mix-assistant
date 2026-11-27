# 0004. Emulator first

- Status: Accepted
- Date: 2026-11-26

## Context

Few contributors own an M32C or X32. Testing against a real console is slow, and risky with the PA on. Most changes still need to be checked against the console protocol.

## Decision

Build and test against a desk emulator first. Treat the real console as a later confirmation.

- `EmulatedDesk` (`src/core/emulator.ts`) speaks the OSC protocol over the same `UdpFactory` as the real link. It serves the parameter tree from `app/x32_default_nodes.scn`, answers reads, sends meters and can make external fader moves.
- `--emulate` runs the full hardware stack against it. `--rehearse` does the same with the user's `show.conf`. Mixing Station can connect to it.
- Tests run it over `MemNetwork` or real sockets. The in-app full test marks each row as proven on the "real console", the "emulator" or "this computer" (`VetProof` in `src/core/vet.ts`).

## Consequences

- Anyone can work on the app with no hardware.
- The emulator can be wrong where the console's behaviour is only guessed. `app/HARDWARE_BRINGUP.md` lists what still needs a real console. Plan item #2 adds contract tests recorded from one.
- A change to the wire format should change the emulator and its tests in the same commit.
