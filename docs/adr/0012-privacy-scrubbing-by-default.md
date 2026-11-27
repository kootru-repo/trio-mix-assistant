# 0012. Privacy scrubbing by default

- Status: Accepted
- Date: 2026-11-26

## Context

Users paste "Run checks" and "Run full test" reports into issues to get help. These reports can hold device names, addresses, computer and user names, and venue names.

## Decision

Reports hide identifying details unless the user asks to keep them.

- `redact` (`src/core/diagnostics.ts`) replaces the home folder path with `~`. `src/host/diagnose.ts` supplies the home folder.
- `makeScrubber` (`src/core/diagnostics.ts`) hides audio device names, listed words, IPv4 addresses (except 127.0.0.1), MAC addresses and the console's name in `/xinfo` replies.
- `scrubberFor` (`src/host/vet.ts`) builds the word list: the host name, the user name, and `VENUE` and `TEMPLATE` from `show.conf`.
- Settings whose names look secret (PIN, PASS, SECRET, TOKEN, KEY) are shown only as "(set)" or "(empty)".
- `--vet-keep-names`, or the `identify` option of the in-app report, turns scrubbing off.

## Consequences

- In most cases a report can be shared as it is.
- The scrubber works from a list. It is not a guarantee. A private word in another place is not caught, and IPv6 addresses are not hidden. The README tells users to read a report before posting it.
- Nothing is uploaded. A report leaves the machine only when the user sends it.
