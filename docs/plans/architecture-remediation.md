# Architecture remediation plan

Status: proposed, 2026-11-26. Nothing here is built yet. It covers the ten gaps from the architecture review. Each item lists ordered steps that each leave the tests green, plus what needs a real console. Line references are to the working tree on 2026-11-26.

## Recommended order

| Order | Item | Why this order | Effort | Needs a console |
|---|---|---|---|---|
| 1 | #4 Review gate | Cheap. Protects everything after it | 0.5 day + owner settings | no |
| 2 | #3 Versioned CI releases | The app can't say which build it is. Releases have been rebuilt in place | 2 days | no |
| 3 | #6 Lint in CI | Machine-checks the project rules | 0.5–1 day | no |
| 4 | #1 Safety model, first part | Fixes the most serious gaps found (below) | 5–7 days | to confirm |
| 5 | #5 Config injection | Stops the in-app full test leaking into the live app. Prerequisite for clean safety tests | 4–5 days | no |
| 6 | #2 Hardware contract tests | Proves the emulator against a real console | 6 days + 45 min at a console | **yes** |
| 7 | #8 Timing checks | Removes the known flaky test first | 4 days | no |
| 8 | #7 Fuzz tests | Network input. Already found 3 cases that fail | 3 days | no |
| 9 | #9 Format versions | Old show.conf and templates keep working, typos are reported | 1.5 days | no |
| 10 | #10 Decision records | Writes down what's already decided | 1 day | no |

## Serious problems the planning turned up

These problems were found by reading the code and haven't been confirmed by a test. Fixing each one changes behaviour, so each one needs your go-ahead.

1. **The first automatic move after start can jump the desk.** The app believes every fader is at 0 dB and every preamp at 20 dB until the console says otherwise (`assistant/context.ts` `MixState`). It never reads them at start. So a fader at −10 dB could be ridden from 0 dB, and a 35 dB preamp trimmed to 18 dB.
2. **When the console link drops, the jobs keep going.** Ride keeps moving its belief with no feedback from the desk. When the link returns, the next ramp can jump by up to the full −12…+6 dB range. There's only a warning after 5 s (`engine/base.ts` alerts).
3. **After the laptop sleeps, the engine runs a burst of catch-up steps.** `Engine.run` never resets its schedule (`engine/core.ts:120-130`), so a 10-minute sleep means about 28,000 back-to-back steps. Old ramp timers also finish late (`console.ts:139-145`).
4. **The vocal ride fights a hand on the lead fader.** A console move within 0.8 s of the app's own move is treated as an echo and ignored (`engine/controls.ts:194`), and the ride moves every 0.25 s.
5. **The app can go deaf with no alert after the wall clock steps back.** Audio block age compares wall-clock stamps from two threads (`capturelink.ts:298`).
6. **The in-app full test leaks into the live app.** It swaps the global channel map while the live engine keeps running. If audio restarts during the test, the test's channel map is sent to the audio thread and stays there (`core/vet.ts:657`, `capturelink.ts:226-241`).
7. **Network input:**
   - A NaN fader value and an out-of-range channel number get past the meter receiver (`metersrv.ts`).
   - AbleSet can push NaN or ±Infinity for bpm and song index (`showclock.ts:115,181`).
   - Templates accept channel 0, −1 or 4000 (`template.ts:66-69`).
   - The app can't decode a real console's `node` replies (`oscwire.ts:125,199`).
8. **Releases and tags:**
   - `v0.2.9` is not immutable.
   - `main` is protected but needs no CI checks to pass.
   - Tags are unprotected, which is how `v0.2.9` could be moved.

## #1 Safety model

There are two safe states:
- **HOLD** (new): the app enters it itself. It cancels ramps, stops deciding, releases the unmask dip, never mutes, and re-arms after the console has been read again.
- **TAKEOVER** (existing): the operator's button; it mutes the main.

The rule: the console keeping its last values is safe; muting the PA because of a software fault is not.

Steps:
1. **Test fakes.**
   - A drop/partition filter in `MemNetwork`.
   - `EmulatedDesk.reboot()`.
   - `suspend()` and `jumpWall()` on the test clocks.
   - A recording sink.
2. **Ramp hardening in `ConsoleBase`.**
   - Drop a ramp that starts late; abort it on a stalled step.
   - Track the last value written and correct the belief on abort.
   - Write EQ parameters in a gain-safe order, so that a stream cut off part-way never leaves a boost.
3. **Write budget at `ConsoleBase.send`.**
   - Lanes: safety (uncapped), manual 100/s, automatic 150/s, total 250/s.
   - Over budget, writes merge (latest value per address) rather than drop.
   - Repeat writes within 1 s are skipped.
   - A backlog that lasts more than 2 s triggers HOLD("write-storm").
   - The numbers go in a new `safety.*` tuning section.
4. **Engine HOLD state.** It has reasons, appears in telemetry and the dashboard, and is separate from TAKEOVER.
5. **Console link watchdog and read-back (new `consolesync.ts`).**
   - STALE after 1.5 s of silence, which means HOLD.
   - At start, recovery, wake-up and scene recall, read back every address the app writes and adopt the values before re-arming.
   - **Startup is HOLD("unsynced") until the first read-back.** This fixes problem 1.
6. **Wake-up detection.** Reset the schedule on a gap of more than 1 s, HOLD("resume"), re-subscribe, then read back.
7. **Audio failure.** HOLD("audio") when capture is dead; block age measured without the wall clock; a mostly-stale capture counts as dead.
8. **Another editor on the desk.**
   - Recognise echoes by value, not time.
   - An outside move cancels that channel's ramp and holds the channel.
   - Three outside moves in 60 s lock automatic writes on that channel.
9. **Dashboard command cap.** 100/s in total, across all clients.
10. **Process level.**
    - An uncaught exception puts the engine in HOLD and keeps the dashboard up.
    - Orderly stop sequence.
    - A second Ctrl+C forces exit.
11. **(Optional) Banner after an unclean stop**, listing what the last run changed.
12. **Docs.** The failure-mode table goes in HARDWARE_BRINGUP; the RUNBOOK explains HOLD vs TAKEOVER.

Tests: one per failure, each injected with the fakes:
- the "every prefix of the datagram stream is safe" rule;
- crash, sleep and resume, a LAN drop mid-ramp, a console reboot with TAKEOVER on, another editor, audio death, a clock jump, a command flood, a write storm;
- a startup where the desk is not at the defaults.

Needs a real console:
- the safe write rate, read-back reply times and the meter rate;
- whether the console echoes the app's own writes;
- reboot behaviour and whether the mute survives it;
- Mixing Station running alongside the app;
- sleep on the show laptop;
- how long a TAKEOVER mute takes to confirm.

## #2 Hardware contract tests

1. **A recording wrapper** around the UDP factory, saving raw datagrams per full-test step.
2. **A structural scrubber and fixture format** (`fixtures/contract/<model>-<fw>.json`):
   - addresses become 192.0.2.1;
   - names are emptied;
   - model and firmware are kept;
   - a strict list of known differences between the real console and the emulator.
3. **`--vet-record FILE`** with a set of read probes:
   - info, xinfo, status, `node`, single reads, and a meter window;
   - the existing write steps;
   - a prompted move of a fader by hand;
   - an opt-in scene recall to a slot saved first.
4. **A synthetic fixture recorded from the emulator** (keeps the recorder working), and a replay test that checks both the emulator's replies and the app's handling of real replies.
5. **One capture session**, about 45 minutes per console with the PA off. It's described step by step in the agent plan.
6. **Sort out each difference**: either fix the emulator or list the difference. There are eight known guesses (H1–H8: meter size and alias, echoing the app's own writes, scene recall replies, value rounding, type tags, argument order, headamp index, subscription lifetime).

## #3 Versioned, traceable releases

1. **Version in the build (this is functional, so it would ship as 0.2.10):**
   - `version` goes in `app/ts/package.json`, and the commit is stamped in at build time.
   - `--version` flag.
   - The version shows in the banner, in every report (via the existing `App:` line in `diagnose.ts`) and in the dashboard header.
2. **CI builds Windows too**, and checks that `--version` matches the version in `package.json`.
3. **New `release.yml`, run on a `v*` tag:**
   - builds all three platforms, runs the tests and checks the version;
   - creates a draft release, uploads the files, `SHA256SUMS.txt` and a build attestation, then publishes;
   - publishing waits for the owner's approval through a `release` environment.
4. **Immutable releases.** Turn on release immutability and a tag ruleset. Policy: a published version is never rebuilt; every fix gets a new patch version. `v0.2.9` stays as it is.
5. **Signing (optional, costs money):**
   - Apple Developer ID and notarization: $99 a year. Needs entitlements for the microphone and the native audio module, and a `.dmg` to staple the ticket to.
   - SignPath Foundation for Windows: free for open source.
   - Azure Artifact Signing: available to individuals in the US or Canada only.

## #4 Review gate

- **CI on both branches.** CI also runs on `dashboard-ts`, and a single `ci-ok` job sums up the results; a docs-only fast path is optional.
- **`main` ruleset:** `ci-ok` must pass, no force pushes, no deletions, nobody can bypass it. Pull requests stay optional, and pushing `dashboard-ts` straight to `main` still works once CI is green on that commit.
- **Test it** with a deliberately failing push, then remove the old classic protection.
- **Releases:** the owner approves each one through the `release` environment.

## #5 Config injection

About 204 reads of the shared settings remain in the app code (143 setup, 61 tuning), plus 135 in tests.

Steps, each one green:
1. dsp parameters;
2. `analysisConfig(cfg)`, including the sample rate for the ring detector;
3. capture and audio worker get explicit options; the worker stops writing the shared settings;
4. consoles;
5. Calibrator;
6. emulator;
7. engine, threading the config into everything it builds;
8. ports, and `fromObject(d, channels)`;
9. `withTuning`, with main building one config at start;
10. **the full test gets its own config**, with a test that the live app is untouched (fixes problem 6);
11. delete the shared `C`, with a guard test that nothing imports it.

## #6 Lint in CI

- **Biome, as a dev dependency.** typescript-eslint doesn't support the project's TypeScript 7.
- **Rules that pass today:** `as any`, double casts, ts-ignore, focused or skipped tests, `==`, and an import ban on Effect.
- **A grep step** for comments and the remaining escape hatches.
- **Formatter:** measure the diff first. If it's small, do one formatting commit and add it to `.git-blame-ignore-revs`.

## #7 Fuzz tests

- **No new dependencies:** a small seeded generator and minimiser on `core/rng.ts`.
- **Targets:**
  - OSC decoding and meter blobs;
  - the meter receiver;
  - AbleSet input;
  - emulator requests;
  - `Engine.command`;
  - WebSocket frames and the JSON parser;
  - templates and `show.conf`.
- **Checks:** nothing throws unexpectedly, memory stays bounded, bad input is rejected without side effects, and decode→encode round trips.
- **Budget:** 2,000 cases per property in CI, plus a nightly run of 200,000. Every failure becomes a corpus file.
- **Already expected to fail:** the NaN fader, AbleSet NaN, and template channels out of range.

## #8 Timing checks

1. **Fix the flaky Intel Mac test first.** It measures the runner, not the code.
   - Split it into a deterministic test plus a real-thread smoke test.
   - Move real-thread tests to a serial step.
2. **Make two more speed asserts robust.** They have no tolerance (`metersrv.test.ts:195`, `emulator.test.ts:797`).
3. **Deterministic accounting tests:**
   - tick and jitter averages;
   - datagram counts per action;
   - ramp spacing;
   - the catch-up burst after a stall (problem 3).
4. **Wall-clock benchmarks** in `bench/`, judged against a share of the 21.3 ms block and a calibration workload.
   - A CI `perf` job that only reports at first, then gates against a baseline after about 20 runs.

## #9 Format versions

**`show.conf`:**
- Add `CONF_VERSION`.
- Add a table of known keys with did-you-mean suggestions, plus duplicate and malformed-line notes.
- Migrate in memory only; the user's file is never rewritten.

**Templates:**
- Add `"version"`.
- Add a version-by-version `migrateTemplate`.
- Report unknown keys as warnings. Today a typo like `leadTarget` is silently ignored.

## #10 Decision records

`docs/adr/`, with a template and these records:
- deterministic DSP;
- the console is the source of truth;
- platform-free core;
- emulator first;
- recorded fixtures as the oracle;
- job units sharing one state object;
- engine on the shared config, until #5 replaces it;
- tuning allowlist;
- the full test pins defaults;
- audio in a worker thread;
- single-file distribution;
- privacy scrubbing by default;
- dashboard security defaults.
