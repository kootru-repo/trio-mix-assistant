# 0008. Tuning allowlist

- Status: Accepted
- Date: 2026-11-26

## Context

Users and venues need to adjust thresholds, such as how strong a ring must be before it is notched. Letting any constant be changed would let a typo or a bad value break the safety limits.

## Decision

Only settings on an explicit list can be tuned, each with a range.

- `TUNABLE` in `src/core/tuning.ts` lists each path (`section.name`), its minimum and maximum, and whether it must be a whole number.
- `checkedOverride` rejects an unknown path, a value that is not a number, a fraction where a whole number is needed, and a value out of range. It throws `TuningError`. A cross-check keeps `room.quietDb` below `room.loudDb`.
- Overrides come from a template's `"tuning"` block, then `TUNE.section.name = value` lines in `show.conf` (the launcher turns them into `--tune` arguments), then `--tune` on the command line. A later value wins.
- `--list-tuning` prints every setting with its default and range.
- Config sections are frozen. `withTuning(base, overrides)` returns a new config with the overrides merged over the base; nothing is changed in place (0017).

## Consequences

- Fader and gain limits, the maximum step and similar guardrails are not on the list, so a setting cannot loosen them.
- Adding a tunable needs a range and a test.
- A bad setting stops the app at start with a clear message instead of failing later.
