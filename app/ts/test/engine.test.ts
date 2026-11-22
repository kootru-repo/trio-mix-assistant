import assert from "node:assert/strict";
import test from "node:test";
import { ManualClock } from "../src/core/clock.ts";
import { Engine } from "../src/core/engine/index.ts";
import { CaptureSourceBase, SimCapture } from "../src/core/capture.ts";
import type { CaptureStatus } from "../src/core/capture.ts";
import type { Frame } from "../src/core/capture.ts";
import { applyChannelMap, channelMapState, restoreChannelMapState } from "../src/core/config.ts";
import { OscConsole, SimConsole } from "../src/core/console.ts";
import { fromObject, TemplateError } from "../src/core/template.ts";
import { asBool, intOf, numOf } from "../src/core/util.ts";
import type { VenueModel } from "../src/core/venue.ts";
import { fixture } from "./helpers.ts";
import { StepClock } from "./stepclock.ts";

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

class ScriptedSource extends CaptureSourceBase {
  private readonly frames: () => Frame;
  private readonly pink: () => Promise<boolean>;

  constructor(frames: () => Frame, pink: () => Promise<boolean> = () => Promise.resolve(true)) {
    super();
    this.frames = frames;
    this.pink = pink;
  }

  block(): Frame {
    return this.frames();
  }

  override emitPinkNoise(): Promise<boolean> {
    return this.pink();
  }
}

const tone = (amp: number): Float32Array => Float32Array.from({ length: 1024 }, (_v, i) => amp * Math.sin(i * 0.3));

test("a rejected calibration returns the engine to live instead of leaving it calibrating", async () => {
  const clock = new ManualClock(100, 1_700_000_000);
  const e = new Engine({
    clock,
    source: new ScriptedSource(
      () => new Map(),
      () => Promise.reject(new Error("device vanished")),
    ),
  });
  e.runCalibration();
  assert.equal(e.status, "calibrating");
  await e.calibrationTask;
  assert.equal(e.status, "live");
  assert.equal(e.calibStatus, "none");
  assert.ok(e.events.some((ev) => ev.msg === "calibration failed: device vanished"));
  assert.equal((e.snapshot()["calibration"] as { status: string }).status, "none");
});

test("one bad channel in a frame cannot abort analysis of the others", () => {
  const clock = new ManualClock(100, 1_700_000_000);
  const broken = new Proxy(new Float32Array(1024), {
    get(target, prop) {
      if (prop === "length") return 1024;
      if (typeof prop === "string" && /^\d+$/.test(prop)) throw new Error("bad channel");
      return Reflect.get(target, prop) as unknown;
    },
  });
  const frame: Frame = new Map([
    [2, broken],
    [3, tone(0.1)],
  ]);
  const e = new Engine({ clock, source: new ScriptedSource(() => frame) });
  e.step(clock.monotonic(), clock.monotonic() - 0.05);
  assert.ok(e.events.some((ev) => ev.msg.includes("engine error")));
  assert.notEqual(e.assistant.fbLastLevel.get(3), -90);
});

test("channels outside the map are skipped", () => {
  const clock = new ManualClock(100, 1_700_000_000);
  const frame: Frame = new Map([
    [99, tone(0.1)],
    [3, tone(0.1)],
  ]);
  const e = new Engine({ clock, source: new ScriptedSource(() => frame) });
  e.step(clock.monotonic(), clock.monotonic() - 0.05);
  assert.equal(
    e.events.some((ev) => ev.msg.includes("engine error")),
    false,
  );
  assert.notEqual(e.assistant.fbLastLevel.get(3), -90);
});

test("a non-finite console fader reading is ignored and the lead target stays in range", () => {
  const e = new Engine({ clock: new ManualClock(100, 1_700_000_000) });
  e.reconcileFader(1, Number.NaN);
  e.reconcileFader(1, Infinity);
  assert.equal(e.assistant.faderDb.get(1), 0);
  e.setLeadTarget(500);
  assert.equal(e.assistant.leadTarget, 10);
  e.setLeadTarget(-500);
  assert.equal(e.assistant.leadTarget, -40);
});

test("a toggle during takeover is held in the backup and applies on release", () => {
  const e = new Engine({ clock: new ManualClock(100, 1_700_000_000) });
  e.panic(true);
  e.setEnabled("vocal_ride", true);
  e.setEnabled("feedback", false);
  assert.equal(e.assistant.enabled["vocal_ride"], false);
  assert.ok(e.events.some((ev) => ev.msg === "vocal_ride will enable when takeover is released"));
  e.panic(false);
  assert.equal(e.assistant.enabled["vocal_ride"], true);
  assert.equal(e.assistant.enabled["feedback"], false);
});

test("coach mode guest mutes are advice only and do not mark the channel muted", () => {
  const saved = channelMapState();
  const template = fromObject({ songs: [{ name: "A" }, { name: "B", guest: true }] });
  try {
    applyChannelMap({ map: { "1": "lead_vox", "6": "guest_mic", "8": "meas_mic" }, guest: [6] });
    const clock = new ManualClock(100, 1_700_000_000);
    const e = new Engine({ clock, template });
    e.setCoachMode(true);
    e.onSongChange({ songIndex: 0, songName: "A", nextSong: "B", section: "", bpm: null, playing: true });
    assert.equal(e.muted.get(6), false);
    assert.equal((e.con as SimConsole).chMuted.size, 0);
    e.setCoachMode(false);
    e.onSongChange({ songIndex: 1, songName: "B", nextSong: "A", section: "", bpm: null, playing: true });
    e.onSongChange({ songIndex: 0, songName: "A", nextSong: "B", section: "", bpm: null, playing: true });
    assert.equal((e.con as SimConsole).chMuted.get(6), true);
    assert.equal(e.muted.get(6), true);
  } finally {
    restoreChannelMapState(saved);
  }
});

test("manual scene recall accepts only whole scenes 0-99 and records success only", () => {
  const clock = new ManualClock(100, 1_700_000_000);
  const e = new Engine({ clock });
  const con = e.con as SimConsole;
  for (const bad of [100, -1, 1.5, "abc", true, null, 1e9]) e.recallSceneManual(bad);
  assert.equal(con.lastScene, null);
  assert.equal(e.show.scene, null);
  e.recallSceneManual("12");
  assert.equal(con.lastScene, 12);
  assert.equal(e.show.scene, 12);

  class Dead extends SimConsole {
    override recallScene(): void {
      throw new Error("socket closed");
    }
  }
  const f = new Engine({ clock, console: new Dead() });
  f.recallSceneManual(5);
  assert.equal(f.show.scene, null);
  assert.ok(f.events.some((ev) => ev.msg.includes("recall failed")));
});

test("command values must be real booleans and numbers, not lookalikes", () => {
  const e = new Engine({ clock: new ManualClock(100, 1_700_000_000) });
  e.command({ type: "toggle", job: "vocal_ride", on: true });
  assert.equal(e.assistant.enabled["vocal_ride"], true);
  e.command({ type: "toggle", job: "vocal_ride", on: "off" });
  assert.equal(e.assistant.enabled["vocal_ride"], false);
  e.command({ type: "toggle", job: "vocal_ride", on: "maybe" });
  e.command({ type: "toggle", job: "vocal_ride", on: [1] });
  e.command({ type: "toggle", job: "vocal_ride", on: {} });
  assert.equal(e.assistant.enabled["vocal_ride"], false);
  e.command({ type: "fader", ch: 1, db: true });
  e.command({ type: "fader", ch: 1, db: "Infinity" });
  e.command({ type: "fader", ch: 1, db: "nan" });
  e.command({ type: "fader", ch: true, db: -3 });
  e.command({ type: "fader", ch: 1.5, db: -3 });
  assert.equal(e.assistant.faderDb.get(1), 0);
  e.command({ type: "fader", ch: "1", db: "-3.5" });
  assert.equal(e.assistant.faderDb.get(1), -3.5);
  assert.throws(() => asBool("2"), TypeError);
  assert.throws(() => asBool(null), TypeError);
  assert.equal(asBool(" YES "), true);
  assert.equal(asBool(0), false);
  assert.throws(() => numOf(false), TypeError);
  assert.throws(() => intOf("1.5"), TypeError);
  assert.equal(intOf(" +7 "), 7);
});

test("an EQ command with one bad field changes neither the engine nor the console", () => {
  const e = new Engine({ clock: new ManualClock(100, 1_700_000_000) });
  const con = e.con as SimConsole;
  e.command({ type: "eq", ch: 1, band: 1, hz: 1000, gain: "loud", on: true });
  e.command({ type: "eq", ch: 1, band: 1, hz: 1000, gain: 3, on: "perhaps" });
  const bands = e.snapshot()["eq"] as Record<string, { band: number; hz: number; gain: number; on: boolean }[]>;
  const b = bands["1"]![0]!;
  assert.deepEqual({ hz: b.hz, gain: b.gain, on: b.on }, { hz: 120, gain: 0, on: false });
  assert.equal(con.wireLog.length, 0);
  e.command({ type: "eq", ch: 1, band: 1, hz: 1000, gain: 3, on: true });
  assert.equal(con.eqBands.get(1)!.get(1)!.hz, 1000);
});

test("templates take a real boolean for guest and integer-only channel numbers", () => {
  assert.equal(fromObject({ songs: [{ name: "A", guest: true }] }).songs[0]!.guest, true);
  assert.equal(fromObject({ songs: [{ name: "A" }] }).songs[0]!.guest, false);
  for (const bad of ["yes", 1, 0, [], {}]) {
    assert.throws(() => fromObject({ songs: [{ name: "A", guest: bad }] }), TemplateError);
  }
  assert.throws(() => fromObject({ channels: { map: { "1": "a" }, guest: [true] } }), TemplateError);
});

test("channel specs are validated even without a channel map", () => {
  const bad: unknown[] = [
    { phase_pairs: "x" },
    { phase_pairs: [[1]] },
    { phase_pairs: [[1, "a"]] },
    { phase_pairs: [[1, 2.5]] },
    { labels: { lead: 5 } },
    { labels: [] },
    { balance: [1, "z"] },
    { guest: [{}] },
    { stereo_links: [[1, null]] },
  ];
  for (const channels of bad) assert.throws(() => fromObject({ channels }), TemplateError, JSON.stringify(channels));
  const ok = fromObject({ channels: { phase_pairs: [[1, 2]], labels: { lead: "Lead" }, balance: [1, 2], guest: [3], stereo_links: [[4, 5]] } });
  assert.deepEqual(ok.channels?.phase_pairs, [[1, 2]]);
});

test("a takeover that starts and ends during calibration stops the worker before it writes any EQ", async () => {
  const clock = new ManualClock(100, 1_700_000_000);
  const con = new SimConsole();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  class Gated extends SimCapture {
    override async emitPinkNoise(): Promise<boolean> {
      await gate;
      return true;
    }
  }
  const e = new Engine({ clock, console: con, source: new Gated(con) });
  e.runCalibration();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  e.panic(true);
  e.panic(false);
  release();
  await e.calibrationTask;
  assert.equal(e.calib, null);
  assert.equal(e.calibStatus, "none");
  assert.equal(e.status, "live");
  assert.equal(con.notches.size, 0);
  assert.equal(con.busEq.size, 0);
  assert.ok(e.events.some((ev) => ev.msg.includes("calibration aborted")));
});

test("restarting the engine does not run two step loops", async () => {
  const clock = new StepClock(100, 1_700_000_000);
  let steps = 0;
  class Counting extends Engine {
    override step(now: number, lastNow: number): void {
      steps += 1;
      super.step(now, lastNow);
    }
  }
  const e = new Counting({ clock, tick: 0.05 });
  await e.start();
  await e.stop();
  await e.start();
  steps = 0;
  await clock.advance(0.5);
  await e.stop();
  assert.ok(steps >= 9 && steps <= 12, String(steps));
  steps = 0;
  await clock.advance(1.0);
  assert.equal(steps, 0);
});

test("only a malformed command is dropped quietly; any other failure is reported", () => {
  class Boom extends SimConsole {
    override setMainFader(): number {
      throw new Error("console exploded");
    }
  }
  const e = new Engine({ clock: new ManualClock(100, 1_700_000_000), console: new Boom() });
  e.command({ type: "master", db: "loud" });
  e.command({ type: "master" });
  assert.equal(e.events.some((ev) => ev.msg.includes("engine error")), false);
  e.command({ type: "master", db: -3 });
  assert.ok(e.events.some((ev) => ev.msg.includes("engine error") && ev.msg.includes("console exploded")));
});

test("toggling a name from the prototype chain does nothing", () => {
  const e = new Engine({ clock: new ManualClock(100, 1_700_000_000) });
  const before = JSON.stringify(e.assistant.enabled);
  e.command({ type: "toggle", job: "toString", on: true });
  e.command({ type: "toggle", job: "constructor", on: true });
  e.command({ type: "toggle", job: "__proto__", on: true });
  assert.equal(JSON.stringify(e.assistant.enabled), before);
  assert.equal(Object.hasOwn(e.assistant.enabled, "toString"), false);
  assert.equal(e.events.length, 0);
});

class DeadSource extends CaptureSourceBase {
  reason: string | null = "device gone";
  override block(): Frame {
    return new Map();
  }
  override dead(): boolean {
    return true;
  }
  override restart(): Promise<boolean> {
    return Promise.resolve(false);
  }
  override status(): CaptureStatus {
    return { kind: "audio", dead: true, lastError: this.reason };
  }
}

test("a capture that cannot restart is reported once per distinct reason", () => {
  const clock = new ManualClock(100, 1_700_000_000);
  const src = new DeadSource();
  const e = new Engine({ clock, source: src });
  const count = (): number => e.events.filter((ev) => ev.msg.startsWith("audio capture could not restart")).length;
  for (let i = 0; i < 4; i++) {
    clock.advance(Engine.AUDIO_RESTART_S + 0.1);
    e.step(clock.monotonic(), clock.monotonic() - 0.05);
  }
  return Promise.resolve().then(() => {
    assert.equal(count(), 1);
    assert.ok(e.events.some((ev) => ev.msg === "audio capture could not restart: device gone"));
    src.reason = "device busy";
    clock.advance(Engine.AUDIO_RESTART_S + 0.1);
    e.step(clock.monotonic(), clock.monotonic() - 0.05);
    return Promise.resolve().then(() => {
      assert.equal(count(), 2);
    });
  });
});

test("a failed console ramp is reported once per distinct error", async () => {
  class Flaky extends SimConsole {
    override rampFaderDb(ch: number, startDb: number, endDb: number, ms?: number, steps?: number): number {
      return ConsoleProto.rampFaderDb.call(this, ch, startDb, endDb, ms, steps) as number;
    }
    protected override send(): void {
      throw new Error("socket closed");
    }
  }
  const ConsoleProto = Object.getPrototypeOf(SimConsole.prototype) as { rampFaderDb: (...a: unknown[]) => number };
  const con = new Flaky({ clock: new ManualClock() });
  const e = new Engine({ clock: new ManualClock(100, 1_700_000_000), console: con });
  for (let i = 0; i < 3; i++) {
    con.rampFaderDb(1, -10, -4, 100, 3);
    await con.flushRamps();
  }
  assert.equal(e.events.filter((ev) => ev.msg === "console ramp failed: socket closed").length, 1);
});

test("telemetry carries the console send failure count for a real console", () => {
  const sink = { failures: 3, send: () => undefined, close: () => undefined };
  const e = new Engine({ clock: new ManualClock(100, 1_700_000_000), console: new OscConsole(sink), source: null });
  assert.equal((e.snapshot()["console"] as Record<string, unknown>)["send_failures"], 3);
  const sim = new Engine({ clock: new ManualClock(100, 1_700_000_000) });
  assert.equal("send_failures" in (sim.snapshot()["console"] as Record<string, unknown>), false);
});

test("skipped frames and native xruns raise different alerts", () => {
  const status: { value: CaptureStatus } = { value: { kind: "audio", skipping: true } };
  class Fixed extends CaptureSourceBase {
    override block(): Frame {
      return new Map();
    }
    override status(): CaptureStatus {
      return status.value;
    }
  }
  const e = new Engine({ clock: new ManualClock(100, 1_700_000_000), source: new Fixed() });
  const msgs = (): string[] => (e.snapshot()["alerts"] as { msg: string }[]).map((a) => a.msg);
  e.step(100, 99.95);
  assert.deepEqual(msgs(), ["audio frames are arriving faster than the engine reads them"]);
  status.value = { kind: "audio", overload: true };
  e.step(100.05, 100);
  assert.match(msgs()[0]!, /xruns/);
});
