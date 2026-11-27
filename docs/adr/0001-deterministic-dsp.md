# 0001. Deterministic DSP

- Status: Accepted
- Date: 2026-11-26

## Context

The app moves a live console in front of an audience. The operator must be able to predict what it will do. A test must be able to replay a case and get the same answer. Learned models and hidden randomness make both hard.

## Decision

Every decision comes from plain signal processing and clamped controllers. There is no machine learning.

- `src/core/dsp.ts` and `src/core/fft.ts` compute the features (level, peak, ring frequency, contrast, harmonicity, phase) from the samples and the config (see 0007). They keep no hidden state between calls, except the explicit detector objects such as `RollingRingDetector`.
- Randomness, such as pink noise and the simulated room, comes only from `SeededRng` in `src/core/rng.ts` (PCG64 with a ziggurat normal). The caller passes the generator in. For example, `generatePinkNoise` takes an `Rng` argument.
- `src/core` does not call `Math.random`, `Date.now` or `performance.now`. Time comes from an injected `Clock` (`src/core/clock.ts`).

## Consequences

- The same input and seed give the same output, so tests compare against recorded values (see 0005).
- Coach mode can show the exact move the app would make, because it runs the same math.
- New features must keep to this. A feature that needs a learned model needs a new record.
