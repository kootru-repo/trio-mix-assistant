# 0016. Lint: Biome plus a project-rules guard

- Status: Accepted
- Date: 2026-11-26

## Context

The project has rules that were enforced only by review: no `any` in app code, no comments, no casts through `unknown`, no suppressed errors, no skipped tests, and no Effect library. typescript-eslint does not support the project's TypeScript 7.

## Decision

`npm run lint` runs `tools/guard.ts`, which runs two checks.

- **Biome** 2.6.7, a dev dependency, configured in `app/biome.json`. Only chosen rules are on, all of which the code already passed: no explicit `any` (allowed in tests), no ts-ignore, no focused or skipped tests, no debugger, no `==`, no `var`, `const` where possible, no unused imports or variables, no duplicate keys, no switch fall-through, and no `effect` imports. The formatter is off.
- **The guard** scans tracked sources in `app/ts/src`, `app/ts/test`, `app/ts/tools` and `app/web/src` line by line. It reports comment lines, `as unknown as`, TypeScript and lint suppressions, and skipped or focused tests. It also reports any Effect package in `app/ts/package.json` or `app/web/package.json`.

The `lint` job in CI runs it, and `ci-ok` needs it (0015).

## Consequences

- The rules are checked by machine on every push.
- Lint cannot be silenced in the code, because suppression comments are themselves banned.
- Formatting is not enforced. Turning a formatter on would change about 3,300 lines in 77 files. That is a separate decision.
