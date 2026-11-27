# 0010. Audio in a worker thread

- Status: Accepted
- Date: 2026-11-26

## Context

Audio arrives in blocks every few tens of milliseconds. The main thread also serves the dashboard, talks to the console and writes the session log. A slow phone or a busy server must not make the app miss audio.

## Decision

Capture and analysis run on their own worker thread. The engine and all its state stay on the main thread.

- `src/host/capturethread.ts` starts `src/host/audioworker.ts` with `node:worker_threads`.
- In the worker, `CaptureHost` (`src/core/capturelink.ts`) reads the device and analyses each block once. It posts one message per block with the features and a time stamp.
- On the main thread, `RemoteCapture` receives the blocks. A block older than 0.25 s (`STALE_S`) is counted and dropped, so a backlog cannot fire a burst of fader moves.
- The two threads share no memory. They only send messages. The worker gets its settings in the `open` message.
- The simulator has no device and is still stepped by the engine's timer.

## Consequences

- The main thread owns all mutable state, so there are no data races (see 0006).
- Block age compares wall-clock-based stamps (`threadStamp` in `src/host/clock.ts`) taken on two threads. If the wall clock steps back, the app can go deaf with no alert. The plan lists this as problem 5.
- The worker has its own copy of the shared config, so it must be sent the measurement channel and tuning in the `open` message (0007).
