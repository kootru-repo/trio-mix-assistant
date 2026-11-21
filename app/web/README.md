# Dashboard TypeScript source

The browser code for the operator dashboard and the PIN login page is written in
TypeScript here and compiled into `../trio_mix/static/`:

| Source | Output | Loaded by |
| --- | --- | --- |
| `src/dashboard.ts` | `static/dashboard.js` | `static/index.html` |
| `src/login.ts` | `static/login.js` | `LOGIN_HTML` in `trio_mix/server.py` |
| `src/types.d.ts` | (types only) | describes `/state` and the control commands |

The compiled `.js` files are committed. Show machines run the Python app only and
never need Node.

## Rebuild after editing

```bash
cd app/web
npm ci          # first time only
npm run build   # type-check and write ../trio_mix/static/*.js
```

`npm run check` type-checks without writing output. Commit the regenerated `.js`
together with the `.ts` change.

## Keep in step with the server

`types.d.ts` mirrors `Engine._rebuild_telemetry()` (the `/state` snapshot) and
`Engine.command()` (the control messages) in `trio_mix/engine/` (`base.py` and `core.py`). When either
changes, update the matching type and rebuild; the compiler then flags every
place in the dashboard that needs attention.

Both pages are classic `<script>` files, not ES modules. Keep `import` and
`export` out of `src/`, or `tsc` emits module syntax the browser rejects.
`tests/test_server.py` checks for this.
