# Decision records

These records say why the code is the way it is. Each one is short: the context, the decision, and what follows from it. They describe decisions that are already in the code, as of commit `289f7cc` (v0.2.9). Paths that start with `src/`, `test/`, `tools/`, `fixtures/` or `tsconfig` are in `app/ts`. Other paths start at the repository root.

| No. | Decision | Status |
|---|---|---|
| [0001](0001-deterministic-dsp.md) | Deterministic DSP | Accepted |
| [0002](0002-console-is-source-of-truth.md) | The console is the source of truth | Accepted |
| [0003](0003-platform-free-core.md) | Platform-free core | Accepted |
| [0004](0004-emulator-first.md) | Emulator first | Accepted |
| [0005](0005-recorded-fixtures-as-oracle.md) | Recorded fixtures as the oracle | Accepted |
| [0006](0006-job-units-share-one-state.md) | Job units sharing one state object | Accepted |
| [0007](0007-engine-on-shared-config.md) | Engine on the shared config, until plan item #5 replaces it | Accepted, to be superseded by #5 |
| [0008](0008-tuning-allowlist.md) | Tuning allowlist | Accepted |
| [0009](0009-full-test-pins-defaults.md) | The full test pins defaults | Accepted |
| [0010](0010-audio-in-a-worker-thread.md) | Audio in a worker thread | Accepted |
| [0011](0011-single-file-distribution.md) | Single-file distribution | Accepted |
| [0012](0012-privacy-scrubbing-by-default.md) | Privacy scrubbing by default | Accepted |
| [0013](0013-dashboard-security-defaults.md) | Dashboard security defaults | Accepted |
| [0014](0014-safety-model-hold.md) | Safety model: HOLD, read-back, link watch, write budget, hand moves win | Accepted |
| [0015](0015-ci-gate-and-releases.md) | CI gate and CI-built releases | Accepted |
| [0016](0016-lint-biome-and-guard.md) | Lint: Biome plus a project-rules guard | Accepted |

## How to add one

1. Copy [0000-template.md](0000-template.md) to the next free number, for example `0017-short-title.md`.
2. Fill in Context, Decision and Consequences. Use plain, short sentences. Point to the files that carry the decision.
3. Set the status. A new record starts as Proposed and becomes Accepted when the code does what it says.
4. Add a row to the table above.
5. Never rewrite an accepted record to reverse it. Write a new record, set the old one to "Superseded by NNNN", and link the two.
