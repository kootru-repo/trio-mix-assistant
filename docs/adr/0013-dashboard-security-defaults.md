# 0013. Dashboard security defaults

- Status: Accepted
- Date: 2026-11-26

## Context

The dashboard can move the console. When it listens on the LAN, anyone on that network could reach it. The server is written directly on `node:http` (`src/host/server.ts`), so it must defend itself.

## Decision

Safe by default. Opening up is explicit.

- The dashboard binds to 127.0.0.1 unless `--host` or `--lan` says otherwise.
- The server refuses to listen on a non-loopback address without a PIN (`requirePinOnLan` defaults to true), unless `--insecure-open` is given. A PIN must be at least 6 characters.
- Login sets a random token in an `HttpOnly; SameSite=Strict` cookie, marked `Secure` over TLS. PINs and tokens are compared in constant time (`safeEqual`). `LoginLimiter` locks out repeated failures.
- `hostAllowed` and `originAllowed` (`src/host/server/guards.ts`) reject unexpected Host and Origin headers.
- Every response sets a nonce-based Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff` and `no-referrer`.
- Bodies, WebSocket frames, connections, streams per address and request times are capped. JSON with NaN, Infinity or deep nesting is rejected.
- Commands are rate-limited per client, and (see 0014) to 100/s across all clients. Panic is exempt.
- HTTPS is opt-in (`--https`, or `--trust` with a local root CA). If it cannot be set up, the app serves http and says so.
- The page loads nothing from the internet.

## Consequences

- A fresh install is reachable only from the same computer.
- LAN use needs a PIN or a deliberate `--insecure-open`.
- Without `--https`, the PIN and cookie cross the LAN in clear text.
