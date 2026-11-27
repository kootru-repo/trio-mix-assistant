# 0003. Platform-free core

- Status: Accepted
- Date: 2026-11-26

## Context

The logic must be testable with no audio device, no network and no real time. It should also be easy to run on another host later.

## Decision

`src/core` uses no platform APIs. Node bindings live in `src/host`.

- `tsconfig.core.json` compiles `src/core` with `"lib": ["ES2022"]` and `"types": []`. Any use of Node or DOM types fails the build. `npm run check` runs this config first.
- The core talks to the outside through small interfaces: `Clock` (`src/core/clock.ts`), `UdpFactory` and `UdpEndpoint` (`src/core/transport.ts`), and `AudioInputFactory` (`src/core/devicecapture.ts`).
- Tests use in-memory versions: `ManualClock`, `MemNetwork` (`src/core/memtransport.ts`) and timed or simulated audio.

## Consequences

- Most tests run fast and in one process, with fake time and a fake network.
- Bindings such as `src/host/udp.ts` and `src/host/clock.ts` stay thin. The decision logic is all in the core.
- A core module cannot read a file or open a socket. It must ask the host through an interface.
