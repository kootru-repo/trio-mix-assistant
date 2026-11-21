import assert from "node:assert/strict";
import test from "node:test";
import { ManualClock } from "../src/core/clock.ts";
import { Engine } from "../src/core/engine/index.ts";
import type { VenueModel } from "../src/core/venue.ts";
import { fixture } from "./helpers.ts";

interface Fx {
  ops: any[];
  snapshots: { label: string; t: any }[];
  contexts: any[];
  events: any[];
  final: any;
}

const fx = fixture<Fx>("engine");

function sameValue(actual: unknown, expected: unknown, path: string): void {
  if (typeof expected === "number" && typeof actual === "number") {
    const tol = Math.max(1e-6, Math.abs(expected) * 1e-6);
    assert.ok(Math.abs(actual - expected) <= tol, `${path}: expected ${expected}, got ${actual}`);
  } else if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path}: expected an array, got ${JSON.stringify(actual)?.slice(0, 80)}`);
    assert.equal(actual.length, expected.length, `${path}: length`);
    expected.forEach((e, i) => sameValue(actual[i], e, `${path}[${i}]`));
  } else if (expected !== null && typeof expected === "object") {
    assert.ok(actual !== null && typeof actual === "object", `${path}: expected an object`);
    const a = actual as Record<string, unknown>;
    const e = expected as Record<string, unknown>;
    assert.deepEqual(Object.keys(a).sort(), Object.keys(e).sort(), `${path}: keys`);
    for (const k of Object.keys(e)) sameValue(a[k], e[k], `${path}.${k}`);
  } else {
    assert.equal(actual, expected, path);
  }
}

const json = (v: unknown): any => JSON.parse(JSON.stringify(v));

test("the engine, stepped on a manual clock, publishes the recorded telemetry", async () => {
  const clock = new ManualClock(100, 1_700_000_000);
  const e = new Engine({ clock, sim: true, tick: 0.05 });
  let last = clock.monotonic();
  const snapshots: { label: string; t: any }[] = [];
  const contexts: any[] = [];
  for (const op of fx.ops) {
    switch (op.op) {
      case "step":
        for (let i = 0; i < op.n; i++) {
          clock.advance(e.tick);
          const now = clock.monotonic();
          e.step(now, last);
          last = now;
        }
        break;
      case "cmd":
      case "raw":
        e.command(op.d);
        break;
      case "snapshot":
        snapshots.push({ label: op.label, t: json(e.snapshot()) });
        break;
      case "song":
        e.onSongChange(op.state);
        break;
      case "reconcile":
        e.reconcileFader(op.ch, op.db);
        break;
      case "meters":
        e.setConsoleMeters(new Array(op.n).fill(0));
        break;
      case "venue":
        e.applyVenueModel(op.model as VenueModel);
        break;
      case "await_calibration":
        await e.calibrationTask;
        break;
      case "advice":
        e.onAdvice(op.d);
        break;
      case "context":
        contexts.push(json(e.advisorContext()));
        break;
      default:
        throw new Error(op.op);
    }
  }
  assert.equal(snapshots.length, fx.snapshots.length);
  fx.snapshots.forEach((s, i) => {
    assert.equal(snapshots[i]!.label, s.label);
    sameValue(snapshots[i]!.t, s.t, `snapshot "${s.label}"`);
  });
  sameValue(contexts, fx.contexts, "advisor context");
  sameValue(json(e.events), fx.events, "events");
  assert.equal(e.status, fx.final.status);
  assert.equal(e.calibStatus, fx.final.calib_status);
  assert.equal(e.masterDb, fx.final.master_db);
  assert.deepEqual(Object.fromEntries([...e.muted].map(([k, v]) => [String(k), v])), fx.final.muted);
});

test("the recorded show covers the interesting paths", () => {
  const kinds = new Set(fx.events.map((x) => x.kind));
  for (const k of ["feedback", "clip", "vocal", "balance", "unmask", "calibration", "coach", "panic", "show", "manual", "advisor"]) {
    assert.ok(kinds.has(k), `no ${k} events`);
  }
});
